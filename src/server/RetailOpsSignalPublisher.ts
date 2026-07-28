import db from "./db.js";
import { BusinessSignalService } from "./BusinessSignalService.js";
import { RetailOnlineReserveService } from "./RetailOnlineReserveService.js";
import { RetailCommissionService } from "./RetailCommissionService.js";
import { RetailTransferService } from "./RetailTransferService.js";
import { haversineKm } from "./geo.js";

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

    // Reposição da GRADE (Fase G): loja com o produto porém ZERADA num tamanho/
    // cor que outra filial tem sobrando → a IA SUGERE a transferência. Exclui o
    // que já está em trânsito (não sugere de novo o que já está a caminho).
    // Limita para não inundar o Pareto — os maiores furos primeiro.
    const gradeFurada = db.prepare(`
      WITH carrier AS (
        SELECT rsi.store_id, rsi.product_service_id,
               SUM(CASE WHEN rsi.quantity_available > 0 THEN rsi.quantity_available ELSE 0 END) AS tot
          FROM retail_store_inventory rsi
          JOIN retail_stores s ON s.id = rsi.store_id AND s.active = 1
         WHERE rsi.organization_id = ?
         GROUP BY rsi.store_id, rsi.product_service_id
        HAVING tot > 0
      )
      SELECT p.name AS product_name, COALESCE(v.name, '—') AS variant_name, v.size, v.color,
             sn.name AS needy_store, sd.name AS donor_store, sd.code AS donor_code, d.quantity_available AS donor_qty,
             c.store_id AS needy_store_id, d.store_id AS donor_store_id, d.product_service_id, d.variant_id,
             sn.latitude AS needy_lat, sn.longitude AS needy_lng, sd.latitude AS donor_lat, sd.longitude AS donor_lng
        FROM retail_store_inventory d
        JOIN retail_stores sd ON sd.id = d.store_id AND sd.active = 1
        JOIN carrier c ON c.product_service_id = d.product_service_id AND c.store_id <> d.store_id
        JOIN retail_stores sn ON sn.id = c.store_id
        JOIN products_services p ON p.id = d.product_service_id
        LEFT JOIN product_variants v ON v.id = d.variant_id
        LEFT JOIN retail_store_inventory n ON n.store_id = c.store_id AND n.product_service_id = d.product_service_id AND COALESCE(n.variant_id, '') = COALESCE(d.variant_id, '')
       WHERE d.organization_id = ? AND d.quantity_available >= 2 AND d.variant_id IS NOT NULL AND d.variant_id <> ''
         AND COALESCE(n.quantity_available, 0) <= 0
         AND NOT EXISTS (
           SELECT 1 FROM retail_stock_transfers t
           JOIN retail_stock_transfer_items ti ON ti.transfer_id = t.id
           WHERE t.organization_id = d.organization_id AND t.status = 'in_transit'
             AND t.origin_store_id = d.store_id AND t.dest_store_id = c.store_id
             AND ti.product_service_id = d.product_service_id AND COALESCE(ti.variant_id, '') = COALESCE(d.variant_id, '')
         )
    `).all(orgId, orgId) as any[];
    // Fase 3: por FURO (loja+produto+variante), escolhe o doador MAIS PRÓXIMO
    // (menor distância haversine). Doadores sem coordenada ficam para o fim
    // (distância ∞), com desempate pela maior sobra. Uma sugestão por furo.
    const byFuro = new Map<string, any>();
    for (const g of gradeFurada) {
      const dist = haversineKm(g.needy_lat, g.needy_lng, g.donor_lat, g.donor_lng);
      const cand = { ...g, dist: Number.isFinite(dist) ? dist : Infinity };
      const key = `${g.needy_store_id}:${g.product_service_id}:${g.variant_id}`;
      const prev = byFuro.get(key);
      if (!prev || cand.dist < prev.dist || (cand.dist === prev.dist && Number(cand.donor_qty) > Number(prev.donor_qty))) byFuro.set(key, cand);
    }
    const chosen = Array.from(byFuro.values()).sort((a, b) => (a.dist - b.dist) || (Number(b.donor_qty) - Number(a.donor_qty))).slice(0, 15);
    for (const g of chosen) {
      const variantLabel = [g.size, g.color].filter(Boolean).join(" / ") || g.variant_name;
      const distanceKm = Number.isFinite(g.dist) ? g.dist : null;
      pub({
        domain: "inventory", signalType: "retail_transfer_suggested", severity: "attention",
        impactAmount: Number(g.donor_qty), impactUnit: "units", sourceEntityType: "retail_store", sourceEntityId: g.donor_store_id,
        evidence: {
          originStoreId: g.donor_store_id, originStore: g.donor_store,
          destStoreId: g.needy_store_id, destStore: g.needy_store,
          productId: g.product_service_id, product: g.product_name,
          variantId: g.variant_id, variant: variantLabel,
          donorQty: Number(g.donor_qty), quantitySuggested: 1,
          distanceKm, bestTime: RetailTransferService.suggestBestWindow(orgId, g.donor_code),
        },
        dedupeKey: `retail_ops:transfer:${g.donor_store_id}:${g.needy_store_id}:${g.product_service_id}:${g.variant_id}`,
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
}

export default RetailOpsSignalPublisher;
