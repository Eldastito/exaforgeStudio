import { randomUUID } from "node:crypto";
import db from "./db.js";

/**
 * ContentRevenueAttributionService — Lead→Sale→Revenue→Margin (PRD 11 / ADR-168 F8).
 *
 * Estende o fio da F7 (conteúdo→lead) até o DINHEIRO: pra cada lead atribuído a um conteúdo
 * (`content_lead_attributions`), resolve o valor da venda desse lead e registra em
 * `content_sale_attributions`. É AQUI que `ENGAGEMENT ≠ BUSINESS VALUE` fica completo — o
 * conteúdo passa a ter RECEITA e MARGEM atribuídas, não só likes.
 *
 * Precedência de valor (espelha `SalesRecoveryAttributionService`, §37 — mesmo modelo, sem
 * 2º mecanismo): `orders` pago → `fact` > `quotes` aceito → `estimate` >
 * `contacts.avg_ticket` → `estimate` > nenhum → NÃO atribui (RN-CG-03: sem prova, sem valor).
 * Margem = Σ(unit_price − unit_cost)·qty dos `order_items`; só é `fact` quando TODO custo é
 * conhecido (unit_cost > 0); senão `null` (não inventa lucro).
 *
 * Guardrails:
 *  - RN-CG-02 — pergunta ao system-of-record (orders/quotes), nunca à IA.
 *  - RN-CG-03 — nunca inventa dinheiro; `fact` e `estimate` NUNCA somados (reportados à parte).
 *  - RN-CG-06 — margem/custo/dinheiro role-gated (na rota).
 *  - convenção nº 1 — isolamento por org; UNIQUE evita dupla contagem.
 */

const PAID_STATUSES = new Set(["pago", "em_preparo", "entregue", "concluido"]);

export interface ContactValue {
  revenue: number | null; revenueBasis: "fact" | "estimate" | null;
  margin: number | null; marginBasis: "fact" | null;
  source: "orders" | "quotes" | "contacts_avg_ticket" | null; orderId: string | null;
}

export interface RevenueSummary {
  correlationId: string;
  revenueFact: number; revenueEstimate: number;   // NUNCA somados entre si (RN-CG-03)
  marginFact: number | null;                        // null se nenhum custo conhecido
  salesCount: number; leadsCount: number;
  attributions: Array<{ contactId: string; revenue: number | null; revenueBasis: string | null; margin: number | null; source: string | null }>;
}

export class ContentRevenueAttributionService {
  /** Resolve o valor de venda de UM contato por precedência (read-only, pergunta ao SoR). */
  static valueForContact(orgId: string, contactId: string): ContactValue {
    // 1. Pedido PAGO → fact (o dinheiro entrou).
    const order = db.prepare(
      `SELECT id, total_amount FROM orders WHERE organization_id = ? AND contact_id = ? AND status IN (${[...PAID_STATUSES].map(() => "?").join(",")})
       ORDER BY created_at DESC LIMIT 1`
    ).get(orgId, contactId, ...PAID_STATUSES) as any;
    if (order && Number(order.total_amount) > 0) {
      const margin = this.marginForOrder(orgId, order.id);
      return { revenue: Number(order.total_amount), revenueBasis: "fact", margin: margin.margin, marginBasis: margin.basis, source: "orders", orderId: order.id };
    }
    // 2. Orçamento ACEITO → estimate (prometido, não pago).
    const quote = db.prepare(
      `SELECT total_amount FROM quotes WHERE organization_id = ? AND contact_id = ? AND status = 'accepted'
       ORDER BY accepted_at DESC LIMIT 1`
    ).get(orgId, contactId) as any;
    if (quote && Number(quote.total_amount) > 0) {
      return { revenue: Number(quote.total_amount), revenueBasis: "estimate", margin: null, marginBasis: null, source: "quotes", orderId: null };
    }
    // 3. Ticket médio do contato → estimate (proxy fraco).
    const c = db.prepare(`SELECT avg_ticket FROM contacts WHERE organization_id = ? AND id = ?`).get(orgId, contactId) as any;
    if (c && Number(c.avg_ticket) > 0) {
      return { revenue: Number(c.avg_ticket), revenueBasis: "estimate", margin: null, marginBasis: null, source: "contacts_avg_ticket", orderId: null };
    }
    // 4. Sem prova de valor → não atribui (RN-CG-03).
    return { revenue: null, revenueBasis: null, margin: null, marginBasis: null, source: null, orderId: null };
  }

  /** Margem de um pedido: Σ(unit_price − unit_cost)·qty. Só `fact` se TODO custo é conhecido. */
  static marginForOrder(orgId: string, orderId: string): { margin: number | null; basis: "fact" | null } {
    const items = db.prepare(
      `SELECT unit_price, unit_cost, quantity FROM order_items WHERE order_id = ? AND organization_id = ?`
    ).all(orderId, orgId) as any[];
    if (!items.length) return { margin: null, basis: null };
    // Custo desconhecido (unit_cost <= 0) em QUALQUER item → margem incompleta (null, não inventa).
    if (items.some((i) => !(Number(i.unit_cost) > 0))) return { margin: null, basis: null };
    const margin = items.reduce((acc, i) => acc + (Number(i.unit_price) - Number(i.unit_cost)) * Number(i.quantity || 1), 0);
    return { margin: Math.round(margin * 100) / 100, basis: "fact" };
  }

  /**
   * Atribui a venda de cada lead do conteúdo (idempotente por lead). Só grava quando há valor
   * (RN-CG-03). Devolve o resumo agregado (fact/estimate separados).
   */
  static attributeLeads(orgId: string, correlationId: string): RevenueSummary {
    const leads = db.prepare(`SELECT contact_id FROM content_lead_attributions WHERE organization_id = ? AND correlation_id = ?`).all(orgId, correlationId) as any[];
    for (const l of leads) {
      const v = this.valueForContact(orgId, l.contact_id);
      if (v.revenue == null) continue; // sem prova de valor → não atribui
      db.prepare(
        `INSERT INTO content_sale_attributions (id, organization_id, correlation_id, contact_id, order_id, revenue, revenue_basis, margin, margin_basis, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(organization_id, correlation_id, contact_id) DO UPDATE SET
           order_id = excluded.order_id, revenue = excluded.revenue, revenue_basis = excluded.revenue_basis,
           margin = excluded.margin, margin_basis = excluded.margin_basis, source = excluded.source`
      ).run(randomUUID(), orgId, correlationId, l.contact_id, v.orderId, v.revenue, v.revenueBasis, v.margin, v.marginBasis, v.source);
    }
    return this.revenueFor(orgId, correlationId);
  }

  /** Resumo de receita/margem de um conteúdo. fact e estimate SEPARADOS (RN-CG-03). */
  static revenueFor(orgId: string, correlationId: string): RevenueSummary {
    const rows = db.prepare(
      `SELECT contact_id, revenue, revenue_basis, margin, margin_basis, source FROM content_sale_attributions WHERE organization_id = ? AND correlation_id = ?`
    ).all(orgId, correlationId) as any[];
    const leadsCount = Number((db.prepare(`SELECT COUNT(*) AS n FROM content_lead_attributions WHERE organization_id = ? AND correlation_id = ?`).get(orgId, correlationId) as any)?.n || 0);
    let revenueFact = 0, revenueEstimate = 0, marginFact = 0, marginKnown = false;
    for (const r of rows) {
      if (r.revenue_basis === "fact") revenueFact += Number(r.revenue || 0);
      else if (r.revenue_basis === "estimate") revenueEstimate += Number(r.revenue || 0);
      if (r.margin_basis === "fact" && r.margin != null) { marginFact += Number(r.margin); marginKnown = true; }
    }
    return {
      correlationId,
      revenueFact: Math.round(revenueFact * 100) / 100,
      revenueEstimate: Math.round(revenueEstimate * 100) / 100,
      marginFact: marginKnown ? Math.round(marginFact * 100) / 100 : null,
      salesCount: rows.length, leadsCount,
      attributions: rows.map((r) => ({ contactId: r.contact_id, revenue: r.revenue != null ? Number(r.revenue) : null, revenueBasis: r.revenue_basis ?? null, margin: r.margin != null ? Number(r.margin) : null, source: r.source ?? null })),
    };
  }
}

export default ContentRevenueAttributionService;
