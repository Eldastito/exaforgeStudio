import db from "./db.js";
import { BusinessSignalService } from "./BusinessSignalService.js";

/**
 * ProductOpportunityService — Inventory/Product Opportunity (PRD 11 / ADR-168 F11).
 *
 * Cruza CATÁLOGO × ESTOQUE × CUSTO × DESEMPENHO pra achar o produto que MERECE conteúdo:
 * em ESTOQUE, de ALTA MARGEM, mas VENDENDO POUCO. Publica a oportunidade na espinha canônica
 * (`business_signals`, D7/§37 — NUNCA tabela de alerta paralela), de onde flui pro Estúdio
 * (brief F8) e pra atenção.
 *
 * Margem = `price − avg_cost` (derivada de `products_services.price` + `inventory_items.avg_cost`).
 *
 * Guardrails:
 *  - RN-CG-06 — dinheiro role-gated: `candidates()` (rota owner/admin) devolve margem/custo
 *    ABSOLUTOS; o SINAL publicado só carrega o `marginBand` QUALITATIVO (high/medium) — sem R$.
 *  - RN-CG-03 — não inventa dinheiro: `impactAmount=null` no sinal (não promete receita).
 *  - RN-CG-09 / grounding — só produtos REAIS com estoque e custo conhecidos entram; sem
 *    custo (`avg_cost<=0`) a margem é desconhecida e o produto NÃO vira oportunidade.
 *  - `basis='hypothesis'` (PUBLISHED ≠ RESULTADO). Idempotente por `dedupe_key` do produto.
 *  - convenção nº 1 — isolamento por org.
 */

const PAID = ["pago", "em_preparo", "entregue", "concluido"];

export interface ProductCandidate {
  productId: string; name: string; price: number; avgCost: number;
  margin: number; marginPct: number; marginBand: "high" | "medium"; stock: number; recentSales: number;
}

function bandOf(marginPct: number): "high" | "medium" | null {
  if (marginPct >= 0.4) return "high";
  if (marginPct >= 0.2) return "medium";
  return null;
}

export class ProductOpportunityService {
  /**
   * Produtos candidatos a promoção: em estoque, alta margem, vendendo pouco. Read-only.
   * Devolve os números ABSOLUTOS (rota role-gated — RN-CG-06). `minMarginPct` default 0.2;
   * `weakSalesMax` default 1 (recentes ≤ isso = "não está vendendo"); janela default 30 dias.
   */
  static candidates(orgId: string, opts?: { minMarginPct?: number; weakSalesMax?: number; windowDays?: number; limit?: number }): ProductCandidate[] {
    const minMarginPct = opts?.minMarginPct ?? 0.2;
    const weakSalesMax = opts?.weakSalesMax ?? 1;
    const windowDays = Math.max(1, opts?.windowDays ?? 30);
    const limit = Math.max(1, Math.min(100, opts?.limit ?? 20));

    const rows = db.prepare(
      `SELECT p.id AS id, p.name AS name, p.price AS price,
              COALESCE(SUM(i.quantity_available),0) AS stock,
              MAX(COALESCE(i.avg_cost,0)) AS avg_cost
       FROM products_services p
       JOIN inventory_items i ON i.product_service_id = p.id AND i.organization_id = p.organization_id
       WHERE p.organization_id = ? AND COALESCE(p.active,1) = 1 AND p.type = 'product'
       GROUP BY p.id
       HAVING stock > 0`
    ).all(orgId) as any[];

    const out: ProductCandidate[] = [];
    for (const r of rows) {
      const price = Number(r.price) || 0;
      const avgCost = Number(r.avg_cost) || 0;
      // Grounding (RN-CG-09): sem custo conhecido a margem é desconhecida → não é candidato.
      if (price <= 0 || avgCost <= 0) continue;
      const margin = Math.round((price - avgCost) * 100) / 100;
      const marginPct = margin / price;
      const band = bandOf(marginPct);
      if (!band || marginPct < minMarginPct || margin <= 0) continue;

      const sales = db.prepare(
        `SELECT COUNT(*) AS n FROM order_items oi
         JOIN orders o ON o.id = oi.order_id AND o.organization_id = oi.organization_id
         WHERE oi.organization_id = ? AND oi.product_service_id = ?
           AND o.status IN (${PAID.map(() => "?").join(",")})
           AND o.created_at >= datetime('now', ?)`
      ).get(orgId, r.id, ...PAID, `-${windowDays} days`) as any;
      const recentSales = Number(sales?.n || 0);
      if (recentSales > weakSalesMax) continue; // está vendendo → não é oportunidade

      out.push({ productId: r.id, name: r.name, price, avgCost, margin, marginPct: Math.round(marginPct * 100) / 100, marginBand: band, stock: Number(r.stock), recentSales });
    }
    // Ranqueia por (margem% desc, estoque desc) — mais margem parada primeiro.
    out.sort((a, b) => (b.marginPct - a.marginPct) || (b.stock - a.stock));
    return out.slice(0, limit);
  }

  /**
   * Publica oportunidades de produto na espinha (`business_signals`). O sinal NÃO carrega R$
   * (só `marginBand` qualitativo — RN-CG-06); `impactAmount=null` (RN-CG-03). Idempotente por
   * `dedupe_key`. Sem `publish` → só devolve os candidatos (dry-run).
   */
  static match(orgId: string, input?: { publish?: boolean; minMarginPct?: number; weakSalesMax?: number }): {
    matched: number; opportunities: Array<{ productId: string; name: string; marginBand: string; stock: number; signalId: string; correlationId: string }>;
  } {
    const cands = this.candidates(orgId, { minMarginPct: input?.minMarginPct, weakSalesMax: input?.weakSalesMax });
    const opportunities: Array<{ productId: string; name: string; marginBand: string; stock: number; signalId: string; correlationId: string }> = [];
    for (const c of cands) {
      const dedupeKey = `product_opportunity:${c.productId}`;
      if (!input?.publish) { opportunities.push({ productId: c.productId, name: c.name, marginBand: c.marginBand, stock: c.stock, signalId: "", correlationId: "" }); continue; }
      const pub = BusinessSignalService.publish(orgId, {
        domain: "social",
        signalType: "product_opportunity",
        severity: "attention",
        basis: "hypothesis",
        confidence: c.marginBand === "high" ? 0.6 : 0.5,
        impactAmount: null,               // NUNCA inventa receita (RN-CG-03)
        sourceService: "ProductOpportunityService",
        subjectType: "product",
        subjectId: c.productId,
        dedupeKey,
        evidence: {
          productId: c.productId, productName: c.name, marginBand: c.marginBand,   // só QUALITATIVO (RN-CG-06)
          stock: c.stock, recentSales: c.recentSales,
          note: `Produto de margem ${c.marginBand === "high" ? "alta" : "boa"} em estoque e vendendo pouco: "${c.name}". Vale um conteúdo.`,
        },
      });
      opportunities.push({ productId: c.productId, name: c.name, marginBand: c.marginBand, stock: c.stock, signalId: pub.id, correlationId: pub.correlationId });
    }
    return { matched: opportunities.length, opportunities };
  }

  /** Passe do Scheduler: publica oportunidades de produto das orgs com catálogo+estoque. */
  static pass(): void {
    let orgs: any[] = [];
    try {
      orgs = db.prepare(
        `SELECT DISTINCT organization_id FROM inventory_items WHERE quantity_available > 0`
      ).all() as any[];
    } catch { return; }
    for (const o of orgs) {
      try { this.match(o.organization_id, { publish: true }); }
      catch (e: any) { console.error(`[ProductOpportunity] pass falhou (org ${o.organization_id})`, e?.message || e); }
    }
  }
}

export default ProductOpportunityService;
