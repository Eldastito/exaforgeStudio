/**
 * Retail Pricing — Tela "Precificar" no varejo (ADR-083 E7, Fatia 3 de
 * "fechar a precificação de ponta a ponta").
 *
 * O gestor perguntou como precificar os produtos do varejo. Havia motor
 * (`suggestSalePrice`) e custo médio ponderado (`inventory_items.avg_cost`
 * populado por `invoice-scan/xml`), mas faltava a TELA pra revisar em lote:
 * ver custo × preço atual × preço sugerido, com semáforo de risco (venda
 * abaixo do custo, margem magra), e aplicar em batch os que fizer sentido.
 *
 * Este serviço:
 *   - `listProducts(orgId, {markup, period, limit})` — junta preço/custo/vendas
 *     do mês em uma tacada e devolve item por produto com sugestão + semáforo;
 *   - `applyBulk(orgId, userId, items)` — atualiza `price` em transação,
 *     registrando cada alteração em `ProductEditHistory` (ADR-033); nunca
 *     aborta o batch inteiro por uma linha ruim.
 *
 * Determinístico, zero-token, isolado por `organization_id`.
 */
import db from "./db.js";
import { suggestSalePrice } from "./pricing.js";
import { ProductEditHistoryService } from "./ProductEditHistoryService.js";
import { RetailAnalyticsCache } from "./RetailAnalyticsCache.js";

export type PricingItem = {
  productId: string;
  name: string;
  category: string | null;
  currentPrice: number;
  minPrice: number | null;
  avgCost: number;
  stockQty: number;
  unitsSoldMonth: number;
  revenueMonth: number;
  marginAmount: number | null;
  marginPercent: number | null;
  suggestedPrice: number;
  riskLevel: "loss" | "thin" | "ok";
  hasCost: boolean;
};

export type PricingList = {
  period: string;
  targetMarkup: number;
  defaultMarkup: number;
  items: PricingItem[];
};

export type BulkApplyInput = { productId: string; newPrice: number };
export type BulkApplyOutput = {
  appliedCount: number;
  skippedCount: number;
  failedCount: number;
  applied: { productId: string; oldPrice: number; newPrice: number }[];
  // Rejeições DETERMINÍSTICAS (não adianta repetir): invalid_price, not_found,
  // unchanged, missing_id.
  skipped: { productId: string; reason: string }[];
  // Falhas TRANSITÓRIAS (a UI oferece retry): erro de escrita ou a linha sumiu
  // entre ler e gravar (no_rows).
  failed: { productId: string; reason: string; message?: string }[];
};

const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

function clampMarkup(v: any, fallback: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(500, n));
}

export class RetailPricingService {
  /**
   * Lista produtos com custo × preço × sugestão + venda do mês. Ordenado por
   * receita descendente (produto que mais vende no topo — quem move a agulha
   * quando a gente ajusta o preço). Só produtos ativos do tipo 'product'.
   *
   * `avg_cost` é ORG-WIDE (inventory_items sem store_id) — o custo médio é
   * do produto, não da loja. Ver ADR-083 E6 pra detalhes.
   */
  static listProducts(
    orgId: string,
    opts: { markup?: number; period?: string; limit?: number } = {}
  ): PricingList {
    const ss = db
      .prepare(`SELECT default_markup_percent FROM storefront_settings WHERE organization_id = ?`)
      .get(orgId) as any;
    const defaultMarkup = clampMarkup(ss?.default_markup_percent, 40);
    const targetMarkup = opts.markup != null ? clampMarkup(opts.markup, defaultMarkup) : defaultMarkup;
    const period = String(opts.period || new Date().toISOString().slice(0, 7)).slice(0, 7);
    const limit = Math.max(1, Math.min(500, Number(opts.limit) || 200));

    // Venda do mês por produto, resolvendo ERP→catálogo. PERF-004 (escala): os
    // itens RESOLVIDOS (4A) agrupam pela coluna `product_service_id` (índice); o
    // prefixo LIKE roda SÓ no subconjunto NÃO resolvido (filtrado antes do join)
    // — nunca varre o catálogo por linha de venda. Ver a versão irmã do CMV em
    // RetailStoreCostService.monthlyCogsBreakdownAll.
    const rows = db
      .prepare(
        `SELECT
           ps.id AS product_id,
           ps.name,
           ps.category,
           ps.price AS current_price,
           ps.min_price,
           COALESCE(inv.avg_cost, 0) AS avg_cost,
           COALESCE(inv.quantity_available, 0) AS stock_qty,
           COALESCE(sales.units, 0) AS units_sold_month,
           COALESCE(sales.revenue, 0) AS revenue_month
         FROM products_services ps
         LEFT JOIN inventory_items inv
           ON inv.organization_id = ps.organization_id
          AND inv.product_service_id = ps.id
         LEFT JOIN (
           SELECT product_id, SUM(units) AS units, SUM(revenue) AS revenue FROM (
             SELECT i.product_service_id AS product_id, i.quantidade AS units, i.valor AS revenue
               FROM retail_pdv_sale_items i
              WHERE i.organization_id = ? AND substr(i.sale_date, 1, 7) = ?
                AND i.catalog_resolved_at IS NOT NULL AND i.product_service_id IS NOT NULL
             UNION ALL
             SELECT COALESCE(ps1.id, ps2.id) AS product_id, i.quantidade AS units, i.valor AS revenue
               FROM retail_pdv_sale_items i
               LEFT JOIN product_variants pv
                 ON pv.organization_id = i.organization_id
                AND (pv.external_ref = i.produto OR pv.sku = i.produto)
               LEFT JOIN products_services ps1 ON ps1.id = pv.product_service_id
               LEFT JOIN products_services ps2
                 ON ps2.organization_id = i.organization_id
                AND (ps2.external_ref = i.produto OR i.produto LIKE ps2.external_ref || '%')
              WHERE i.organization_id = ? AND substr(i.sale_date, 1, 7) = ?
                AND i.catalog_resolved_at IS NULL
           )
           WHERE product_id IS NOT NULL
           GROUP BY product_id
         ) sales ON sales.product_id = ps.id
         WHERE ps.organization_id = ? AND ps.type = 'product' AND ps.active = 1
         ORDER BY revenue_month DESC, ps.name ASC
         LIMIT ?`
      )
      .all(orgId, period, orgId, period, orgId, limit) as any[];

    const items: PricingItem[] = rows.map((r) => {
      const cost = Number(r.avg_cost) || 0;
      const current = Number(r.current_price) || 0;
      const suggested = suggestSalePrice(cost, targetMarkup);
      const marginAmount = cost > 0 ? round2(current - cost) : null;
      const marginPercent =
        cost > 0 && current > 0
          ? Math.round(((current - cost) / current) * 10000) / 100
          : null;
      // Semáforo de risco (E7a): perda quando o preço não cobre nem o custo;
      // margem "magra" (< 10%) sinaliza risco de virar prejuízo com qualquer
      // taxa/imposto que vier em cima (Fatia 1 dos custos variáveis).
      const riskLevel: PricingItem["riskLevel"] =
        marginAmount != null && marginAmount < 0
          ? "loss"
          : marginPercent != null && marginPercent < 10
          ? "thin"
          : "ok";
      return {
        productId: r.product_id,
        name: r.name,
        category: r.category ?? null,
        currentPrice: current,
        minPrice: r.min_price ?? null,
        avgCost: cost,
        stockQty: Number(r.stock_qty) || 0,
        unitsSoldMonth: Number(r.units_sold_month) || 0,
        revenueMonth: round2(r.revenue_month),
        marginAmount,
        marginPercent,
        suggestedPrice: suggested,
        riskLevel,
        hasCost: cost > 0,
      };
    });

    return { period, targetMarkup, defaultMarkup, items };
  }

  /**
   * Aplica preço novo em lote (E7b). Cada linha vira UPDATE isolado + registro
   * em `ProductEditHistory` (ADR-033, versionamento de decisão comercial).
   * Nunca aborta o batch por uma linha ruim: linhas inválidas (preço ≤ 0,
   * produto de outra org, mesmo preço) vão pra `skipped` com razão explícita.
   *
   * Limita a 500 linhas por chamada (mesma régua de UI); acima disso o caller
   * (rota) deve retornar 400 antes de invocar este método.
   */
  static applyBulk(
    orgId: string,
    userId: string,
    items: BulkApplyInput[]
  ): BulkApplyOutput {
    const applied: BulkApplyOutput["applied"] = [];
    const skipped: BulkApplyOutput["skipped"] = [];
    const failed: BulkApplyOutput["failed"] = [];
    if (!Array.isArray(items) || items.length === 0) {
      return { appliedCount: 0, skippedCount: 0, failedCount: 0, applied, skipped, failed };
    }
    const upd = db.prepare(
      `UPDATE products_services SET price = ? WHERE id = ? AND organization_id = ?`
    );
    const sel = db.prepare(
      `SELECT * FROM products_services WHERE id = ? AND organization_id = ?`
    );

    // PERF-008: aplicação em lote com resultado DETALHADO por item. Cada linha é
    // isolada (UPDATE é atômico por si) — uma linha que falhe NÃO aborta as
    // outras (sem tx de tudo-ou-nada). Rejeições determinísticas vão pra
    // `skipped`; falhas transitórias (erro de escrita / linha sumiu entre ler e
    // gravar) vão pra `failed`, que a UI oferece para RETRY. A UI só declara
    // sucesso pelos `applied`.
    for (const it of items) {
      const productId = String((it as any)?.productId || "");
      const newPrice = Number((it as any)?.newPrice);
      if (!productId) { skipped.push({ productId, reason: "missing_id" }); continue; }
      if (!(newPrice > 0) || !Number.isFinite(newPrice)) {
        skipped.push({ productId, reason: "invalid_price" }); continue;
      }
      try {
        const before = sel.get(productId, orgId) as any;
        if (!before) { skipped.push({ productId, reason: "not_found" }); continue; }
        const oldPrice = Number(before.price) || 0;
        if (Math.abs(newPrice - oldPrice) < 0.005) {
          skipped.push({ productId, reason: "unchanged" }); continue;
        }
        const info = upd.run(round2(newPrice), productId, orgId);
        if (!info.changes) { failed.push({ productId, reason: "no_rows" }); continue; } // sumiu entre ler e gravar → retryable
        try {
          ProductEditHistoryService.record(orgId, productId, userId, before, {
            price: round2(newPrice),
          });
        } catch { /* histórico é secundário; não derruba o item */ }
        applied.push({
          productId,
          oldPrice: round2(oldPrice),
          newPrice: round2(newPrice),
        });
      } catch (e: any) {
        failed.push({ productId, reason: "write_error", message: String(e?.message || e).slice(0, 200) });
      }
    }
    // PERF-005: preço aplicado muda o número das telas analíticas.
    if (applied.length) RetailAnalyticsCache.invalidate(orgId);
    return {
      appliedCount: applied.length,
      skippedCount: skipped.length,
      failedCount: failed.length,
      applied,
      skipped,
      failed,
    };
  }
}

export default RetailPricingService;
