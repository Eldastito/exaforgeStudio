import db from "./db.js";
import { randomUUID } from "crypto";
import { logAuthEvent } from "./auditLog.js";
import { OutcomeMeasurementService } from "./OutcomeMeasurementService.js";

/**
 * Atribuição de revenue_recovered real (ADR-152 F4c.4).
 *
 * Quando um ticket vira `stage=ganho` (via kanban manual, `POST
 * /tickets/:id/stage` — que grava `ticket_stage_logs`) depois de uma
 * proposta de recuperação comercial aprovada em janela, o Runtime
 * atribui o valor real da venda como `revenueRecovered` no outcome
 * F3.1 amarrado à ação de recuperação.
 *
 * Fonte do valor da venda (precedência):
 *   1. `orders.total_amount` (status pago/em_preparo/entregue/concluido)
 *      → `basis='fact'`, `source='orders'` (mesmo padrão RIC).
 *   2. `quotes.total_amount` (status='accepted')
 *      → `basis='estimate'`, `source='quotes'` (proposta aceita mas
 *      pedido não gerado ainda).
 *   3. `contacts.avg_ticket` (média histórica do contato)
 *      → `basis='estimate'`, `source='contacts_avg_ticket'` (fallback).
 *   4. Se nada disponível → NÃO atribui (G-4c.4-7). Dono pode
 *      registrar manualmente.
 *
 * Precedente: `RevenueIntelligenceService.listRecoveryActions` já
 * atribui revenue pra campanhas RIC (padrão validado). F4c.4 aplica
 * o mesmo esquema pra pilotos autônomos.
 *
 * Guardas RN F4c.4:
 *   G-4c.4-1: opt-in via `sales_recovery_attribution_enabled=1`
 *             (default 0). Sem opt-in, não atribui — evita contar
 *             ganho como do Runtime quando o dono não configurou.
 *   G-4c.4-2: janela configurável (`sales_recovery_attribution_window_
 *             days`, default 30). Ganho fora da janela NÃO conta.
 *   G-4c.4-3: touch ELEGÍVEL = reply_intent IN (NULL, 'interested',
 *             'meeting_request'). `remove_me`/`already_bought`/etc
 *             NÃO contam como recuperação bem-sucedida.
 *   G-4c.4-4: UNIQUE(org, ticket, stage_change_at) — dedupe forte.
 *   G-4c.4-5: `basis='fact'` só se `source='orders'` (venda real);
 *             quotes/avg viram `estimate` (ADR-085 D4 — nunca somar
 *             fact com estimate no ledger).
 *   G-4c.4-6: isolamento cross-tenant (todas queries filtram
 *             organization_id).
 *   G-4c.4-7: `ticket_value=0` (nenhuma fonte) → NÃO atribui (evita
 *             contaminar ledger; dono preenche manual depois).
 *   G-4c.4-8: só stage `to_stage='ganho'` (sem `perdido`/`desqualificado`
 *             — nem sinaliza churn aqui, isso é outra fatia).
 */

const DEFAULT_WINDOW_DAYS = 30;

const ELIGIBLE_REPLY_INTENTS = new Set(["interested", "meeting_request"]);
const PAID_ORDER_STATUSES = ["pago", "em_preparo", "entregue", "concluido"];

interface StageWonEvent {
  logId: string;
  ticketId: string;
  stageChangeAt: string;
  changedBy: string | null;
}

interface AttributionInput {
  orgId: string;
  event: StageWonEvent;
  windowDays: number;
}

export interface AttributeResult {
  attributed: boolean;
  ticketId: string;
  actionId?: string | null;
  touchId?: string | null;
  ticketValue?: number;
  source?: "orders" | "quotes" | "contacts_avg_ticket" | "zero";
  basis?: "fact" | "estimate";
  reason?: string;
}

export interface AttributionTickResult { orgsScanned: number; attributed: number; skipped: number; }

export class SalesRecoveryAttributionService {
  /** Varre orgs opt-in. Best-effort. */
  static async tickAll(): Promise<AttributionTickResult> {
    const rows = db.prepare(`
      SELECT organization_id AS orgId,
             COALESCE(sales_recovery_attribution_window_days, ?) AS windowDays
        FROM organization_settings
       WHERE COALESCE(sales_recovery_attribution_enabled, 0) = 1
    `).all(DEFAULT_WINDOW_DAYS) as any[];
    let attributed = 0, skipped = 0;
    for (const r of rows) {
      try {
        const res = await this.runForOrg(r.orgId, { windowDays: Number(r.windowDays) });
        attributed += res.attributed; skipped += res.skipped;
      } catch (e) { console.error("[Runtime F4c.4] attribution falhou pra org", r.orgId, e); }
    }
    return { orgsScanned: rows.length, attributed, skipped };
  }

  /** Roda pra UMA org. */
  static async runForOrg(orgId: string, opts: { windowDays?: number } = {}): Promise<{ attributed: number; skipped: number }> {
    const windowDays = Number(opts.windowDays ?? DEFAULT_WINDOW_DAYS);
    const events = this.findUnattributedWonEvents(orgId, windowDays);
    let attributed = 0, skipped = 0;
    for (const event of events) {
      try {
        const r = this.attributeOne({ orgId, event, windowDays });
        if (r.attributed) attributed++; else skipped++;
      } catch (e) { console.error("[Runtime F4c.4] attributeOne falhou", event.logId, e); skipped++; }
    }
    return { attributed, skipped };
  }

  /**
   * Encontra transições `→ganho` recentes (dentro da janela) que ainda
   * NÃO foram atribuídas. Une join com sales_recovery_attributions
   * pra pular já processados (idempotência).
   */
  private static findUnattributedWonEvents(orgId: string, windowDays: number): StageWonEvent[] {
    const cutoffIso = new Date(Date.now() - windowDays * 86400_000).toISOString();
    const rows = db.prepare(`
      SELECT l.id AS logId, l.ticket_id AS ticketId, l.created_at AS stageChangeAt, l.changed_by AS changedBy
        FROM ticket_stage_logs l
        LEFT JOIN sales_recovery_attributions a
               ON a.organization_id = l.organization_id
              AND a.ticket_id = l.ticket_id
              AND a.stage_change_at = l.created_at
       WHERE l.organization_id = ?
         AND l.to_stage = 'ganho'
         AND l.created_at >= ?
         AND a.id IS NULL
       ORDER BY l.created_at ASC
       LIMIT 200
    `).all(orgId, cutoffIso) as any[];
    return rows.map((r) => ({ logId: r.logId, ticketId: r.ticketId, stageChangeAt: r.stageChangeAt, changedBy: r.changedBy || null }));
  }

  /**
   * Atribui UM ganho. Sync (sem await de LLM/rede — tudo é DB local).
   * Retorna resultado detalhado pra tests e UI.
   */
  static attributeOne(input: AttributionInput): AttributeResult {
    const { orgId, event, windowDays } = input;

    // Localiza touch elegível (mais recente na janela) pra este ticket.
    const cutoffIso = new Date(new Date(event.stageChangeAt).getTime() - windowDays * 86400_000).toISOString();
    const touch = db.prepare(`
      SELECT id, ticket_id AS ticketId, contact_id AS contactId, sent_at AS sentAt,
             reply_intent AS replyIntent, proposed_signal_id AS proposedSignalId
        FROM sales_recovery_touches
       WHERE organization_id = ?
         AND ticket_id = ?
         AND sent_at >= ?
         AND sent_at <= ?
       ORDER BY sent_at DESC, rowid DESC
       LIMIT 1
    `).get(orgId, event.ticketId, cutoffIso, event.stageChangeAt) as any;
    if (!touch) return { attributed: false, ticketId: event.ticketId, reason: "no_touch_in_window" };

    // G-4c.4-3: elegibilidade do intent.
    const intent = touch.replyIntent || null;
    if (intent && !ELIGIBLE_REPLY_INTENTS.has(intent)) {
      return { attributed: false, ticketId: event.ticketId, reason: `ineligible_reply_intent:${intent}` };
    }

    // Resolve actionId — evidence do business_signal `sales_recovery_
    // proposed` mais recente pré-ganho amarrado ao ticket.
    let actionId: string | null = null;
    try {
      const sig = db.prepare(`
        SELECT evidence_json FROM business_signals
         WHERE organization_id = ? AND source_entity_type = 'ticket'
           AND source_entity_id = ? AND signal_type = 'sales_recovery_proposed'
         ORDER BY detected_at DESC LIMIT 1
      `).get(orgId, event.ticketId) as any;
      if (sig?.evidence_json) {
        const ev = JSON.parse(sig.evidence_json);
        if (ev?.actionId) actionId = String(ev.actionId);
      }
    } catch { /* deixa null */ }

    // Calcula ticket_value com precedência (orders → quotes → avg).
    const valuation = this.computeTicketValue(orgId, event.ticketId);
    if (valuation.value <= 0 && valuation.source !== "orders") {
      // G-4c.4-7: sem valor válido, não atribui (evita ledger com zeros).
      return { attributed: false, ticketId: event.ticketId, reason: "zero_value_no_source", touchId: touch.id, actionId };
    }
    if (valuation.value <= 0) {
      // orders devolveu 0 (nenhum pedido pago) — não é uma venda real ainda.
      return { attributed: false, ticketId: event.ticketId, reason: "orders_zero_paid", touchId: touch.id, actionId };
    }

    // Grava outcome F3.1 revenueRecovered (só se actionId conhecido).
    let outcomeId: string | null = null;
    if (actionId) {
      try {
        const outcome = OutcomeMeasurementService.record(orgId, actionId, {
          expectedValue: null,
          realizedValue: valuation.value,
          basis: valuation.basis,
          measurementMethod: "derived",
          revenueRecovered: valuation.value,
          evidence: {
            ticketId: event.ticketId,
            touchId: touch.id,
            stageChangeAt: event.stageChangeAt,
            valueSource: valuation.source,
            windowDays,
            source: "sales_recovery_attribution",
          },
        });
        outcomeId = outcome?.id || null;
      } catch (e) { console.warn("[Runtime F4c.4] OutcomeMeasurement.record falhou", actionId, e); }
    }

    // Reserva a linha (idempotência forte via UNIQUE).
    const id = randomUUID();
    try {
      db.prepare(`INSERT INTO sales_recovery_attributions
          (id, organization_id, ticket_id, touch_id, action_id, stage_change_at, ticket_value, revenue_recovered, source, basis, outcome_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, orgId, event.ticketId, touch.id, actionId, event.stageChangeAt,
             valuation.value, valuation.value, valuation.source, valuation.basis, outcomeId);
    } catch (e: any) {
      if (e?.code === "SQLITE_CONSTRAINT_UNIQUE") {
        return { attributed: false, ticketId: event.ticketId, reason: "already_attributed", touchId: touch.id, actionId };
      }
      throw e;
    }

    try {
      logAuthEvent(orgId, null, touch.contactId, "RUNTIME_SALES_RECOVERY_ATTRIBUTED", {
        ticketId: event.ticketId, touchId: touch.id, actionId,
        stageChangeAt: event.stageChangeAt,
        ticketValue: valuation.value, source: valuation.source, basis: valuation.basis,
        outcomeId,
      });
    } catch { /* noop */ }

    return {
      attributed: true, ticketId: event.ticketId, actionId, touchId: touch.id,
      ticketValue: valuation.value, source: valuation.source, basis: valuation.basis,
    };
  }

  /**
   * Calcula valor do ticket com precedência clara. Public pra testes.
   */
  static computeTicketValue(orgId: string, ticketId: string): { value: number; source: "orders" | "quotes" | "contacts_avg_ticket" | "zero"; basis: "fact" | "estimate" } {
    // (1) Soma orders pagos amarrados ao ticket — fato.
    const placeholders = PAID_ORDER_STATUSES.map(() => "?").join(",");
    const orderRow = db.prepare(`
      SELECT COALESCE(SUM(total_amount), 0) AS total
        FROM orders
       WHERE organization_id = ? AND ticket_id = ? AND status IN (${placeholders})
    `).get(orgId, ticketId, ...PAID_ORDER_STATUSES) as any;
    const orderTotal = Number(orderRow?.total || 0);
    if (orderTotal > 0) return { value: orderTotal, source: "orders", basis: "fact" };

    // (2) Quote aceito — estimativa (venda proposta mas não concretizada
    // como pedido ainda; muitas orgs ganham na fase de proposta).
    const quoteRow = db.prepare(`
      SELECT total_amount FROM quotes
       WHERE organization_id = ? AND ticket_id = ? AND status = 'accepted'
       ORDER BY accepted_at DESC LIMIT 1
    `).get(orgId, ticketId) as any;
    if (quoteRow?.total_amount != null) {
      const qv = Number(quoteRow.total_amount);
      if (qv > 0) return { value: qv, source: "quotes", basis: "estimate" };
    }

    // (3) Fallback: avg_ticket do contato.
    const contactRow = db.prepare(`
      SELECT c.avg_ticket FROM contacts c JOIN tickets t ON t.contact_id = c.id AND t.organization_id = c.organization_id
       WHERE t.organization_id = ? AND t.id = ? LIMIT 1
    `).get(orgId, ticketId) as any;
    if (contactRow?.avg_ticket != null) {
      const av = Number(contactRow.avg_ticket);
      if (av > 0) return { value: av, source: "contacts_avg_ticket", basis: "estimate" };
    }

    return { value: 0, source: "zero", basis: "estimate" };
  }
}

export default SalesRecoveryAttributionService;
