import db from "./db.js";
import { BusinessSignalService } from "./BusinessSignalService.js";
import { RetailOnlineReserveService } from "./RetailOnlineReserveService.js";
import { RetailCommissionService } from "./RetailCommissionService.js";

/**
 * RetailOpsSignalPublisher — conecta as OPERAÇÕES de varejo (loja virtual,
 * reservas, vendas por produto) ao cérebro da plataforma (ADR-136).
 *
 * Deriva SINAIS tipados do que está acontecendo na operação e publica no
 * `business_signals` — de onde já fluem para o Pareto (o que atacar primeiro), o
 * Diretor IA (narra + sugere) e o briefing. É assim que a IA passa a ENTENDER a
 * operação e SUGERIR ação. Determinístico, idempotente por condição (dedupe sem
 * data), auto-resolve o que voltou ao normal. Sob demanda. Isolado por org.
 *
 * Sinais desta fatia:
 *  - `retail_online_reserve_out`: reserva da loja online esgotada num produto que
 *    está VENDENDO → risco de perder venda (ação: reabastecer a reserva).
 *  - `retail_product_no_online_sales`: produto com reserva mas SEM giro online na
 *    janela → capital reservado parado (ação: revisar vitrine/preço).
 */

const round2 = (n: any) => Math.round((Number(n) || 0) * 100) / 100;
function daysBefore(dateISO: string, days: number): string {
  const d = new Date(`${dateISO}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

export class RetailOpsSignalPublisher {
  static run(orgId: string, opts: { asOf?: string; windowDays?: number } = {}): { published: number; resolved: number; reserves: number } {
    const asOf = /^\d{4}-\d{2}-\d{2}$/.test(String(opts.asOf || "")) ? opts.asOf! : new Date().toISOString().slice(0, 10);
    const windowDays = Math.max(1, Number(opts.windowDays || 30));
    const start = daysBefore(asOf, windowDays);

    const soldByProduct = new Map<string, { sales: number; orders: number }>();
    for (const p of RetailCommissionService.onlineSalesByProduct(orgId, start, asOf)) soldByProduct.set(p.productId, { sales: p.sales, orders: p.orders });

    const reserves = RetailOnlineReserveService.listReserves(orgId);
    const current = new Set<string>();
    let published = 0;
    const pub = (s: any): void => {
      try { BusinessSignalService.publish(orgId, { basis: "fact", confidence: 1, sourceService: "RetailOpsSignalPublisher", sourceEntityType: "retail_online_reserve", ...s }); current.add(s.dedupeKey); published++; } catch { /* noop */ }
    };

    for (const r of reserves) {
      const sold = soldByProduct.get(String(r.product_service_id));
      const available = Number(r.available);
      const reserved = Number(r.qty_reserved);
      if (available <= 0 && sold && sold.sales > 0) {
        pub({
          domain: "retail_ops", signalType: "retail_online_reserve_out", severity: "risk",
          impactAmount: round2(sold.sales), impactUnit: "BRL", sourceEntityId: r.id,
          evidence: { store: r.store_name, product: r.product_name, reserved, available, soldWindow: sold.sales, windowDays },
          dedupeKey: `retail_ops:reserve_out:${r.store_id}:${r.product_service_id}`,
        });
      } else if (reserved > 0 && (!sold || sold.sales <= 0)) {
        pub({
          domain: "sales", signalType: "retail_product_no_online_sales", severity: "attention",
          impactAmount: reserved, impactUnit: "units", sourceEntityId: r.id,
          evidence: { store: r.store_name, product: r.product_name, reserved, windowDays },
          dedupeKey: `retail_ops:no_online_sales:${r.store_id}:${r.product_service_id}`,
        });
      }
    }

    // Auto-resolve: sinais deste publicador que não valem mais (voltaram ao normal).
    let resolved = 0;
    const open = db.prepare("SELECT dedupe_key FROM business_signals WHERE organization_id = ? AND source_service = 'RetailOpsSignalPublisher' AND status = 'open'").all(orgId) as any[];
    for (const s of open) if (!current.has(s.dedupe_key)) { if (BusinessSignalService.resolveByDedupe(orgId, s.dedupe_key).ok) resolved++; }

    return { published, resolved, reserves: reserves.length };
  }
}

export default RetailOpsSignalPublisher;
