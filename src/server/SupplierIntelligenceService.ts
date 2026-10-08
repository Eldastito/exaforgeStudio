import db from "./db.js";
import { SupplierPerformanceService } from "./SupplierPerformanceService.js";
import { todaySP } from "./spDate.js";

/**
 * SupplierIntelligenceService — ADR-205 F4.6: concentração de compras, histórico de prazo/entrega/preço por fornecedor e RASCUNHO de pauta de negociação.
 *
 * É COMPOSIÇÃO (RN-F4-11): entrega/completude/divergência vêm do `SupplierPerformanceService`; as ordens vêm de `purchase_orders`; o prazo de pagamento vem das
 * contas a pagar ligadas à ordem (`payables.source_purchase_order_id`). Nada de ERP novo, sem tabela nova, sem gravação.
 *
 * Regras (RN-F4):
 *  - COBERTURA primeiro (RN-F4-6): o sistema só enxerga compra feita pelo ciclo cotação→ordem. `coverage` mostra quanto das compras lançadas como conta a pagar NÃO está ligado a uma
 *    ordem — esse dinheiro está fora da concentração. Sem isso o gráfico mentiria pra menos. Os dois lados vazios → `null`, não 100%.
 *  - Concentração é INFORMAÇÃO, não conselho: parcela do maior fornecedor, índice HHI e faixa (limiares 30%/50% DECLARADOS, sem calibração). Nunca "troque de fornecedor".
 *  - Valor sem preço (ordem com total ≤ 0) fica fora das parcelas e é contado à parte (null ≠ 0). Fornecedor não identificado vira "não identificado", não some.
 *  - Pauta de negociação = RASCUNHO com evidência por ponto, só FATOS que o histórico sustenta e só com amostra mínima (≥2 ordens). Não inventa desconto, prazo-alvo nem contraproposta,
 *    não afirma que o fornecedor errou (correlação ≠ causa, RN-F4-8) e NUNCA contata o fornecedor (RN-F4-1/2): quem negocia é uma pessoa.
 *  - Dinheiro é do gestor (rota gated, §73). Read-only e isolado por organização.
 */
export const MIN_ORDERS = 2;
export const CONC_MEDIUM_PCT = 30;
export const CONC_HIGH_PCT = 50;
const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
const bad = (code: string, message: string) => Object.assign(new Error(message), { code });
const isDate = (s: any) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));
const brl = (n: number) => `R$ ${round2(n).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const keyOf = (r: { supplier_contact_id?: string | null; network_org_id?: string | null }) => (r.supplier_contact_id ? String(r.supplier_contact_id) : r.network_org_id ? `net:${r.network_org_id}` : "unknown");
const refOf = (key: string) => (key.startsWith("net:") ? { networkOrgId: key.slice(4) } : { contactId: key });

function period(opts: { from?: string; to?: string }) {
  const to = opts.to ?? todaySP();
  let from = opts.from;
  if (!from) { const d = new Date(to + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() - 180); from = d.toISOString().slice(0, 10); }
  if (!isDate(from) || !isDate(to)) throw bad("invalid_period", "Período inválido (use AAAA-MM-DD).");
  if (from > to) throw bad("invalid_period", "A data inicial não pode ser maior que a final.");
  return { from, to };
}
const supplierName = (orgId: string, key: string, snapshot?: string | null) => {
  if (snapshot) return snapshot;
  if (key === "unknown") return "Fornecedor não identificado";
  try {
    if (key.startsWith("net:")) return (db.prepare("SELECT business_name FROM organization_settings WHERE organization_id = ?").get(key.slice(4)) as any)?.business_name || "Fornecedor da rede";
    return (db.prepare("SELECT name FROM contacts WHERE organization_id = ? AND id = ?").get(orgId, key) as any)?.name || "Fornecedor";
  } catch { return "Fornecedor"; }
};

export class SupplierIntelligenceService {
  /** Parcela de cada fornecedor nas compras do período + o quanto da compra o sistema NÃO enxerga. */
  static concentration(orgId: string, opts: { from?: string; to?: string } = {}) {
    const { from, to } = period(opts);
    const rows = db.prepare(
      `SELECT supplier_contact_id, network_org_id, MAX(supplier_name) AS name, COUNT(*) AS orders,
              COALESCE(SUM(CASE WHEN total_amount > 0 THEN total_amount END), 0) AS spend, SUM(CASE WHEN total_amount > 0 THEN 1 ELSE 0 END) AS priced
         FROM purchase_orders WHERE organization_id = ? AND status != 'cancelled' AND date(created_at) >= ? AND date(created_at) <= ?
        GROUP BY supplier_contact_id, network_org_id`
    ).all(orgId, from, to) as any[];
    const total = round2(rows.reduce((a, r) => a + r.spend, 0));
    const unpricedOrders = rows.reduce((a, r) => a + (r.orders - r.priced), 0);
    const suppliers = rows.filter((r) => r.spend > 0).map((r) => {
      const key = keyOf(r);
      return { supplierKey: key, supplierName: supplierName(orgId, key, r.name), orders: r.priced, spend: round2(r.spend), sharePct: total > 0 ? round2((r.spend / total) * 100) : null };
    }).sort((a, b) => b.spend - a.spend);
    const hhi = total > 0 ? Math.round(suppliers.reduce((a, s) => a + Math.pow((s.sharePct as number) / 100, 2), 0) * 10000) : null;
    const top = suppliers[0] ?? null;
    let band: string | null = null;
    if (suppliers.length === 1) band = "single_supplier";
    else if (top && top.sharePct != null) band = top.sharePct >= CONC_HIGH_PCT ? "high" : top.sharePct >= CONC_MEDIUM_PCT ? "medium" : "low";

    // Cobertura: contas a pagar de compra de mercadoria que NÃO nasceram de uma ordem do sistema.
    const unlinked = db.prepare(
      `SELECT COALESCE(SUM(amount), 0) AS s, COUNT(*) AS n FROM payables WHERE organization_id = ? AND LOWER(COALESCE(category, '')) = 'compras'
          AND source_purchase_order_id IS NULL AND status != 'canceled' AND due_date >= ? AND due_date <= ?`
    ).get(orgId, from, to) as any;
    const unlinkedAmount = round2(unlinked.s);
    const coverageBase = total + unlinkedAmount;
    const coverage = { orderSpend: total, purchasePayablesWithoutOrder: unlinkedAmount, payablesWithoutOrderCount: unlinked.n, orderCoveragePct: coverageBase > 0 ? round2((total / coverageBase) * 100) : null };

    const caveats = [
      "Concentração é informação, não conselho: ter um fornecedor grande pode ser uma boa escolha. O sistema não recomenda trocar de fornecedor.",
      `Faixas de concentração (maior fornecedor ≥ ${CONC_MEDIUM_PCT}% = média, ≥ ${CONC_HIGH_PCT}% = alta) são limiares declarados, sem calibração com a sua operação.`,
      "Só entram compras feitas pelo ciclo cotação → ordem do sistema. Compra por fora (WhatsApp, balcão, outro ERP) não aparece aqui.",
    ];
    if (coverage.orderCoveragePct != null && coverage.orderCoveragePct < 70) caveats.push(`Atenção: só ${coverage.orderCoveragePct}% das compras lançadas passam por ordem — a concentração acima mostra uma parte pequena do que você compra.`);
    if (coverage.orderCoveragePct == null) caveats.push("Sem ordens de compra nem contas a pagar de compras no período: não há o que medir.");
    if (unpricedOrders > 0) caveats.push(`${unpricedOrders} ordem(ns) sem valor informado ficaram fora das parcelas.`);
    return { type: "supplier_concentration" as const, isForecast: false, executes: false, from, to, totalSpend: total > 0 ? total : null, suppliers, topSharePct: top?.sharePct ?? null, hhi, band, unpricedOrders, coverage, caveats };
  }

  /** Ficha de um fornecedor: entrega/completude (reuso), prazo de pagamento e variação de preço — cada número com o tamanho da amostra. */
  static supplier(orgId: string, key: string, opts: { from?: string; to?: string } = {}) {
    const { from, to } = period(opts);
    if (!key || key === "unknown") throw bad("invalid_supplier", "Fornecedor não identificado não tem ficha.");
    const isNet = key.startsWith("net:");
    const col = isNet ? "network_org_id" : "supplier_contact_id", val = isNet ? key.slice(4) : key;
    const orders = db.prepare(`SELECT COUNT(*) n, MAX(supplier_name) name FROM purchase_orders WHERE organization_id = ? AND ${col} = ? AND status != 'cancelled' AND date(created_at) >= ? AND date(created_at) <= ?`).get(orgId, val, from, to) as any;
    if (!orders.n) throw bad("not_found", "Esse fornecedor não tem ordens no período.");

    const perf = SupplierPerformanceService.metricsFor(orgId, refOf(key));
    const pay = db.prepare(
      `SELECT COUNT(*) n, AVG(julianday(p.due_date) - julianday(date(po.created_at))) AS avg_days
         FROM payables p JOIN purchase_orders po ON po.id = p.source_purchase_order_id AND po.organization_id = p.organization_id
        WHERE p.organization_id = ? AND po.${col} = ? AND p.status != 'canceled' AND date(po.created_at) >= ? AND date(po.created_at) <= ?`
    ).get(orgId, val, from, to) as any;
    const paymentTerm = { orders: pay.n, avgDays: pay.n >= 1 && pay.avg_days != null ? Math.round(pay.avg_days) : null };

    // Variação de preço: mesmo produto, primeira × última compra do período neste fornecedor.
    const items = db.prepare(
      `SELECT poi.product_service_id AS pid, COALESCE(MAX(poi.product_name), '') AS pname, poi.unit_price AS price, po.created_at AS at
         FROM purchase_order_items poi JOIN purchase_orders po ON po.id = poi.purchase_order_id AND po.organization_id = poi.organization_id
        WHERE poi.organization_id = ? AND po.${col} = ? AND po.status != 'cancelled' AND poi.unit_price > 0 AND date(po.created_at) >= ? AND date(po.created_at) <= ?
        GROUP BY poi.id ORDER BY po.created_at`
    ).all(orgId, val, from, to) as any[];
    const byProduct = new Map<string, any[]>();
    for (const it of items) { const l = byProduct.get(it.pid) || []; l.push(it); byProduct.set(it.pid, l); }
    const priceChanges = [...byProduct.values()].filter((l) => l.length >= 2).map((l) => {
      const a = l[0], b = l[l.length - 1];
      return { productId: a.pid, productName: a.pname || b.pname || null, firstPrice: round2(a.price), lastPrice: round2(b.price), purchases: l.length, variationPct: round2(((b.price - a.price) / a.price) * 100) };
    }).sort((x, y) => y.variationPct - x.variationPct).slice(0, 10);

    const smallest = Math.min(orders.n, perf.delivery.measuredOrders || orders.n);
    return {
      type: "supplier_profile" as const, isForecast: false, executes: false, from, to, supplierKey: key, supplierName: supplierName(orgId, key, orders.name), orders: orders.n,
      delivery: perf.delivery, fulfillment: perf.fulfillment, divergences: perf.divergences, quotes: perf.quotes, price: perf.price, paymentTerm, priceChanges,
      confidence: { level: orders.n >= 3 && smallest >= 3 ? ("media" as const) : ("baixa" as const), reasons: [`${orders.n} ordem(ns) no período${orders.n < 3 ? " — amostra pequena" : ""}.`] },
      caveats: ["Cada número vem do histórico do sistema e mostra quantas ordens o sustentam; com poucas ordens, não conclua nada.", "Variação de preço compara a primeira e a última compra do mesmo produto no período; não separa reajuste de mudança de especificação."],
    };
  }

  /** Visão geral: concentração + ficha de cada fornecedor com ordens. */
  static overview(orgId: string, opts: { from?: string; to?: string } = {}) {
    const conc = this.concentration(orgId, opts);
    const cards = conc.suppliers.map((s) => { try { return this.supplier(orgId, s.supplierKey, opts); } catch { return null; } }).filter(Boolean);
    return { type: "supplier_overview" as const, isForecast: false, executes: false, concentration: conc, suppliers: cards };
  }

  /** RASCUNHO de pauta de negociação — fatos com evidência. Não inventa desconto, prazo-alvo nem contraproposta e não contata o fornecedor. */
  static negotiationBrief(orgId: string, key: string, opts: { from?: string; to?: string } = {}) {
    const p = this.supplier(orgId, key, opts);
    const conc = this.concentration(orgId, opts);
    const share = conc.suppliers.find((s) => s.supplierKey === key) ?? null;
    const points: Array<{ topic: string; evidence: string; sampleSize: number; suggestedAsk: string }> = [];
    const omitted: string[] = [];
    const enough = (n: number, what: string) => { if (n >= MIN_ORDERS) return true; omitted.push(`${what}: só ${n} ordem(ns) — amostra insuficiente (mínimo ${MIN_ORDERS}).`); return false; };

    const d = p.delivery;
    if (d.measuredOrders > 0 && enough(d.measuredOrders, "Prazo de entrega") && d.promisedAvgDays != null && d.realizedAvgDays != null && d.realizedAvgDays > d.promisedAvgDays)
      points.push({ topic: "Prazo de entrega", evidence: `Prazo médio realizado de ${d.realizedAvgDays} dias contra ${d.promisedAvgDays} prometidos (${d.measuredOrders} ordens recebidas).`, sampleSize: d.measuredOrders, suggestedAsk: "Combinar como o prazo prometido passa a ser cumprido." });
    const f = p.fulfillment;
    if (f.completenessPct != null && f.orderedQty > 0 && f.completenessPct < 100 && enough(p.orders, "Completude do pedido"))
      points.push({ topic: "Completude", evidence: `Recebido ${f.completenessPct}% do que foi pedido (${f.receivedQty} de ${f.orderedQty} unidades).`, sampleSize: p.orders, suggestedAsk: "Entender a causa das faltas e como serão repostas." });
    if (p.divergences > 0 && enough(p.orders, "Divergências no recebimento"))
      points.push({ topic: "Divergências no recebimento", evidence: `${p.divergences} item(ns) com divergência registrada no recebimento.`, sampleSize: p.orders, suggestedAsk: "Revisar o processo de separação/conferência para reduzir divergências." });
    const worst = p.priceChanges.filter((c) => c.variationPct > 0).slice(0, 3);
    if (worst.length) points.push({ topic: "Variação de preço", evidence: worst.map((c) => `${c.productName || "Produto"}: ${brl(c.firstPrice)} → ${brl(c.lastPrice)} (${c.variationPct > 0 ? "+" : ""}${c.variationPct}%, ${c.purchases} compras)`).join("; ") + ".", sampleSize: worst.reduce((a, c) => a + c.purchases, 0), suggestedAsk: "Pedir a justificativa dos reajustes e se há tabela vigente por volume." });
    if (share && share.sharePct != null && share.sharePct >= CONC_MEDIUM_PCT)
      points.push({ topic: "Volume de compra", evidence: `Este fornecedor representa ${share.sharePct}% do valor comprado por ordem no período (${brl(share.spend)} em ${share.orders} ordem(ns)).`, sampleSize: share.orders, suggestedAsk: "Discutir condições compatíveis com o volume." });
    if (p.paymentTerm.avgDays != null && enough(p.paymentTerm.orders, "Prazo de pagamento"))
      points.push({ topic: "Prazo de pagamento", evidence: `Prazo médio de pagamento hoje: ${p.paymentTerm.avgDays} dias (${p.paymentTerm.orders} ordens com conta a pagar).`, sampleSize: p.paymentTerm.orders, suggestedAsk: "Avaliar se há espaço para um prazo maior." });
    const positives: string[] = [];
    if (d.onTime === true && d.measuredOrders >= MIN_ORDERS) positives.push(`entregas dentro do prazo (${d.measuredOrders} ordens)`);
    if (f.completenessPct === 100 && p.orders >= MIN_ORDERS) positives.push("pedidos recebidos completos");

    const body = points.length ? points.map((x, i) => `${i + 1}. ${x.topic}: ${x.evidence} → ${x.suggestedAsk}`).join("\n") : "";
    const draftMessage = points.length
      ? `RASCUNHO — não enviado. Revise antes de usar.\n\nFornecedor: ${p.supplierName}\nPeríodo: ${p.from} a ${p.to}\n\nPontos para conversar (com base no histórico do sistema):\n${body}${positives.length ? `\n\nReconhecer: ${positives.join(" e ")}.` : ""}\n\nValores, prazos-alvo e contrapropostas ficam por sua conta.`
      : null;
    return {
      type: "negotiation_brief" as const, isForecast: false, executes: false, sent: false, decisionOwner: "human" as const,
      supplierKey: key, supplierName: p.supplierName, from: p.from, to: p.to, ordersAnalyzed: p.orders,
      points, positives, omitted, draftMessage,
      status: points.length ? ("draft" as const) : ("insufficient_history" as const),
      confidence: p.confidence,
      caveats: [
        "É um rascunho: o sistema não envia nada ao fornecedor e não propõe desconto, prazo-alvo nem contraproposta — isso é uma decisão sua.",
        "Os fatos vêm do histórico do sistema; diferença não prova culpa do fornecedor (pode ser pedido urgente, mudança de item ou falha de lançamento).",
        ...(points.length ? [] : ["O histórico não sustenta nenhum ponto de negociação ainda (poucas ordens ou nada fora do esperado)."]),
      ],
    };
  }
}
export default SupplierIntelligenceService;
