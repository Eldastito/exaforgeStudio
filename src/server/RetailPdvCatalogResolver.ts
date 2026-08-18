/**
 * RetailPdvCatalogResolver — resolve o código de produto do ERP (`retail_pdv_sale_items.produto`)
 * para o catálogo (produto/variante), PERSISTINDO o resultado (PDR TOULON, Fatia 4 / PERF-001).
 *
 * Hoje "Resultado por loja" e "Mais vendidos" resolvem ERP→catálogo com LIKE-prefix
 * a CADA consulta (não-sargável, repetido no N+1). Aqui a resolução acontece UMA vez
 * (na ingestão + backfill) e vira coluna indexável.
 *
 * Match, na ordem (mesma lógica das queries existentes):
 *   1. variante por external_ref OU sku == produto  → exact
 *   2. produto por external_ref (ou ean) == produto → exact
 *   3. produto por prefixo: produto LIKE external_ref||'%' (external_ref >= 4) → prefix
 *   - mais de um candidato em qualquer nível → ambiguous (NÃO associa — RN)
 *   - nenhum → unmatched
 *
 * Determinístico; isolado por organization_id.
 */
import db from "./db.js";

export type CatalogMatch = { productServiceId: string | null; variantId: string | null; status: "exact" | "prefix" | "unmatched" | "ambiguous" };

export class RetailPdvCatalogResolver {
  /** Resolve UM código do ERP → catálogo. Não escreve nada. */
  static resolveCode(orgId: string, produto: string | null | undefined): CatalogMatch {
    const code = String(produto || "").trim();
    if (!code) return { productServiceId: null, variantId: null, status: "unmatched" };

    // 1. variante (grade) por external_ref ou sku.
    const v = db.prepare(
      `SELECT id, product_service_id FROM product_variants WHERE organization_id = ? AND (external_ref = ? OR sku = ?) AND active = 1 LIMIT 2`
    ).all(orgId, code, code) as any[];
    if (v.length === 1) return { productServiceId: v[0].product_service_id, variantId: v[0].id, status: "exact" };
    if (v.length > 1) return { productServiceId: null, variantId: null, status: "ambiguous" };

    // 2. produto por external_ref ou ean (exato).
    const p = db.prepare(
      `SELECT id FROM products_services WHERE organization_id = ? AND (external_ref = ? OR ean = ?) LIMIT 2`
    ).all(orgId, code, code) as any[];
    if (p.length === 1) return { productServiceId: p[0].id, variantId: null, status: "exact" };
    if (p.length > 1) return { productServiceId: null, variantId: null, status: "ambiguous" };

    // 3. produto por PREFIXO (external_ref é prefixo do código do ERP: EAN13 vs 12).
    const pref = db.prepare(
      `SELECT id FROM products_services WHERE organization_id = ? AND external_ref IS NOT NULL AND length(external_ref) >= 4 AND ? LIKE external_ref || '%' LIMIT 2`
    ).all(orgId, code) as any[];
    if (pref.length === 1) return { productServiceId: pref[0].id, variantId: null, status: "prefix" };
    if (pref.length > 1) return { productServiceId: null, variantId: null, status: "ambiguous" };

    return { productServiceId: null, variantId: null, status: "unmatched" };
  }

  /** Resolve e GRAVA a resolução numa linha de item (por id). Idempotente. */
  static resolveItem(orgId: string, itemId: string, produto: string | null): CatalogMatch {
    const m = this.resolveCode(orgId, produto);
    db.prepare(
      `UPDATE retail_pdv_sale_items SET product_service_id = ?, variant_id = ?, catalog_match_status = ?, catalog_resolved_at = CURRENT_TIMESTAMP WHERE organization_id = ? AND id = ?`
    ).run(m.productServiceId, m.variantId, m.status, orgId, itemId);
    return m;
  }

  /**
   * Backfill em lote dos itens ainda não resolvidos (catalog_resolved_at IS NULL).
   * Interrompível (limit por chamada); idempotente; itens ambíguos/sem match ficam
   * resolvidos com o status correspondente (não voltam a ser varridos).
   */
  static backfill(orgId: string, opts: { limit?: number } = {}): { processed: number; byStatus: Record<string, number> } {
    const limit = Math.max(1, Math.min(5000, Math.trunc(Number(opts.limit) || 1000)));
    const rows = db.prepare(
      `SELECT id, produto FROM retail_pdv_sale_items WHERE organization_id = ? AND catalog_resolved_at IS NULL LIMIT ?`
    ).all(orgId, limit) as any[];
    const byStatus: Record<string, number> = { exact: 0, prefix: 0, unmatched: 0, ambiguous: 0 };
    const tx = db.transaction(() => {
      for (const r of rows) {
        const m = this.resolveItem(orgId, r.id, r.produto);
        byStatus[m.status] = (byStatus[m.status] || 0) + 1;
      }
    });
    tx();
    return { processed: rows.length, byStatus };
  }

  /** Quantos itens ainda faltam resolver (pra saber se o backfill terminou). */
  static pendingCount(orgId: string): number {
    const r = db.prepare(`SELECT COUNT(*) AS n FROM retail_pdv_sale_items WHERE organization_id = ? AND catalog_resolved_at IS NULL`).get(orgId) as any;
    return Number(r?.n || 0);
  }
}

export default RetailPdvCatalogResolver;
