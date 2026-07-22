/**
 * Conector Alterdata/ModaUp — MAPPER DE PREÇO (ADR-105, Fase 1d).
 *
 * Traduz `Preco` (módulo Price: produto, tabela, preco1) no preço de venda do
 * ZappFlow. Resolve `produto` → variante (external_ref/sku) ou produto
 * (external_ref) — mesma regra do estoque. Grava `preco1` como preço de venda:
 * na variante quando resolve variante, senão no produto. Mapper PURO (sem HTTP).
 *
 * A tabela de preço da rede (`price_table`) é escolhida na config; o Runner só
 * puxa Preco quando ela está definida. min/max/markup ficam no metadata do
 * produto para referência futura (margem/precificação).
 */
import db from "./db.js";

export interface PriceMapResult { applied: number; skippedNoProduct: number; }

export class AlterdataPriceMapper {
  static upsertPrecos(orgId: string, items: any[]): PriceMapResult {
    const res: PriceMapResult = { applied: 0, skippedNoProduct: 0 };
    for (const p of Array.isArray(items) ? items : []) {
      const produto = str(p?.produto);
      if (!produto) continue;
      const price = numOrNull(p?.preco1 ?? p?.preco);
      if (price == null) continue; // sem preço válido, ignora

      const target = this.resolveProduct(orgId, produto);
      if (!target) { res.skippedNoProduct++; continue; }

      if (target.variantId) {
        db.prepare(`UPDATE product_variants SET price = ? WHERE organization_id = ? AND id = ?`).run(price, orgId, target.variantId);
      } else {
        db.prepare(`UPDATE products_services SET price = ? WHERE organization_id = ? AND id = ?`).run(price, orgId, target.productId);
      }
      res.applied++;
    }
    return res;
  }

  /** produto (ERP) → { productId, variantId } via variante (external_ref/sku) ou produto (external_ref). */
  private static resolveProduct(orgId: string, produto: string): { productId: string; variantId: string | null } | null {
    const v = db.prepare(`SELECT id, product_service_id FROM product_variants WHERE organization_id = ? AND (external_ref = ? OR sku = ?) LIMIT 1`).get(orgId, produto, produto) as any;
    if (v?.product_service_id) return { productId: v.product_service_id, variantId: v.id };
    const p = db.prepare(`SELECT id FROM products_services WHERE organization_id = ? AND external_ref = ? LIMIT 1`).get(orgId, produto) as any;
    if (p?.id) return { productId: p.id, variantId: null };
    return null;
  }
}

function str(v: any): string { return v == null ? "" : String(v).trim(); }
function numOrNull(v: any): number | null { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; }
