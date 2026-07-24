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
 *  - `retail_sales_concentration`: um produto concentra ≥50% das vendas online →
 *    dependência (ação: diversificar o mix).
 *  - `retail_writeback_backlog`: muitas baixas online pendentes de lançar no PDV →
 *    estoque do ERP desatualizado (ação: lançar as baixas).
 *  - `retail_seller_below_quota`: vendedor abaixo da meta das regras de comissão
 *    (ação: acompanhar).
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

    const byProduct = RetailCommissionService.onlineSalesByProduct(orgId, start, asOf);
    const soldByProduct = new Map<string, { sales: number; orders: number }>();
    for (const p of byProduct) soldByProduct.set(p.productId, { sales: p.sales, orders: p.orders });

    const reserves = RetailOnlineReserveService.listReserves(orgId);
    const current = new Set<string>();
    let published = 0;
    const pub = (s: any): void => {
      try { BusinessSignalService.publish(orgId, { basis: "fact", confidence: 1, sourceService: "RetailOpsSignalPublisher", sourceEntityType: "retail_online_reserve", ...s }); current.add(s.dedupeKey); published++; } catch { /* noop */ }
    };

    for (const r of reserves) {
      const sold = soldByProduct.get(String(r.product_service_id));
      const selling = !!sold && sold.sales > 0;
      const available = Number(r.available);
      const reserved = Number(r.qty_reserved);
      const lowAt = Math.max(1, Math.ceil(reserved * 0.2)); // ≤20% da reserva = baixa
      if (selling && available <= 0) {
        pub({
          domain: "retail_ops", signalType: "retail_online_reserve_out", severity: "risk",
          impactAmount: round2(sold!.sales), impactUnit: "BRL", sourceEntityId: r.id,
          evidence: { store: r.store_name, product: r.product_name, reserved, available, soldWindow: sold!.sales, windowDays },
          dedupeKey: `retail_ops:reserve_out:${r.store_id}:${r.product_service_id}`,
        });
      } else if (selling && available <= lowAt) {
        pub({
          domain: "retail_ops", signalType: "retail_reserve_low", severity: "attention",
          impactAmount: round2(sold!.sales), impactUnit: "BRL", sourceEntityId: r.id,
          evidence: { store: r.store_name, product: r.product_name, reserved, available, soldWindow: sold!.sales, windowDays },
          dedupeKey: `retail_ops:reserve_low:${r.store_id}:${r.product_service_id}`,
        });
      } else if (reserved > 0 && !selling) {
        pub({
          domain: "sales", signalType: "retail_product_no_online_sales", severity: "attention",
          impactAmount: reserved, impactUnit: "units", sourceEntityId: r.id,
          evidence: { store: r.store_name, product: r.product_name, reserved, windowDays },
          dedupeKey: `retail_ops:no_online_sales:${r.store_id}:${r.product_service_id}`,
        });
      }
    }

    // Ruptura ativa: loja com muitos alertas de estoque negativo abertos agora.
    const stockouts = db.prepare("SELECT store_id, COUNT(*) AS n FROM retail_stock_alerts WHERE organization_id = ? AND alert_type = 'negative_stock' AND status = 'open' AND store_id IS NOT NULL GROUP BY store_id").all(orgId) as any[];
    for (const so of stockouts) {
      if (Number(so.n) < 3) continue;
      const storeName = (db.prepare("SELECT name FROM retail_stores WHERE id = ? AND organization_id = ?").get(so.store_id, orgId) as any)?.name || "loja";
      pub({
        domain: "inventory", signalType: "retail_store_stockout", severity: "risk",
        impactAmount: Number(so.n), impactUnit: "units", sourceEntityType: "retail_store", sourceEntityId: so.store_id,
        evidence: { store: storeName, alerts: Number(so.n) }, dedupeKey: `retail_ops:stockout:${so.store_id}`,
      });
    }

    // Concentração de vendas: um produto ≥ 50% do total online (dependência).
    const totalSales = round2(byProduct.reduce((a, p) => a + p.sales, 0));
    if (byProduct.length >= 2 && totalSales > 0) {
      const top = byProduct.reduce((a, p) => (p.sales > a.sales ? p : a));
      const pct = top.sales / totalSales;
      if (pct >= 0.5) {
        pub({
          domain: "sales", signalType: "retail_sales_concentration", severity: "attention",
          impactAmount: round2(top.sales), impactUnit: "BRL", sourceEntityType: "product", sourceEntityId: top.productId,
          evidence: { product: top.productName, pct: round2(pct * 100), totalSales, windowDays },
          dedupeKey: `retail_ops:sales_concentration`,
        });
      }
    }

    // Baixas online pendentes acumuladas (estoque do PDV desatualizado).
    const pendingCount = RetailOnlineReserveService.listPending(orgId).length;
    if (pendingCount >= 5) {
      pub({
        domain: "retail_ops", signalType: "retail_writeback_backlog", severity: "attention",
        impactAmount: pendingCount, impactUnit: "units", sourceEntityType: "retail_online_writeback", sourceEntityId: null,
        evidence: { pending: pendingCount }, dedupeKey: `retail_ops:writeback_backlog`,
      });
    }

    const sellers = RetailCommissionService.onlineSalesBySeller(orgId, start, asOf);

    // Vendedor abaixo da meta (das regras de comissão por vendedor com meta).
    const quotaRules = db.prepare("SELECT config_json FROM retail_commission_rules WHERE organization_id = ? AND active = 1 AND scope = 'seller' AND calculation_type = 'quota_bonus'").all(orgId) as any[];
    let target = 0;
    for (const r of quotaRules) { try { const q = Number((JSON.parse(r.config_json || "{}") || {}).quota || 0); if (q > target) target = q; } catch { /* noop */ } }
    if (target > 0) {
      for (const s of sellers) {
        if (s.sales < target) {
          pub({
            domain: "retail_ops", signalType: "retail_seller_below_quota", severity: "attention",
            impactAmount: round2(target - s.sales), impactUnit: "BRL", sourceEntityType: "user", sourceEntityId: s.sellerUserId,
            evidence: { seller: s.sellerName, sales: s.sales, target, gap: round2(target - s.sales), windowDays },
            dedupeKey: `retail_ops:seller_below_quota:${s.sellerUserId}`,
          });
        }
      }
    }

    // Concentração de vendedor: um vendedor ≥ 70% das vendas → dependência.
    const totalSellerSales = round2(sellers.reduce((a, s) => a + s.sales, 0));
    if (sellers.length >= 2 && totalSellerSales > 0) {
      const top = sellers.reduce((a, s) => (s.sales > a.sales ? s : a));
      const pct = top.sales / totalSellerSales;
      if (pct >= 0.7) {
        pub({
          domain: "retail_ops", signalType: "retail_seller_concentration", severity: "attention",
          impactAmount: round2(top.sales), impactUnit: "BRL", sourceEntityType: "user", sourceEntityId: top.sellerUserId,
          evidence: { seller: top.sellerName, pct: round2(pct * 100), totalSales: totalSellerSales, windowDays },
          dedupeKey: `retail_ops:seller_concentration`,
        });
      }
    }

    // Auto-resolve: sinais deste publicador que não valem mais (voltaram ao normal).
    let resolved = 0;
    const open = db.prepare("SELECT dedupe_key FROM business_signals WHERE organization_id = ? AND source_service = 'RetailOpsSignalPublisher' AND status = 'open'").all(orgId) as any[];
    for (const s of open) if (!current.has(s.dedupe_key)) { if (BusinessSignalService.resolveByDedupe(orgId, s.dedupe_key).ok) resolved++; }

    return { published, resolved, reserves: reserves.length };
  }

  /** Sinais de varejo abertos (do publicador + padrões), do mais grave ao menos. */
  static topOpenSignals(orgId: string, limit = 3): Array<{ signalType: string; severity: string; impactAmount: number | null; impactUnit: string | null; evidence: any }> {
    const rows = db.prepare(
      `SELECT signal_type, severity, impact_amount, impact_unit, evidence_json
         FROM business_signals
        WHERE organization_id = ? AND status = 'open'
          AND source_service IN ('RetailOpsSignalPublisher','RetailPatternMemoryService')
        ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'risk' THEN 1 WHEN 'attention' THEN 2 ELSE 3 END, detected_at DESC
        LIMIT ?`
    ).all(orgId, Math.max(1, limit)) as any[];
    return rows.map((r) => ({ signalType: r.signal_type, severity: r.severity, impactAmount: r.impact_amount != null ? Number(r.impact_amount) : null, impactUnit: r.impact_unit || null, evidence: (() => { try { return JSON.parse(r.evidence_json || "{}"); } catch { return {}; } })() }));
  }

  /** Frase curta pt-BR de um sinal de varejo (para o briefing e o Diretor). */
  static describe(sig: { signalType: string; evidence: any }): string {
    const e = sig.evidence || {};
    switch (sig.signalType) {
      case "retail_online_reserve_out": return `Reserva online esgotada: ${e.product} (${e.store})`;
      case "retail_reserve_low": return `Reserva online baixa: ${e.product} (${e.store})`;
      case "retail_product_no_online_sales": return `Produto sem giro online: ${e.product}`;
      case "retail_sales_concentration": return `Vendas concentradas em ${e.product} (${e.pct}%)`;
      case "retail_writeback_backlog": return `${e.pending} baixas pendentes de lançar no PDV`;
      case "retail_seller_below_quota": return `${e.seller} abaixo da meta`;
      case "retail_seller_concentration": return `Vendas concentradas em ${e.seller} (${e.pct}%)`;
      case "retail_store_stockout": return `Ruptura ativa na ${e.store} (${e.alerts} itens negativos)`;
      default: return String(e.description || sig.signalType);
    }
  }
}

export default RetailOpsSignalPublisher;
