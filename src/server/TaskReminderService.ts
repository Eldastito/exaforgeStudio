/**
 * Lembrete de tarefa por WhatsApp (PRD Moda/TOULON, TASK-007; ADR-172).
 *
 * A notificação IN-APP é o padrão (já sai no TaskService.create). O WhatsApp é
 * OPT-IN por regra (notification_policy_json.whatsapp) e passa por guardas:
 *   - número do responsável presente (`users.phone`); sem número → só in-app;
 *   - janela de silêncio (UxPreferencesService.isAwake — hora de São Paulo);
 *   - limite diário por responsável (anti-spam);
 *   - DEDUPE por (org, tarefa, canal, tipo) — nunca manda o mesmo 2x;
 *   - falha NÃO cancela a tarefa: vira `failed` no log e é RE-TENTADA nos passes
 *     seguintes até 3 tentativas (depois vira DLQ, para de tentar).
 *
 * O ENVIO é injetado (`send`), como em RetailTaskService.runReminders — isso
 * mantém o serviço testável offline e desacoplado do canal. Isolado por org.
 */
import { randomUUID } from "node:crypto";
import db from "./db.js";
import { UxPreferencesService } from "./UxPreferencesService.js";

const MAX_ATTEMPTS = 3;
const MAX_PER_ASSIGNEE_PER_DAY = 20;

export type ReminderSend = (toDigits: string, message: string) => Promise<any>;

/** Hora atual (0..23) na timezone informada (default São Paulo). */
function hourInTz(now: Date, timeZone = "America/Sao_Paulo"): number {
  const s = new Intl.DateTimeFormat("en-US", { timeZone, hour: "2-digit", hour12: false }).format(now);
  const h = parseInt(s, 10);
  return h === 24 ? 0 : h;
}

export class TaskReminderService {
  /** Tarefas recorrentes recentes ainda SEM lembrete WhatsApp enviado. */
  static pendingCandidates(orgId: string): any[] {
    const rows = db.prepare(`
      SELECT t.id, t.assigned_to, t.title, t.due_at, r.notification_policy_json, r.timezone, u.phone
        FROM tasks t
        JOIN task_recurrence_rules r ON r.id = t.recurrence_rule_id
        LEFT JOIN users u ON u.id = t.assigned_to AND u.organization_id = t.organization_id
       WHERE t.organization_id = ? AND t.source = 'recurrence' AND t.recurrence_rule_id IS NOT NULL
         AND t.created_at >= datetime('now', '-2 days')
         AND NOT EXISTS (
           SELECT 1 FROM task_reminder_log l
            WHERE l.organization_id = t.organization_id AND l.task_id = t.id
              AND l.channel = 'whatsapp' AND l.reminder_type = 'materialized' AND l.status = 'sent')
    `).all(orgId) as any[];
    return rows.filter((r) => {
      let pol: any = {}; try { pol = JSON.parse(r.notification_policy_json || "{}"); } catch { pol = {}; }
      return pol.whatsapp === true && String(r.phone || "").replace(/\D/g, "").length >= 8;
    });
  }

  private static logRow(orgId: string, taskId: string): any {
    return db.prepare(`SELECT * FROM task_reminder_log WHERE organization_id = ? AND task_id = ? AND channel = 'whatsapp' AND reminder_type = 'materialized'`).get(orgId, taskId);
  }
  private static sentToday(orgId: string, assignedTo: string): number {
    if (!assignedTo) return 0;
    return Number((db.prepare(`SELECT COUNT(*) c FROM task_reminder_log WHERE organization_id = ? AND assigned_to = ? AND channel='whatsapp' AND status='sent' AND created_at >= datetime('now','-1 day')`).get(orgId, assignedTo) as any)?.c || 0);
  }
  private static upsert(orgId: string, task: any, status: string, attempts: number, detail: string): void {
    const existing = this.logRow(orgId, task.id);
    if (existing) {
      db.prepare(`UPDATE task_reminder_log SET status = ?, attempts = ?, detail = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(status, attempts, detail, existing.id);
    } else {
      db.prepare(`INSERT INTO task_reminder_log (id, organization_id, task_id, assigned_to, channel, reminder_type, status, attempts, detail) VALUES (?, ?, ?, ?, 'whatsapp', 'materialized', ?, ?, ?)`)
        .run(randomUUID(), orgId, task.id, task.assigned_to || null, status, attempts, detail);
    }
  }

  private static message(task: any): string {
    let when = "";
    if (task.due_at) { try { when = ` (${new Date(String(task.due_at).includes("T") ? task.due_at : task.due_at + "Z").toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" })})`; } catch { /* noop */ } }
    return `🔁 Lembrete de tarefa: *${task.title}*${when}. Abra o ZappFlow para concluir.`;
  }

  /**
   * Envia (best-effort) o lembrete de UMA tarefa. `send` é injetado. Respeita
   * quiet-hours, limite diário, dedupe e DLQ. Retorna o desfecho.
   */
  static async remindTask(orgId: string, task: any, send: ReminderSend, opts: { hourSP?: number } = {}): Promise<{ status: "sent" | "skipped" | "failed"; reason?: string }> {
    const phone = String(task.phone || "").replace(/\D/g, "");
    if (phone.length < 8) return { status: "skipped", reason: "no_phone" };

    const existing = this.logRow(orgId, task.id);
    if (existing?.status === "sent") return { status: "skipped", reason: "already_sent" };
    if (existing?.status === "failed" && Number(existing.attempts) >= MAX_ATTEMPTS) return { status: "skipped", reason: "dlq" };

    // Janela de silêncio (não cria log — re-tenta num passe acordado).
    const hourSP = opts.hourSP ?? hourInTz(new Date(), task.timezone || "America/Sao_Paulo");
    if (!UxPreferencesService.isAwake(orgId, hourSP)) return { status: "skipped", reason: "quiet_hours" };

    // Limite diário por responsável (anti-spam).
    if (this.sentToday(orgId, task.assigned_to) >= MAX_PER_ASSIGNEE_PER_DAY) return { status: "skipped", reason: "daily_cap" };

    const attempts = (Number(existing?.attempts) || 0) + 1;
    try {
      await send(phone, this.message(task));
      this.upsert(orgId, task, "sent", attempts, "ok");
      return { status: "sent" };
    } catch (e: any) {
      this.upsert(orgId, task, "failed", attempts, String(e?.message || "send_failed").slice(0, 200));
      return { status: "failed", reason: "send_error" };
    }
  }

  /** Processa todos os candidatos de UMA org com um `send` injetado. */
  static async remindForOrg(orgId: string, send: ReminderSend, opts: { hourSP?: number } = {}): Promise<{ sent: number; skipped: number; failed: number }> {
    const out = { sent: 0, skipped: 0, failed: 0 };
    for (const task of this.pendingCandidates(orgId)) {
      const r = await this.remindTask(orgId, task, send, opts);
      out[r.status]++;
    }
    return out;
  }

  /**
   * Passe do Scheduler: para cada org com candidatos, resolve o canal ativo e
   * envia via MessageProviderService. Best-effort; nunca derruba o tick.
   */
  static async runPass(now: Date = new Date()): Promise<number> {
    let orgs: any[] = [];
    try { orgs = db.prepare(`SELECT DISTINCT organization_id FROM task_recurrence_rules WHERE status IN ('active','paused')`).all() as any[]; } catch { return 0; }
    let total = 0;
    const { MessageProviderService } = await import("./MessageProviderService.js");
    for (const o of orgs) {
      const orgId = o.organization_id;
      try {
        if (!this.pendingCandidates(orgId).length) continue;
        const channel = db.prepare(`SELECT id FROM channels WHERE organization_id = ? AND status != 'disabled' ORDER BY (provider LIKE 'evolution%') DESC, created_at ASC LIMIT 1`).get(orgId) as any;
        if (!channel) continue; // sem canal WhatsApp → só in-app
        const res = await this.remindForOrg(orgId, (to, msg) => MessageProviderService.sendMessage(channel.id, to, msg), { hourSP: hourInTz(now) });
        total += res.sent;
      } catch (e) { console.error("[TaskReminder] org falhou", orgId, e); }
    }
    return total;
  }
}
