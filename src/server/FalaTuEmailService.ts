import { randomUUID } from "node:crypto";
import db from "./db.js";
import { logAuthEvent } from "./auditLog.js";
import { FalaTuBriefingDigestService } from "./FalaTuBriefingDigestService.js";
import { FalaTuBriefingTaskService } from "./FalaTuBriefingTaskService.js";

/**
 * ADR-154 F8.6 — briefing por E-MAIL (terceira porta de entrega do digest).
 *
 * Mesmo desenho das portas WA (ADR-151 F6) e Web Push (F8.3): consome os
 * MESMOS sinais `falatu_daily_briefing` e o MESMO texto determinístico
 * (FalaTuBriefingDigestService é a fonte única de janela/texto/sinal) — este
 * service só cuida do transporte de e-mail e do seu dedupe próprio.
 *
 * Decisões e porquês:
 * - **Opt-in por USUÁRIO** (`falatu_email_optins`), não flag de org: o
 *   destino é o e-mail de login do próprio usuário — não existe "canal da
 *   org" a proteger como no WA. Desligar é UPDATE enabled=0 (convenção
 *   nº 9: a linha fica como trilha de que o opt-in existiu).
 * - **Transporte = conexão Google da org** (GoogleOAuthService.gmailSend,
 *   o MESMO caminho que a cobrança do Scheduler já usa) — zero infra nova,
 *   zero segredo novo. Org sem conexão Google → a porta fica "ligada mas
 *   sem canal" (reason `no_email_channel`; a UI explica onde conectar).
 *   Um remetente SMTP de plataforma, se um dia existir, entra aqui como
 *   fallback aditivo sem mudar nenhuma assinatura.
 * - **Só e-mail do PRÓPRIO usuário** (login em `users`): não há campo de
 *   destinatário arbitrário em rota nenhuma — o vetor "usar o briefing pra
 *   mandar e-mail pra terceiros" é impossível por construção.
 * - **Transporte injetável** (`opts.send`) — teste roda sem rede; produção
 *   faz import dinâmico do GoogleOAuthService (convenção nº 11).
 * - **Best-effort** (convenção nº 7): falha de envio nunca derruba o pass e
 *   NÃO marca a entrega — o tick seguinte da janela retenta.
 * - **Dedupe próprio** (`falatu_email_deliveries`), separado de WA e push:
 *   as portas são opt-ins independentes; o dono pode receber nas três.
 */

export type EmailTransport = (to: string, subject: string, body: string) => Promise<void>;

export class FalaTuEmailService {
  static enabled(orgId: string, userId: string): boolean {
    const r = db.prepare(`SELECT enabled FROM falatu_email_optins WHERE organization_id = ? AND user_id = ?`).get(orgId, userId) as any;
    return !!Number(r?.enabled);
  }

  static setEnabled(orgId: string, userId: string, enabled: boolean): { enabled: boolean } {
    const existing = db.prepare(`SELECT id FROM falatu_email_optins WHERE organization_id = ? AND user_id = ?`).get(orgId, userId) as any;
    if (existing) {
      db.prepare(`UPDATE falatu_email_optins SET enabled = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(enabled ? 1 : 0, existing.id);
    } else {
      db.prepare(`INSERT INTO falatu_email_optins (id, organization_id, user_id, enabled) VALUES (?, ?, ?, ?)`)
        .run(randomUUID(), orgId, userId, enabled ? 1 : 0);
    }
    logAuthEvent(orgId, userId, null, enabled ? "FALATU_EMAIL_ENABLE" : "FALATU_EMAIL_DISABLE", {});
    return { enabled };
  }

  /** Estado pra UI: opt-in + destino + se a org tem canal de envio (Google). */
  static async status(orgId: string, userId: string): Promise<{ enabled: boolean; email: string; channelReady: boolean }> {
    return {
      enabled: this.enabled(orgId, userId),
      email: this.userEmail(orgId, userId),
      channelReady: await this.channelReady(orgId),
    };
  }

  /** E-mail de login do usuário da org, ou "" se não houver. */
  private static userEmail(orgId: string, userId: string): string {
    try {
      const u = db.prepare(`SELECT email FROM users WHERE id = ? AND organization_id = ? AND COALESCE(global_status,'active') = 'active'`).get(userId, orgId) as any;
      return String(u?.email || "").trim();
    } catch { return ""; }
  }

  private static async channelReady(orgId: string): Promise<boolean> {
    try {
      const { GoogleOAuthService } = await import("./GoogleOAuthService.js");
      return !!GoogleOAuthService.getConnection(orgId);
    } catch { return false; }
  }

  /** Transporte padrão: Gmail da conexão Google da org (molde da cobrança). */
  private static defaultTransport(orgId: string): EmailTransport {
    return async (to, subject, body) => {
      const { GoogleOAuthService } = await import("./GoogleOAuthService.js");
      const r = await GoogleOAuthService.gmailSend(orgId, to, subject, body);
      if ((r as any)?.error) throw new Error((r as any).error);
    };
  }

  /** Assunto/corpo a partir do texto do digest (sem os *asteriscos* do WA). */
  static emailFromDigest(text: string, dateSP: string): { subject: string; body: string } {
    const [y, m, d] = dateSP.split("-");
    return { subject: `☀️ Seu resumo FalaTu de hoje (${d}/${m}/${y})`, body: text.replace(/\*/g, "") };
  }

  private static alreadySent(orgId: string, userId: string, dateSP: string): boolean {
    return !!db.prepare(`SELECT 1 FROM falatu_email_deliveries WHERE organization_id = ? AND user_id = ? AND briefing_date = ?`).get(orgId, userId, dateSP);
  }

  private static markSent(orgId: string, userId: string, dateSP: string): void {
    try {
      db.prepare(`INSERT INTO falatu_email_deliveries (id, organization_id, user_id, briefing_date) VALUES (?, ?, ?, ?)`)
        .run(randomUUID(), orgId, userId, dateSP);
    } catch (e: any) {
      if (e?.code !== "SQLITE_CONSTRAINT_UNIQUE") throw e;
    }
  }

  /**
   * Passe da org (Scheduler): mesmos sinais/janela/texto das outras portas,
   * dedupe próprio, e só pra quem OPTOU. Org sem conexão Google pula tudo
   * com `no_email_channel` sem tentar (não queima tentativa nem loga erro
   * por tick — é estado de configuração, não falha).
   */
  static async runDigestPass(orgId: string, opts: { now: Date; force?: boolean; send?: EmailTransport }): Promise<{ sent: number; skipped: number; results: Array<{ userId: string; reason?: string; sent: boolean }> }> {
    const out = { sent: 0, skipped: 0, results: [] as Array<{ userId: string; reason?: string; sent: boolean }> };
    const { dateSP, hourSP } = FalaTuBriefingDigestService.spParts(opts.now);
    if (!opts.force && (hourSP < 6 || hourSP >= 12)) return out;
    const send = opts.send || (await this.channelReady(orgId) ? this.defaultTransport(orgId) : null);
    for (const sig of FalaTuBriefingDigestService.openBriefingsForDay(orgId, dateSP)) {
      const userId = sig.evidence.userId as string;
      if (!this.enabled(orgId, userId)) { out.skipped++; out.results.push({ userId, reason: "not_opted_in", sent: false }); continue; }
      if (!send) { out.skipped++; out.results.push({ userId, reason: "no_email_channel", sent: false }); continue; }
      if (!opts.force && this.alreadySent(orgId, userId, dateSP)) { out.skipped++; out.results.push({ userId, reason: "already_sent", sent: false }); continue; }
      const email = this.userEmail(orgId, userId);
      if (!email) { out.skipped++; out.results.push({ userId, reason: "no_email", sent: false }); continue; }
      const { text, actionable } = FalaTuBriefingDigestService.digestText(sig.evidence);
      if (!actionable) { out.skipped++; out.results.push({ userId, reason: "not_actionable", sent: false }); continue; }
      try {
        const { subject, body } = this.emailFromDigest(text, dateSP);
        await send(email, subject, body);
        this.markSent(orgId, userId, dateSP);
        out.sent++;
        out.results.push({ userId, sent: true });
      } catch (e: any) {
        // Best-effort: sem markSent — o próximo tick da janela retenta.
        console.error("[FalaTuEmail] envio falhou (retenta no próximo tick):", e?.message || e);
        out.skipped++;
        out.results.push({ userId, reason: "send_failed", sent: false });
      }
    }
    return out;
  }

  /** "Enviar agora" — ignora janela/dedupe; exige opt-in + canal + briefing. */
  static async sendNow(orgId: string, userId: string, opts?: { now?: Date; send?: EmailTransport }): Promise<{ sent: number; skipped: number; reason?: string }> {
    if (!this.enabled(orgId, userId)) return { sent: 0, skipped: 1, reason: "email_disabled" };
    const email = this.userEmail(orgId, userId);
    if (!email) return { sent: 0, skipped: 1, reason: "no_email" };
    const send = opts?.send || (await this.channelReady(orgId) ? this.defaultTransport(orgId) : null);
    if (!send) return { sent: 0, skipped: 1, reason: "no_email_channel" };
    const { dateSP } = FalaTuBriefingDigestService.spParts(opts?.now || new Date());
    // Atualiza o sinal do dia (idempotente) pra refletir o estado atual antes do envio.
    try { FalaTuBriefingTaskService.run(orgId, { date: dateSP }); } catch { /* best-effort */ }
    const sig = FalaTuBriefingDigestService.openBriefingsForDay(orgId, dateSP).find((s: any) => s.evidence.userId === userId);
    if (!sig) return { sent: 0, skipped: 1, reason: "no_briefing" };
    const { text, actionable } = FalaTuBriefingDigestService.digestText(sig.evidence);
    if (!actionable) return { sent: 0, skipped: 1, reason: "no_briefing" };
    try {
      const { subject, body } = this.emailFromDigest(text, dateSP);
      await send(email, subject, body);
    } catch (e: any) {
      return { sent: 0, skipped: 1, reason: "send_failed" };
    }
    this.markSent(orgId, userId, dateSP);
    return { sent: 1, skipped: 0 };
  }
}

export default FalaTuEmailService;
