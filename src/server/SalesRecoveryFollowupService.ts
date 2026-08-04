import db from "./db.js";
import { logAuthEvent } from "./auditLog.js";
import { SalesStalledDealDetectorService, type StalledDeal } from "./SalesStalledDealDetectorService.js";

/**
 * Cadência multi-tentativa de recuperação comercial (ADR-152 F4c.3).
 *
 * Motor SÍNCRONO rodado pelo `Scheduler.salesRecoveryFollowupPass` a
 * cada tick. Pra cada org opt-in (`sales_recovery_followup_enabled=1`,
 * DENTRO do opt-in F4c principal), varre `sales_recovery_touches`
 * aprovados há N dias sem resposta e propõe 2ª / 3ª msg via
 * `SalesRecoveryPlaybookService.proposeForTicket(deal, {attemptNumber})`.
 *
 * CADA proposta ainda passa por aprovação humana (padrão F4c MVP —
 * publica sinal `sales_recovery_proposed` com `attemptNumber`; dono
 * clica "aprovar" ou "dispensar" na aba Operações). **G-4c.3-1**:
 * modo autonomous continua BLOQUEADO — decisão #4 LGPD.
 *
 * Diferencial pra cobrança (F4b.3):
 *   - Cobrança AUTO-ENVIA T2/T3 (aprovação já veio no ciclo de setup
 *     opt-in "collection_cadence_enabled=1" — LGPD Art.7 §V, cliente
 *     é devedor conhecido).
 *   - Recuperação PROPÕE 2ª/3ª pro dono aprovar (LGPD Art.8 §5,
 *     comunicação a lead exige base legal + consentimento renovado).
 *
 * Guardas RN F4c.3:
 *   G-4c.3-1: (guarda-mãe) cada tentativa passa por dono aprovar. Modo
 *             autonomous BLOQUEADO em decisão #4 LGPD.
 *   G-4c.3-2: opt-in duplo (sales_recovery_enabled + sales_recovery_
 *             followup_enabled).
 *   G-4c.3-3: máx 3 tentativas totais (1 original + 2 follow-ups).
 *   G-4c.3-4: cliente respondeu (reply_intent != NULL) → PARA cadência
 *             independente de attempt (interesse manifestado, dono
 *             continua no controle).
 *   G-4c.3-5: contato marketing_opt_out=1 NUNCA entra na fila
 *             (SalesStalledDealDetectorService já filtra na próxima
 *             varredura + double-check aqui).
 *   G-4c.3-6: ticket saiu do funil (stage ganho/perdido/desqualificado)
 *             → PARA (SalesStalledDealDetectorService.getSalesStages
 *             já filtra).
 *   G-4c.3-7: dedupe do sinal via dedupeKey (touch, attempt, dia) —
 *             detector varre 2× no mesmo dia = 1 proposta.
 *   G-4c.3-8: gap configurável por-org (default 5 dias).
 *   G-4c.3-9: mensagens 2ª/3ª mais suaves (não cobrança). Gerador
 *             usa ATTEMPT_HINTS pra tom apropriado por tentativa.
 *   G-4c.3-10: isolamento cross-tenant.
 */

const DEFAULT_GAP_DAYS = 5;

export interface FollowupTickResult { orgsScanned: number; proposed: number; skipped: number; }
export interface OrgFollowupResult { proposed: number; skipped: number; }

interface FollowupCandidate {
  touchId: string;
  ticketId: string;
  contactId: string;
  phone: string;
  channelId: string;
  attemptCount: number;         // quantos touches já existem pra esse ticket (define nextAttempt)
  lastSentAt: string;
}

export class SalesRecoveryFollowupService {
  /** Varre todas as orgs opt-in-dentro-de-opt-in. Best-effort. */
  static async tickAll(): Promise<FollowupTickResult> {
    const rows = db.prepare(`
      SELECT organization_id AS orgId,
             COALESCE(sales_recovery_followup_days_gap, ?) AS gapDays,
             COALESCE(sales_recovery_stalled_days, 10) AS stalledDays
        FROM organization_settings
       WHERE COALESCE(sales_recovery_enabled, 0) = 1
         AND COALESCE(sales_recovery_followup_enabled, 0) = 1
    `).all(DEFAULT_GAP_DAYS) as any[];
    let proposed = 0, skipped = 0;
    for (const r of rows) {
      try {
        const res = await this.runForOrg(r.orgId, { gapDays: Number(r.gapDays), stalledDays: Number(r.stalledDays) });
        proposed += res.proposed; skipped += res.skipped;
      } catch (e) { console.error("[Runtime F4c.3] followup falhou pra org", r.orgId, e); }
    }
    return { orgsScanned: rows.length, proposed, skipped };
  }

  /** Roda pra UMA org. Retorna contadores. */
  static async runForOrg(orgId: string, opts: { gapDays?: number; stalledDays?: number } = {}): Promise<OrgFollowupResult> {
    const gapDays = Number(opts.gapDays ?? DEFAULT_GAP_DAYS);
    const stalledDays = Number(opts.stalledDays ?? 10);
    const candidates = this.findCandidates(orgId, gapDays);
    if (!candidates.length) return { proposed: 0, skipped: 0 };

    // Import dinâmico pra quebrar ciclo (SalesRecoveryPlaybook usa
    // BusinessSignal que pode importar isso).
    const { SalesRecoveryPlaybookService } = await import("./SalesRecoveryPlaybook.js");

    let proposed = 0, skipped = 0;
    for (const c of candidates) {
      const nextAttempt = (c.attemptCount + 1) as 1 | 2 | 3;
      // G-4c.3-3: máx 3 tentativas totais.
      if (nextAttempt > 3) { skipped++; continue; }

      // Reconfirma opt-out (defesa em profundidade — detector também filtra
      // mas o touch pode ter sido criado antes do opt-out ser marcado).
      try {
        const contact = db.prepare(`SELECT marketing_opt_out FROM contacts WHERE id = ? AND organization_id = ?`).get(c.contactId, orgId) as any;
        if (contact && Number(contact.marketing_opt_out) === 1) { skipped++; continue; }
      } catch { /* continua */ }

      // Reconstrói o StalledDeal pro `proposeForTicket` (o formato é o
      // mesmo que o detector devolveria).
      const ticket = db.prepare(`SELECT stage, temperature, updated_at FROM tickets WHERE id = ? AND organization_id = ? AND status = 'open'`).get(c.ticketId, orgId) as any;
      if (!ticket) { skipped++; continue; }
      // G-4c.3-6: ticket saiu do funil → PARA.
      if (!SalesStalledDealDetectorService.getSalesStages().includes(String(ticket.stage))) { skipped++; continue; }

      const contactRow = db.prepare(`SELECT name FROM contacts WHERE id = ? AND organization_id = ?`).get(c.contactId, orgId) as any;
      const deal: StalledDeal = {
        ticketId: c.ticketId, contactId: c.contactId,
        channelId: c.channelId, stage: String(ticket.stage),
        temperature: ticket.temperature || null,
        updatedAt: ticket.updated_at,
        contactName: contactRow?.name || null,
        contactPhone: c.phone,
        daysSinceLastActivity: Math.max(0, Math.floor((Date.now() - new Date(ticket.updated_at).getTime()) / 86400_000)),
        lastContactMessageAt: null,
      };
      void stalledDays; // reservado pra futura decisão (skip se ainda dentro do stall period antes de propor)

      try {
        await SalesRecoveryPlaybookService.proposeForTicket(orgId, deal, "runtime", { attemptNumber: nextAttempt });
        proposed++;
        try {
          logAuthEvent(orgId, null, c.contactId, "RUNTIME_SALES_RECOVERY_FOLLOWUP_QUEUED", {
            ticketId: c.ticketId, attemptNumber: nextAttempt, lastTouchId: c.touchId,
          });
        } catch { /* noop */ }
      } catch (e: any) { skipped++; console.warn("[Runtime F4c.3] proposeForTicket falhou", c.ticketId, e?.message); }
    }
    return { proposed, skipped };
  }

  /**
   * Encontra touches aprovados há N dias, SEM reply do cliente, cujo
   * ticket ainda existe. NÃO filtra opt-out aqui (deixa pro loop pra
   * ter audit trail claro) — mas o SalesStalledDealDetectorService já
   * filtra na próxima varredura.
   */
  private static findCandidates(orgId: string, gapDays: number): FollowupCandidate[] {
    const cutoffIso = new Date(Date.now() - gapDays * 86400_000).toISOString();
    const rows = db.prepare(`
      SELECT ticket_id AS ticketId, contact_id AS contactId, phone, channel_id AS channelId,
             MAX(sent_at) AS lastSentAt,
             COUNT(*) AS attemptCount
        FROM sales_recovery_touches
       WHERE organization_id = ?
         AND reply_intent IS NULL
       GROUP BY ticket_id
       HAVING MAX(sent_at) <= ?
       ORDER BY MAX(sent_at) ASC
       LIMIT 100
    `).all(orgId, cutoffIso) as any[];
    // "touchId" fica com o touch mais recente daquele ticket — usado pra
    // rastreabilidade no audit (`lastTouchId`).
    const out: FollowupCandidate[] = [];
    for (const r of rows) {
      const lastTouch = db.prepare(`SELECT id FROM sales_recovery_touches WHERE organization_id = ? AND ticket_id = ? ORDER BY sent_at DESC LIMIT 1`).get(orgId, r.ticketId) as any;
      if (!lastTouch) continue;
      out.push({
        touchId: lastTouch.id,
        ticketId: r.ticketId, contactId: r.contactId,
        phone: r.phone, channelId: r.channelId,
        attemptCount: Number(r.attemptCount),
        lastSentAt: r.lastSentAt,
      });
    }
    return out;
  }
}

export default SalesRecoveryFollowupService;
