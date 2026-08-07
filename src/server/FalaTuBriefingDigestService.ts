import { randomUUID } from "crypto";
import db from "./db.js";
import { onlyDigits } from "./phoneMatch.js";
import { BusinessSignalService } from "./BusinessSignalService.js";
import { FalaTuBriefingTaskService } from "./FalaTuBriefingTaskService.js";

/**
 * FalaTu — ENTREGA DO BRIEFING DIÁRIO POR WHATSAPP (ADR-151 Fatia 6).
 *
 * CONSUMIDOR dos sinais `falatu_daily_briefing` que a Fatia 5 publica no
 * `business_signals` (ADR-136): o ledger é a fonte da verdade, este service é
 * só um leitor que formata o sinal do dia e manda pro WhatsApp do usuário.
 * Não recomputa nada nem cria sinal — se o sweep não publicou (dia sem nada
 * acionável), não há o que entregar. Espelha o TeacherDigestService (ADR-144):
 * texto DETERMINÍSTICO (zero-token), janela da manhã em hora de São Paulo,
 * dedupe por dia, envio `send` INJETADO (testável sem rede).
 *
 * PORTA (convenção nº 10): flag de org `falatu_briefing_wa_enabled` — mandar
 * mensagem proativa é outbound, então é opt-in SEPARADO da flag do módulo
 * (`falatu_enabled`, que só o habilita). Dedupe de entrega por (org, usuário,
 * dia) na tabela best-effort `falatu_briefing_deliveries` (convenção nº 7/8:
 * unique index + insert que ignora conflito), já que o FalaTu não tem tabela
 * de perfil como o professor.
 *
 * GUARDRAILS: este service NUNCA cria/edita tarefa, evento, lista ou entidade
 * — só lê o sinal e envia. Falha de envio não marca a entrega (retenta no tick
 * seguinte). Isolado por organization_id + user_id.
 */

export interface FalaTuDigestResult {
  sent: number;
  skipped: number;
  results: Array<{ userId: string; phone?: string; reason?: string; sent: boolean }>;
}

export class FalaTuBriefingDigestService {
  private static MORNING_START = 6;
  private static MORNING_END = 12; // exclusivo

  static waEnabled(orgId: string): boolean {
    try {
      const r = db.prepare(`SELECT falatu_briefing_wa_enabled FROM organization_settings WHERE organization_id = ?`).get(orgId) as any;
      return !!Number(r?.falatu_briefing_wa_enabled);
    } catch { return false; }
  }

  static setWaEnabled(orgId: string, enabled: boolean): { enabled: boolean } {
    db.prepare(`UPDATE organization_settings SET falatu_briefing_wa_enabled = ? WHERE organization_id = ?`).run(enabled ? 1 : 0, orgId);
    return { enabled };
  }

  /** Data e hora em São Paulo (determinístico p/ teste — igual ao TeacherDigestService). */
  static spParts(now: Date): { dateSP: string; hourSP: number } {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Sao_Paulo",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", hourCycle: "h23",
    }).formatToParts(now);
    const get = (t: string) => parts.find((p) => p.type === t)?.value || "";
    return { dateSP: `${get("year")}-${get("month")}-${get("day")}`, hourSP: Number(get("hour")) };
  }

  /**
   * Monta o texto do digest a partir da EVIDÊNCIA do sinal (zero-token). Só
   * inclui as seções com conteúdo; retorna `actionable=false` quando o sinal
   * não tem nada a dizer (nesse caso o chamador não envia).
   */
  static digestText(evidence: any): { text: string; actionable: boolean } {
    const pendingInbox = Number(evidence?.pendingInbox) || 0;
    const todayEvents: any[] = Array.isArray(evidence?.todayEvents) ? evidence.todayEvents : [];
    const undated: any[] = Array.isArray(evidence?.undatedEvents) ? evidence.undatedEvents : [];
    const openTasks = Number(evidence?.openTasks) || 0;
    const actionable = pendingInbox > 0 || todayEvents.length > 0 || undated.length > 0;

    const lines: string[] = ["☀️ *Bom dia! Seu resumo FalaTu de hoje:*", ""];
    if (pendingInbox > 0) {
      lines.push(`📥 ${pendingInbox} ${pendingInbox === 1 ? "anotação aguardando" : "anotações aguardando"} sua confirmação.`);
    }
    if (todayEvents.length) {
      lines.push("🗓️ *Compromissos de hoje:*");
      for (const e of todayEvents) lines.push(`• ${e.time ? `${e.time} — ` : ""}${e.title}`);
    }
    if (undated.length) {
      lines.push("⚠️ *Sem data definida* (complete quando puder):");
      for (const e of undated) lines.push(`• ${e.title}`);
    }
    if (openTasks > 0) {
      lines.push(`✅ ${openTasks} ${openTasks === 1 ? "tarefa aberta" : "tarefas abertas"}.`);
    }
    lines.push("");
    lines.push("Abra o painel (aba FalaTu) ou me responda por aqui. 👍");
    return { text: lines.join("\n"), actionable };
  }

  /** Telefone (só dígitos) do usuário da org, ou "" se não cadastrado. */
  private static userPhone(orgId: string, userId: string): string {
    try {
      const u = db.prepare(`SELECT phone FROM users WHERE id = ? AND organization_id = ? AND COALESCE(global_status,'active') = 'active'`).get(userId, orgId) as any;
      return onlyDigits(u?.phone);
    } catch { return ""; }
  }

  /** Sinais de briefing ABERTOS da org publicados PARA o dia `dateSP`.
   *  Público desde a F8.3: a porta Web Push consome os MESMOS sinais (fonte única). */
  static openBriefingsForDay(orgId: string, dateSP: string): any[] {
    return BusinessSignalService.list(orgId, { domain: "falatu", status: "open" })
      .filter((s: any) => s.signal_type === "falatu_daily_briefing" && s.evidence?.date === dateSP && s.evidence?.userId);
  }

  private static alreadySent(orgId: string, userId: string, dateSP: string): boolean {
    const r = db.prepare(`SELECT 1 FROM falatu_briefing_deliveries WHERE organization_id = ? AND user_id = ? AND briefing_date = ?`).get(orgId, userId, dateSP);
    return !!r;
  }

  private static markSent(orgId: string, userId: string, dateSP: string): void {
    // Best-effort (convenção nº 7): a unique index dedupe entregas concorrentes;
    // conflito não é erro — só significa "já entregue".
    try {
      db.prepare(`INSERT INTO falatu_briefing_deliveries (id, organization_id, user_id, briefing_date) VALUES (?, ?, ?, ?)`)
        .run(randomUUID(), orgId, userId, dateSP);
    } catch (e: any) {
      if (e?.code !== "SQLITE_CONSTRAINT_UNIQUE") throw e;
    }
  }

  /**
   * Passe da org (envio injetado). Para cada sinal de briefing aberto do dia,
   * com usuário de telefone válido, DENTRO da janela da manhã (SP) e ainda não
   * entregue hoje, envia e marca a entrega SÓ APÓS o envio (retenta se falhar).
   * Não recomputa o briefing — quem publica o sinal é o falatuBriefingPass.
   */
  static async runPass(orgId: string, opts: { now: Date; send: (phone: string, text: string) => any; force?: boolean }): Promise<FalaTuDigestResult> {
    const out: FalaTuDigestResult = { sent: 0, skipped: 0, results: [] };
    if (!this.waEnabled(orgId)) return out;
    const { dateSP, hourSP } = this.spParts(opts.now);
    if (!opts.force && (hourSP < this.MORNING_START || hourSP >= this.MORNING_END)) return out;

    for (const sig of this.openBriefingsForDay(orgId, dateSP)) {
      const userId = sig.evidence.userId as string;
      if (!opts.force && this.alreadySent(orgId, userId, dateSP)) { out.skipped++; out.results.push({ userId, reason: "already_sent", sent: false }); continue; }
      const phone = this.userPhone(orgId, userId);
      if (!phone) { out.skipped++; out.results.push({ userId, reason: "no_phone", sent: false }); continue; }
      const { text, actionable } = this.digestText(sig.evidence);
      if (!actionable) { out.skipped++; out.results.push({ userId, reason: "not_actionable", sent: false }); continue; }
      await opts.send(phone, text);
      this.markSent(orgId, userId, dateSP);
      out.sent++;
      out.results.push({ userId, phone, sent: true });
    }
    return out;
  }

  /**
   * Envio manual ("enviar meu resumo agora") — ignora janela e dedupe, mas
   * RESPEITA a porta (flag WA) e a existência de briefing. Garante o sinal do
   * dia fresco (roda o sweep antes) e envia só pro próprio usuário.
   */
  static async sendNow(orgId: string, userId: string, opts: { now?: Date; send: (phone: string, text: string) => any }): Promise<{ sent: number; skipped: number; reason?: string }> {
    if (!this.waEnabled(orgId)) return { sent: 0, skipped: 1, reason: "wa_disabled" };
    const { dateSP } = this.spParts(opts.now || new Date());
    // Atualiza o sinal do dia (idempotente) pra refletir o estado atual antes do envio.
    try { FalaTuBriefingTaskService.run(orgId, { date: dateSP }); } catch { /* best-effort */ }
    const phone = this.userPhone(orgId, userId);
    if (!phone) return { sent: 0, skipped: 1, reason: "no_phone" };
    const sig = this.openBriefingsForDay(orgId, dateSP).find((s: any) => s.evidence.userId === userId);
    if (!sig) return { sent: 0, skipped: 1, reason: "no_briefing" };
    const { text, actionable } = this.digestText(sig.evidence);
    if (!actionable) return { sent: 0, skipped: 1, reason: "no_briefing" };
    await opts.send(phone, text);
    this.markSent(orgId, userId, dateSP);
    return { sent: 1, skipped: 0 };
  }
}

export default FalaTuBriefingDigestService;
