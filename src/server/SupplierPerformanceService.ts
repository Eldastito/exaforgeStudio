import db from "./db.js";
import { randomUUID } from "crypto";

/**
 * SupplierPerformanceService (Epic 5 — Comprador IA, fatia E5.4).
 *
 * Fecha o Epic 5 medindo o fornecedor com números DETERMINÍSTICOS, a partir do
 * histórico que o ciclo já produziu (cotações → ordens → recebimentos):
 *   - preço escolhido × média das cotações (economia);
 *   - prazo prometido × realizado;
 *   - completude (recebido ÷ pedido);
 *   - divergências no recebimento;
 *   - taxa de resposta (respondidas ÷ enviadas).
 * A IA não entra aqui — é só agregação. Isolado por organization_id.
 */

const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
const pct = (n: number) => Math.round((Number(n) || 0) * 1000) / 10; // 1 casa

export interface SupplierRef { contactId?: string | null; networkOrgId?: string | null }

export class SupplierPerformanceService {
  private static keyOf(ref: SupplierRef): string { return ref.contactId ? String(ref.contactId) : `net:${ref.networkOrgId}`; }

  /** Métricas de um fornecedor (por contato local ou org da rede). */
  static metricsFor(orgId: string, ref: SupplierRef): any {
    const isNet = !ref.contactId && !!ref.networkOrgId;
    const qWhere = isNet ? "network_org_id = ?" : "supplier_contact_id = ?";
    const qVal = isNet ? ref.networkOrgId : ref.contactId;

    const quotes = db.prepare(`SELECT * FROM purchase_quotes WHERE organization_id = ? AND ${qWhere}`).all(orgId, qVal) as any[];
    const total = quotes.length;
    // "Respondeu" = deu resposta de fato (answered_at) ou ganhou; um 'sent'
    // auto-rejeitado quando outro venceu NÃO conta como resposta.
    const answered = quotes.filter((q) => q.answered_at || q.status === "answered" || q.status === "accepted").length;
    const won = quotes.filter((q) => q.status === "accepted");
    const responseRate = total > 0 ? pct(answered / total) : null;

    // Preço escolhido × média das cotações da MESMA requisição (só quando ganhou).
    // A média cobre todas as cotações que trouxeram preço (total_amount != null).
    let chosenSum = 0, avgSum = 0, priceReqs = 0;
    for (const w of won) {
      if (w.total_amount == null) continue;
      const others = db.prepare(`SELECT total_amount FROM purchase_quotes WHERE organization_id = ? AND requisition_id = ? AND total_amount IS NOT NULL`).all(orgId, w.requisition_id) as any[];
      if (others.length === 0) continue;
      const avg = others.reduce((s, o) => s + Number(o.total_amount), 0) / others.length;
      chosenSum += Number(w.total_amount); avgSum += avg; priceReqs++;
    }
    const priceVsAvgPct = avgSum > 0 ? pct(chosenSum / avgSum) : null; // <100% = mais barato que a média
    const savingsVsAvg = priceReqs > 0 ? round2(avgSum - chosenSum) : null;

    // Ordens do fornecedor + prazo prometido × realizado (só recebidas).
    const orders = db.prepare(`SELECT po.id, po.created_at, po.received_at, q.delivery_days AS promised
      FROM purchase_orders po JOIN purchase_quotes q ON q.id = po.quote_id AND q.organization_id = po.organization_id
      WHERE po.organization_id = ? AND po.${qWhere}`).all(orgId, qVal) as any[];
    let promisedSum = 0, realizedSum = 0, deliveryN = 0;
    for (const o of orders) {
      if (o.received_at == null || o.promised == null) continue;
      const realized = (db.prepare("SELECT CAST(julianday(?) - julianday(?) AS REAL) d").get(o.received_at, o.created_at) as any).d;
      promisedSum += Number(o.promised); realizedSum += Math.max(0, Number(realized) || 0); deliveryN++;
    }
    const promisedAvg = deliveryN > 0 ? round2(promisedSum / deliveryN) : null;
    const realizedAvg = deliveryN > 0 ? round2(realizedSum / deliveryN) : null;
    const onTime = deliveryN > 0 ? realizedAvg! <= promisedAvg! : null;

    // Completude: recebido ÷ pedido (sobre os itens das ordens do fornecedor).
    const comp = db.prepare(`SELECT COALESCE(SUM(poi.ordered_qty),0) o, COALESCE(SUM(poi.received_qty),0) r
      FROM purchase_order_items poi JOIN purchase_orders po ON po.id = poi.purchase_order_id AND po.organization_id = poi.organization_id
      WHERE po.organization_id = ? AND po.${qWhere}`).get(orgId, qVal) as any;
    const completeness = comp.o > 0 ? pct(comp.r / comp.o) : null;

    // Divergências no recebimento das ordens do fornecedor.
    const divergences = (db.prepare(`SELECT COUNT(*) n FROM goods_receipt_items gri
      JOIN goods_receipts gr ON gr.id = gri.goods_receipt_id AND gr.organization_id = gri.organization_id
      JOIN purchase_orders po ON po.id = gr.purchase_order_id AND po.organization_id = gr.organization_id
      WHERE gri.organization_id = ? AND po.${qWhere} AND gri.divergence IS NOT NULL`).get(orgId, qVal) as any).n;

    return {
      supplierKey: this.keyOf(ref),
      quotes: { sent: total, answered, won: won.length, responseRate },
      price: { chosen: round2(chosenSum), avgOfQuotes: round2(avgSum), priceVsAvgPct, savingsVsAvg, comparedRequisitions: priceReqs },
      delivery: { promisedAvgDays: promisedAvg, realizedAvgDays: realizedAvg, onTime, measuredOrders: deliveryN },
      fulfillment: { orderedQty: comp.o, receivedQty: comp.r, completenessPct: completeness },
      divergences,
    };
  }

  /** Ranking de todos os fornecedores com histórico de cotação (locais + rede). */
  static ranking(orgId: string): any[] {
    const rows = db.prepare(`SELECT DISTINCT supplier_contact_id, network_org_id FROM purchase_quotes WHERE organization_id = ?`).all(orgId) as any[];
    const out = rows.map((r) => {
      const ref: SupplierRef = r.supplier_contact_id ? { contactId: r.supplier_contact_id } : { networkOrgId: r.network_org_id };
      const name = r.supplier_contact_id
        ? (db.prepare("SELECT name FROM contacts WHERE id = ?").get(r.supplier_contact_id) as any)?.name || "Fornecedor"
        : (db.prepare("SELECT business_name FROM organization_settings WHERE organization_id = ?").get(r.network_org_id) as any)?.business_name || "Fornecedor da rede";
      return { supplierName: name, ...this.metricsFor(orgId, ref) };
    });
    // Ordena por confiabilidade: mais respostas, mais completo, menos divergência.
    return out.sort((a, b) => (b.quotes.responseRate || 0) - (a.quotes.responseRate || 0) || (b.fulfillment.completenessPct || 0) - (a.fulfillment.completenessPct || 0) || a.divergences - b.divergences);
  }

  /** Persiste um snapshot por fornecedor para o período (idempotente por UNIQUE). */
  static snapshot(orgId: string, period = "all"): number {
    const ranking = this.ranking(orgId);
    const up = db.prepare(`INSERT INTO supplier_performance_snapshots (id, organization_id, supplier_key, supplier_name, period, metrics_json)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(organization_id, supplier_key, period) DO UPDATE SET supplier_name = excluded.supplier_name, metrics_json = excluded.metrics_json, created_at = CURRENT_TIMESTAMP`);
    const tx = db.transaction(() => { for (const r of ranking) up.run(randomUUID(), orgId, r.supplierKey, r.supplierName, period, JSON.stringify(r)); });
    tx();
    return ranking.length;
  }
}

export default SupplierPerformanceService;
