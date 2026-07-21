/**
 * Retail Ops — Cotas, fechamentos e checklist diário (ADR-083, Fase B).
 *
 * A espinha operacional: cotas por loja/dia, o registro de fechamento diário
 * (preenchido pela IA/WhatsApp na Fase C) com cálculo de desvio vs cota, e o
 * checklist de pendências (fechamento/malote/escala) que o Scheduler gera por
 * loja. Camada aditiva, isolada por organização. Auditado via logAuthEvent.
 */
import { randomUUID } from "node:crypto";
import db from "./db.js";
import { logAuthEvent } from "./auditLog.js";

// ── Cotas ────────────────────────────────────────────────────────────────────
export class RetailQuotaService {
  /** Define (upsert) a cota de uma loja num dia. */
  static set(orgId: string, input: { storeId: string; quotaDate: string; quotaAmount: number; source?: string }, actorId?: string): any {
    const amount = Number(input.quotaAmount || 0);
    db.prepare(
      `INSERT INTO retail_store_quotas (id, organization_id, store_id, quota_date, quota_amount, source, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(organization_id, store_id, quota_date) DO UPDATE SET
         quota_amount = excluded.quota_amount, source = excluded.source`
    ).run(randomUUID(), orgId, input.storeId, input.quotaDate, amount, input.source || "manual", actorId || null);
    try { logAuthEvent(orgId, actorId || "system", input.storeId, "RETAIL_QUOTA_SET", { date: input.quotaDate, amount }); } catch { /* noop */ }
    return this.get(orgId, input.storeId, input.quotaDate);
  }

  static get(orgId: string, storeId: string, date: string): any | null {
    return (db.prepare(`SELECT * FROM retail_store_quotas WHERE organization_id = ? AND store_id = ? AND quota_date = ?`).get(orgId, storeId, date) as any) || null;
  }

  static listByDate(orgId: string, date: string): any[] {
    return db.prepare(
      `SELECT q.*, s.name AS store_name FROM retail_store_quotas q
         JOIN retail_stores s ON s.id = q.store_id
        WHERE q.organization_id = ? AND q.quota_date = ? ORDER BY s.name`
    ).all(orgId, date) as any[];
  }

  /** Importação em lote (CSV/planilha). Retorna quantas cotas foram gravadas. */
  static import(orgId: string, rows: Array<{ storeId: string; quotaDate: string; quotaAmount: number }>, actorId?: string): number {
    let n = 0;
    for (const r of Array.isArray(rows) ? rows : []) {
      if (!r?.storeId || !r?.quotaDate) continue;
      this.set(orgId, { ...r, source: "imported" }, actorId);
      n++;
    }
    try { logAuthEvent(orgId, actorId || "system", "quotas", "RETAIL_QUOTA_IMPORTED", { count: n }); } catch { /* noop */ }
    return n;
  }
}

// ── Fechamentos ──────────────────────────────────────────────────────────────
export class RetailClosingService {
  /** Cria (ou devolve) o fechamento 'pending' da loja no dia, com a cota snapshot. */
  static getOrCreate(orgId: string, storeId: string, date: string): any {
    const existing = db.prepare(`SELECT * FROM retail_daily_closings WHERE organization_id = ? AND store_id = ? AND closing_date = ?`).get(orgId, storeId, date) as any;
    if (existing) return existing;
    const quota = RetailQuotaService.get(orgId, storeId, date);
    const id = randomUUID();
    db.prepare(
      `INSERT INTO retail_daily_closings (id, organization_id, store_id, closing_date, status, quota_amount)
       VALUES (?, ?, ?, ?, 'pending', ?)`
    ).run(id, orgId, storeId, date, Number(quota?.quota_amount || 0));
    return this.get(orgId, id);
  }

  static get(orgId: string, id: string): any | null {
    const c = db.prepare(`SELECT * FROM retail_daily_closings WHERE organization_id = ? AND id = ?`).get(orgId, id) as any;
    if (!c) return null;
    c.items = db.prepare(`SELECT * FROM retail_daily_closing_items WHERE closing_id = ?`).all(id);
    return c;
  }

  static listByDate(orgId: string, date: string): any[] {
    return db.prepare(
      `SELECT c.*, s.name AS store_name FROM retail_daily_closings c
         JOIN retail_stores s ON s.id = c.store_id
        WHERE c.organization_id = ? AND c.closing_date = ? ORDER BY s.name`
    ).all(orgId, date) as any[];
  }

  /**
   * Registra o total INFORMADO (pela IA/WhatsApp na Fase C ou manual) e calcula
   * o desvio vs a cota. Não concilia com o sistema externo (Fase E). Grava itens
   * por forma de pagamento se vierem.
   */
  static setInformed(orgId: string, id: string, input: {
    informedTotal: number; items?: Array<{ paymentMethod: string; informedAmount: number }>;
    rawText?: string; imageUrl?: string; extractedJson?: any; source?: string;
    submittedByContactId?: string | null; submittedByIdentifier?: string | null;
  }, actorId?: string): any | null {
    const c = this.get(orgId, id);
    if (!c) return null;
    const informed = Number(input.informedTotal || 0);
    const quota = Number(c.quota_amount || 0);
    const variance = informed - quota;
    const variancePct = quota > 0 ? (variance / quota) * 100 : 0;
    db.prepare(
      `UPDATE retail_daily_closings SET
         status = 'received', source = COALESCE(?, source),
         submitted_by_contact_id = ?, submitted_by_identifier = ?, submitted_at = CURRENT_TIMESTAMP,
         raw_text = COALESCE(?, raw_text), image_url = COALESCE(?, image_url), extracted_json = COALESCE(?, extracted_json),
         informed_total = ?, variance_amount = ?, variance_percent = ?, updated_at = CURRENT_TIMESTAMP
       WHERE organization_id = ? AND id = ?`
    ).run(
      input.source || null, input.submittedByContactId || null, input.submittedByIdentifier || null,
      input.rawText || null, input.imageUrl || null, input.extractedJson ? JSON.stringify(input.extractedJson) : null,
      informed, variance, variancePct, orgId, id
    );
    if (Array.isArray(input.items)) {
      db.prepare(`DELETE FROM retail_daily_closing_items WHERE closing_id = ?`).run(id);
      for (const it of input.items) {
        db.prepare(`INSERT INTO retail_daily_closing_items (id, organization_id, closing_id, payment_method, informed_amount) VALUES (?, ?, ?, ?, ?)`)
          .run(randomUUID(), orgId, id, String(it.paymentMethod || "outros"), Number(it.informedAmount || 0));
      }
    }
    try { logAuthEvent(orgId, actorId || "system", id, "RETAIL_CLOSING_INFORMED", { informed, quota, variance }); } catch { /* noop */ }
    return this.get(orgId, id);
  }

  static setStatus(orgId: string, id: string, status: string, actorId?: string): any | null {
    const c = this.get(orgId, id);
    if (!c) return null;
    db.prepare(`UPDATE retail_daily_closings SET status = ?, reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE organization_id = ? AND id = ?`)
      .run(status, actorId || null, orgId, id);
    try { logAuthEvent(orgId, actorId || "system", id, `RETAIL_CLOSING_${status.toUpperCase()}`, {}); } catch { /* noop */ }
    return this.get(orgId, id);
  }

  /**
   * Fase C — lê a FOTO/documento da folha de fechamento com IA (OCR), preenche o
   * fechamento do dia da loja e calcula o desvio vs cota. NÃO aprova: baixa
   * confiança vira 'needs_review' para a conferência humana (a aprovação é
   * sempre humana, ADR-083 D4). Extrator injetável (teste offline).
   */
  static async submitFromImage(orgId: string, storeId: string, date: string, base64: string, mimetype: string, opts: {
    source?: string; imageUrl?: string | null; submittedByContactId?: string | null; submittedByIdentifier?: string | null;
  } = {}, actorId?: string): Promise<{ closing: any; extraction: any } | null> {
    if (!storeId) return null;
    const closing = this.getOrCreate(orgId, storeId, date);
    const extractor = _closingExtractor || (async (b: string, m: string) => (await import("./llm.js")).extractClosingFromImage(b, m));
    let parsed: any = {};
    try { parsed = JSON.parse((await extractor(base64, mimetype)) || "{}"); } catch { parsed = {}; }

    const methods = ["dinheiro", "pix", "credito", "debito", "voucher", "troca", "outros"];
    const items = methods.map((m) => ({ paymentMethod: m, informedAmount: Number(parsed?.[m] || 0) })).filter((i) => i.informedAmount > 0);
    const sumMethods = items.reduce((a, i) => a + i.informedAmount, 0);
    const informedTotal = Number(parsed?.total ?? 0) || sumMethods; // total escrito na folha; senão soma das formas
    const confidence = Number(parsed?.confidence ?? 0);

    this.setInformed(orgId, closing.id, {
      informedTotal, items, extractedJson: parsed, source: opts.source || "image_ocr",
      imageUrl: opts.imageUrl, submittedByContactId: opts.submittedByContactId, submittedByIdentifier: opts.submittedByIdentifier,
    }, actorId);

    // Baixa confiança OU total ausente → precisa de conferência humana.
    const minConf = Number(process.env.RETAIL_CLOSING_MIN_CONFIDENCE || 80);
    const status = (confidence >= minConf && informedTotal > 0) ? "extracted" : "needs_review";
    db.prepare(`UPDATE retail_daily_closings SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE organization_id = ? AND id = ?`).run(status, orgId, closing.id);
    try { logAuthEvent(orgId, actorId || "system", closing.id, "RETAIL_CLOSING_SCANNED", { informedTotal, confidence, status }); } catch { /* noop */ }

    return { closing: this.get(orgId, closing.id), extraction: { ...parsed, informedTotal, confidence, needsReview: status === "needs_review" } };
  }
}

/** Extrator de fechamento injetável (teste offline, sem provedor de visão). */
type ClosingExtractor = (base64: string, mimetype: string) => Promise<string>;
let _closingExtractor: ClosingExtractor | null = null;
export function __setClosingExtractorForTests(fn: ClosingExtractor | null): void { _closingExtractor = fn; }

// ── Checklist diário (fechamento/malote/escala) ──────────────────────────────
const TASK_FLAG: Record<string, string> = {
  fechamento: "retail_daily_closing_enabled",
  malote: "retail_malote_enabled",
  escala: "retail_scale_reminder_enabled",
};

export class RetailTaskService {
  /**
   * Gera as pendências do dia por loja ativa, respeitando as flags de automação.
   * Idempotente (UNIQUE por org/loja/dia/tipo → INSERT OR IGNORE). Retorna quantas
   * foram criadas. Chamado pelo Scheduler (e sob demanda pela API).
   */
  static generateDay(orgId: string, date: string): number {
    let settings: any = {};
    try { settings = db.prepare(`SELECT retail_daily_closing_enabled, retail_malote_enabled, retail_scale_reminder_enabled, retail_daily_closing_due_hour FROM organization_settings WHERE organization_id = ?`).get(orgId) || {}; } catch { settings = {}; }
    const dueHour = Number(settings.retail_daily_closing_due_hour ?? 21);
    const types = (Object.keys(TASK_FLAG) as string[]).filter((t) => Number(settings[TASK_FLAG[t]] ?? 0) === 1);
    if (!types.length) return 0;
    const stores = db.prepare(`SELECT id FROM retail_stores WHERE organization_id = ? AND active = 1`).all(orgId) as any[];
    let n = 0;
    for (const s of stores) {
      for (const t of types) {
        const r = db.prepare(
          `INSERT OR IGNORE INTO retail_store_daily_tasks (id, organization_id, store_id, task_date, task_type, status, due_at)
           VALUES (?, ?, ?, ?, ?, 'pending', ?)`
        ).run(randomUUID(), orgId, s.id, date, t, `${date} ${String(dueHour).padStart(2, "0")}:00:00`);
        if (r.changes > 0) n++;
      }
    }
    return n;
  }

  static listByDate(orgId: string, date: string): any[] {
    return db.prepare(
      `SELECT t.*, s.name AS store_name FROM retail_store_daily_tasks t
         JOIN retail_stores s ON s.id = t.store_id
        WHERE t.organization_id = ? AND t.task_date = ? ORDER BY s.name, t.task_type`
    ).all(orgId, date) as any[];
  }

  static markSubmitted(orgId: string, id: string, input: { contactId?: string | null; attachmentUrl?: string | null } = {}, actorId?: string): any | null {
    const t = db.prepare(`SELECT * FROM retail_store_daily_tasks WHERE organization_id = ? AND id = ?`).get(orgId, id) as any;
    if (!t) return null;
    db.prepare(
      `UPDATE retail_store_daily_tasks SET status = 'submitted', submitted_at = CURRENT_TIMESTAMP,
         submitted_by_contact_id = COALESCE(?, submitted_by_contact_id), attachment_url = COALESCE(?, attachment_url), updated_at = CURRENT_TIMESTAMP
       WHERE organization_id = ? AND id = ?`
    ).run(input.contactId || null, input.attachmentUrl || null, orgId, id);
    try { logAuthEvent(orgId, actorId || "system", id, "RETAIL_TASK_SUBMITTED", { type: t.task_type }); } catch { /* noop */ }
    return db.prepare(`SELECT * FROM retail_store_daily_tasks WHERE id = ?`).get(id);
  }

  /**
   * COBRANÇA (Fase D) — para as pendências VENCIDAS (due_at <= now) e ainda
   * 'pending', cobra o responsável da loja pelo WhatsApp e reagenda: respeita o
   * intervalo de recobrança e, após o teto de tentativas, ESCALA ao gestor e
   * marca 'late'. `send`/`notify`/`now` são injetáveis (teste offline; o
   * Scheduler passa o provedor real). Retorna o resumo.
   */
  static async runReminders(orgId: string, opts: {
    send: (target: string, message: string) => Promise<any>;
    notify?: (info: { store: any; task: any }) => void;
    now: string;                 // 'YYYY-MM-DD HH:MM:SS'
    retryMinutes?: number; maxReminders?: number;
  }): Promise<{ reminded: number; escalated: number }> {
    const summary = { reminded: 0, escalated: 0 };
    const nowMs = parseSqlTs(opts.now);
    let settings: any = {};
    try { settings = db.prepare(`SELECT retail_daily_closing_retry_minutes FROM organization_settings WHERE organization_id = ?`).get(orgId) || {}; } catch { settings = {}; }
    const retryMin = Number(opts.retryMinutes ?? settings.retail_daily_closing_retry_minutes ?? 30);
    const MAX = Number(opts.maxReminders ?? process.env.RETAIL_MAX_REMINDERS ?? 3);

    const due = db.prepare(
      `SELECT * FROM retail_store_daily_tasks WHERE organization_id = ? AND status = 'pending' AND due_at <= ? ORDER BY due_at ASC`
    ).all(orgId, opts.now) as any[];

    for (const t of due) {
      // Ainda dentro do intervalo desde a última cobrança? não repete.
      if (t.last_reminder_at && nowMs - parseSqlTs(t.last_reminder_at) < retryMin * 60_000) continue;
      const store = db.prepare(`SELECT * FROM retail_stores WHERE organization_id = ? AND id = ?`).get(orgId, t.store_id) as any;
      if (!store) continue;

      // Teto de tentativas atingido → escala ao gestor uma vez e marca 'late'.
      if (Number(t.reminder_count || 0) >= MAX) {
        try { opts.notify?.({ store, task: t }); } catch { /* noop */ }
        db.prepare(`UPDATE retail_store_daily_tasks SET status = 'late', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(t.id);
        try { logAuthEvent(orgId, "system", t.id, "RETAIL_TASK_ESCALATED", { type: t.task_type, store: store.name }); } catch { /* noop */ }
        summary.escalated++;
        continue;
      }

      // Cobra CADA responsável pelo tipo da pendência (fechamento/malote/escala).
      // Sem responsáveis cadastrados, cai no número da loja (comportamento antigo).
      const targets = RetailResponsibleService.targetsForTask(orgId, store.id, t.task_type);
      if (!targets.length) continue; // sem número não há como cobrar por WhatsApp
      let sentAny = false;
      for (const target of targets) {
        try {
          await opts.send(target, reminderMessage(t.task_type, store.name, Number(t.reminder_count || 0)));
          sentAny = true;
        } catch (e) { console.error("[Retail] cobrança falhou", t.id, target, e); }
      }
      if (sentAny) {
        db.prepare(`UPDATE retail_store_daily_tasks SET reminder_count = reminder_count + 1, last_reminder_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(opts.now, t.id);
        summary.reminded++;
      }
    }
    return summary;
  }
}

// ── Responsáveis por loja (cobrança por pessoa, ADR-108) ─────────────────────
const RESP_TASK_TYPES = ["fechamento", "malote", "escala"];

export class RetailResponsibleService {
  static list(orgId: string, storeId: string): any[] {
    return db.prepare(
      `SELECT * FROM retail_store_responsibles WHERE organization_id = ? AND store_id = ? ORDER BY created_at`
    ).all(orgId, storeId) as any[];
  }

  static add(orgId: string, storeId: string, input: { name?: string; whatsappIdentifier: string; taskTypes?: string[] | string }, actorId?: string): any {
    const wa = String(input.whatsappIdentifier || "").replace(/\D/g, "");
    if (!wa) throw new Error("WhatsApp do responsável é obrigatório");
    const types = normalizeTaskTypes(input.taskTypes);
    const id = randomUUID();
    db.prepare(
      `INSERT INTO retail_store_responsibles (id, organization_id, store_id, name, whatsapp_identifier, task_types, active)
       VALUES (?, ?, ?, ?, ?, ?, 1)`
    ).run(id, orgId, storeId, input.name ? String(input.name).trim() : null, wa, types);
    try { logAuthEvent(orgId, actorId || "system", storeId, "RETAIL_RESPONSIBLE_ADDED", { wa, types }); } catch { /* noop */ }
    return db.prepare(`SELECT * FROM retail_store_responsibles WHERE id = ?`).get(id);
  }

  static update(orgId: string, id: string, patch: { name?: string; taskTypes?: string[] | string; active?: boolean }, actorId?: string): any | null {
    const r = db.prepare(`SELECT * FROM retail_store_responsibles WHERE organization_id = ? AND id = ?`).get(orgId, id) as any;
    if (!r) return null;
    db.prepare(
      `UPDATE retail_store_responsibles SET
         name = COALESCE(?, name),
         task_types = COALESCE(?, task_types),
         active = COALESCE(?, active),
         updated_at = CURRENT_TIMESTAMP
       WHERE organization_id = ? AND id = ?`
    ).run(
      patch.name !== undefined ? (patch.name ? String(patch.name).trim() : null) : null,
      patch.taskTypes !== undefined ? normalizeTaskTypes(patch.taskTypes) : null,
      patch.active !== undefined ? (patch.active ? 1 : 0) : null,
      orgId, id,
    );
    return db.prepare(`SELECT * FROM retail_store_responsibles WHERE id = ?`).get(id);
  }

  static remove(orgId: string, id: string, actorId?: string): boolean {
    const r = db.prepare(`DELETE FROM retail_store_responsibles WHERE organization_id = ? AND id = ?`).run(orgId, id);
    if (r.changes > 0) { try { logAuthEvent(orgId, actorId || "system", id, "RETAIL_RESPONSIBLE_REMOVED", {}); } catch { /* noop */ } }
    return r.changes > 0;
  }

  /**
   * Números a cobrar por um tipo de pendência: responsáveis ativos que cobrem
   * o tipo ('all' ou que contém o tipo). Sem responsáveis, cai no número da
   * loja (comportamento antigo — nunca deixa de cobrar).
   */
  static targetsForTask(orgId: string, storeId: string, taskType: string): string[] {
    const rows = db.prepare(
      `SELECT whatsapp_identifier, task_types FROM retail_store_responsibles
        WHERE organization_id = ? AND store_id = ? AND active = 1`
    ).all(orgId, storeId) as any[];
    const targets = rows
      .filter((r) => coversType(r.task_types, taskType))
      .map((r) => String(r.whatsapp_identifier))
      .filter(Boolean);
    if (targets.length) return Array.from(new Set(targets));
    const store = db.prepare(`SELECT whatsapp_identifier FROM retail_stores WHERE organization_id = ? AND id = ?`).get(orgId, storeId) as any;
    return store?.whatsapp_identifier ? [String(store.whatsapp_identifier)] : [];
  }

  /** Resolve o remetente para a loja pela qual ele é responsável (tolerante ao 9º dígito). */
  static findStoreByResponsible(orgId: string, identifier: string): any | null {
    for (const v of brPhoneVariants(identifier)) {
      const r = db.prepare(
        `SELECT store_id FROM retail_store_responsibles WHERE organization_id = ? AND whatsapp_identifier = ? AND active = 1 LIMIT 1`
      ).get(orgId, v) as any;
      if (r?.store_id) return db.prepare(`SELECT * FROM retail_stores WHERE organization_id = ? AND id = ? AND active = 1`).get(orgId, r.store_id);
    }
    return null;
  }
}

function normalizeTaskTypes(input?: string[] | string): string {
  if (!input) return "all";
  const arr = Array.isArray(input) ? input : String(input).split(/[,\s]+/);
  const clean = arr.map((t) => String(t || "").trim().toLowerCase()).filter((t) => RESP_TASK_TYPES.includes(t));
  if (!clean.length || clean.length === RESP_TASK_TYPES.length) return "all";
  return Array.from(new Set(clean)).join(",");
}

function coversType(taskTypes: string, taskType: string): boolean {
  const tt = String(taskTypes || "all").toLowerCase();
  return tt === "all" || tt.split(",").map((s) => s.trim()).includes(String(taskType).toLowerCase());
}

/** Variações do número BR (com/sem 9º dígito). Compartilhado com o intake. */
export function brPhoneVariants(raw: string): string[] {
  const digits = String(raw || "").replace(/\D/g, "");
  if (!digits) return [];
  const variants = new Set<string>([digits]);
  if (digits.startsWith("55") && (digits.length === 12 || digits.length === 13)) {
    const ddd = digits.slice(2, 4);
    const subscriber = digits.slice(4);
    if (subscriber.length === 9 && subscriber.startsWith("9")) variants.add(`55${ddd}${subscriber.slice(1)}`);
    else if (subscriber.length === 8) variants.add(`55${ddd}9${subscriber}`);
  }
  return Array.from(variants);
}

function parseSqlTs(ts: string): number { return Date.parse(String(ts).replace(" ", "T") + "Z") || 0; }

function reminderMessage(taskType: string, storeName: string, priorCount: number): string {
  const reforço = priorCount > 0 ? "Reforçando: " : "";
  if (taskType === "malote") return `${reforço}Oi! Falta enviar a folha de malote da loja ${storeName}. Pode mandar por aqui? 🙏`;
  if (taskType === "escala") return `${reforço}Oi! A escala da loja ${storeName} ainda não foi enviada. Pode mandar a foto/arquivo ou confirmar que já está atualizada?`;
  return `${reforço}Oi! Ainda não recebemos o fechamento da loja ${storeName} de hoje. Pode enviar a folha/foto por aqui ou preencher o resumo? 🙏`;
}
