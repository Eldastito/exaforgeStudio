/**
 * Fiação do MODO MISTO no inbound (PRD WhatsApp Unificado — RF-04 §10, F3.3b).
 *
 * Camada FINA entre o `webhookProcessor` e o roteador puro `MixedModeRouterService`
 * (F3.3a): lê a flag opt-in, computa o CONTEXTO de conversa (§10.5, que o roteador
 * não lê por ser puro), gerencia o PENDENTE de escolha (§10.7 "atendimento ou
 * gestão?") e devolve a FAIXA. Tudo isolado por org.
 *
 * Guardrails:
 * - `mixed_mode_enabled` default 0 → `isEnabled` false → o webhook NEM chama isto
 *   (0-regressão: caminho inbound idêntico ao de hoje).
 * - Escolha pendente é DURÁVEL (tabela `mixed_mode_pending_choices`, TTL) — não
 *   revive o anti-padrão in-memory do CA-06. A desambiguação numerada robusta
 *   (Gestor/Coordenador) é generalizada na F3.4.
 * - `hasActiveCustomerContext` = existe ticket ABERTO do contato deste número
 *   neste canal → gestor no meio de um atendimento SEGUE no atendimento (§10.6).
 * - A escolha resolve por sinal EXPLÍCITO do usuário (1/2/atendimento/gestão),
 *   nunca por inferência de linguagem natural (§10.7).
 */
import db from "./db.js";
import { MixedModeRouterService, type MixedModeDecision } from "./MixedModeRouterService.js";

const PENDING_TTL_MIN = 30;

export class MixedModeInboundService {
  static isEnabled(orgId: string): boolean {
    try {
      const r = db.prepare(`SELECT mixed_mode_enabled FROM organization_settings WHERE organization_id = ?`).get(orgId) as any;
      return !!Number(r?.mixed_mode_enabled);
    } catch { return false; }
  }

  /** Existe atendimento (ticket aberto) em curso para este número neste canal? */
  static hasActiveCustomerContext(orgId: string, channelId: string, senderId: string): boolean {
    try {
      const row = db.prepare(
        `SELECT 1 FROM tickets t JOIN contacts c ON c.id = t.contact_id
          WHERE t.organization_id = ? AND c.channel_id = ? AND c.identifier = ? AND t.status = 'open' LIMIT 1`,
      ).get(orgId, channelId, senderId);
      return !!row;
    } catch { return false; }
  }

  // ── Pendente de escolha (durável) ──

  static hasPendingChoice(orgId: string, channelId: string, senderId: string, now: Date = new Date()): boolean {
    try {
      const r = db.prepare(
        `SELECT expires_at FROM mixed_mode_pending_choices WHERE organization_id = ? AND channel_id = ? AND sender_id = ?`,
      ).get(orgId, channelId, senderId) as any;
      if (!r) return false;
      if (new Date(r.expires_at).getTime() < now.getTime()) { this.clearPending(orgId, channelId, senderId); return false; }
      return true;
    } catch { return false; }
  }

  static setPending(orgId: string, channelId: string, senderId: string, now: Date = new Date()): void {
    const expires = new Date(now.getTime() + PENDING_TTL_MIN * 60_000).toISOString();
    db.prepare(
      `INSERT INTO mixed_mode_pending_choices (organization_id, channel_id, sender_id, expires_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(organization_id, channel_id, sender_id) DO UPDATE SET expires_at = excluded.expires_at, created_at = CURRENT_TIMESTAMP`,
    ).run(orgId, channelId, senderId, expires);
  }

  static clearPending(orgId: string, channelId: string, senderId: string): void {
    try { db.prepare(`DELETE FROM mixed_mode_pending_choices WHERE organization_id = ? AND channel_id = ? AND sender_id = ?`).run(orgId, channelId, senderId); } catch { /* noop */ }
  }

  /** Interpreta a resposta à pergunta de escolha (sinal EXPLÍCITO, não NL). */
  static parseChoice(text: string | null | undefined): "attendance" | "internal" | null {
    const t = String(text || "").trim().toLowerCase();
    if (t === "1" || /^atendimento\b/.test(t) || t === "cliente") return "attendance";
    if (t === "2" || /^(gest[aã]o|gerente|interno)\b/.test(t)) return "internal";
    return null;
  }

  /** Texto da pergunta de escolha (§10.7 — escolha simples). */
  static choicePrompt(): string {
    return "Você quer *atendimento* (falar como cliente) ou *gestão* (consultar o negócio)?\nResponda *1* para atendimento ou *2* para gestão.";
  }

  /**
   * Decide a faixa da mensagem. Só deve ser chamado quando `isEnabled` e o canal
   * NÃO é interno (o canal interno já roteia sozinho). Resolve pendente primeiro.
   */
  static decide(
    orgId: string,
    channel: { id: string; kind?: string | null },
    payload: { senderId: string; text?: string | null },
    opts: { now?: Date } = {},
  ): MixedModeDecision & { resolvedFromPending?: boolean } {
    const now = opts.now || new Date();
    const senderId = payload.senderId;

    // 1) Escolha pendente vigente + resposta explícita → resolve e limpa.
    if (this.hasPendingChoice(orgId, channel.id, senderId, now)) {
      const choice = this.parseChoice(payload.text);
      if (choice) {
        this.clearPending(orgId, channel.id, senderId);
        // Reaproveita o roteador para trazer userId/role coerentes com a faixa.
        const d = MixedModeRouterService.route(orgId, senderId, {
          channelKind: channel.kind,
          hasActiveCustomerContext: choice === "attendance",
          hasActiveInternalContext: choice === "internal",
        });
        return { ...d, lane: choice, resolvedFromPending: true };
      }
      // Pendente aberto e a mensagem não é escolha: mantém pendente e re-decide
      // pelo roteador (que provavelmente devolve ask_which → repergunta).
    }

    // 2) Sem pendente resolvido → roteador puro com o contexto de conversa.
    const hasCustomer = this.hasActiveCustomerContext(orgId, channel.id, senderId);
    return MixedModeRouterService.route(orgId, senderId, {
      channelKind: channel.kind,
      hasActiveCustomerContext: hasCustomer,
    });
  }
}

export default MixedModeInboundService;
