/**
 * Conector Alterdata/ModaUp — MAPPER DE ESTOQUE (ADR-105, Fase 1c).
 *
 * Traduz `Saldo` (filial, produto, saldoAtual) do módulo Supply em estoque por
 * LOJA no ZappFlow (`retail_store_inventory`, ADR-083). Resolve:
 *   - filial (ERP) → retail_stores.code (loja da rede);
 *   - produto (ERP) → variante por external_ref/sku, senão produto por
 *     external_ref (variant_id = "").
 * Saldos de loja/produto ainda não mapeados são pulados e contabilizados. Usa o
 * RetailInventoryService (upsert por ON CONFLICT, permite negativo, abre/fecha
 * alerta de estoque negativo). Mapper PURO (sem HTTP).
 */
import db from "./db.js";
import { RetailInventoryService } from "./RetailInventoryService.js";
import { RetailOnlineReserveService } from "./RetailOnlineReserveService.js";

export interface SaldoMapResult { applied: number; skippedNoStore: number; skippedNoProduct: number; }

export class AlterdataStockMapper {
  /** Upsert de saldos por loja. `filialToStore` opcional sobrescreve o match por código. */
  static upsertSaldos(orgId: string, items: any[], opts: { filialToStore?: Record<string, string> } = {}): SaldoMapResult {
    const res: SaldoMapResult = { applied: 0, skippedNoStore: 0, skippedNoProduct: 0 };
    const storeCache = new Map<string, string | null>();

    for (const s of Array.isArray(items) ? items : []) {
      const filial = str(s?.filial);
      const produto = str(s?.produto);
      if (!filial || !produto) continue;

      const storeId = this.resolveStore(orgId, filial, opts.filialToStore, storeCache);
      if (!storeId) { res.skippedNoStore++; continue; }

      const target = this.resolveProduct(orgId, produto);
      if (!target) { res.skippedNoProduct++; continue; }

      // Anti-clobber (ADR-143 D3): quando a reserva online está ligada, desconta
      // do saldo do ERP as vendas online ainda não lançadas no PDV — assim a
      // sobrescrita absoluta não apaga a venda da loja virtual.
      let qty = Math.trunc(Number(s?.saldoAtual ?? 0));
      if (RetailOnlineReserveService.isEnabled(orgId)) {
        qty = RetailOnlineReserveService.netStoreQty(orgId, storeId, target.productId, target.variantId, qty);
      }
      RetailInventoryService.setQuantity(orgId, storeId, target.productId, target.variantId, qty, 0, "alterdata");
      res.applied++;
    }
    return res;
  }

  /** filial → retail_stores.id (por mapa explícito ou por code). Cacheado. */
  private static resolveStore(orgId: string, filial: string, map: Record<string, string> | undefined, cache: Map<string, string | null>): string | null {
    if (map && map[filial]) return map[filial];
    if (cache.has(filial)) return cache.get(filial) || null;
    const row = db.prepare(`SELECT id FROM retail_stores WHERE organization_id = ? AND (code = ? OR id = ?) AND active = 1 LIMIT 1`).get(orgId, filial, filial) as any;
    const id = row?.id || null;
    cache.set(filial, id);
    return id;
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
