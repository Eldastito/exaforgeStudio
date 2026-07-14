/**
 * Retail Ops — Scan por código de barras (ADR-086, versão só-catálogo-próprio).
 *
 * Bipar o código de barras é DECODIFICADO no aparelho (zero token de IA). Aqui
 * fazemos o LOOKUP no catálogo da própria loja (products_services.ean) e a
 * ENTRADA de estoque por bipagem — RESPEITANDO a invariante do modo de estoque
 * (ADR-084 D4): `native` escreve no núcleo (inventory_items), `supervised`
 * escreve na sombra por loja (retail_store_inventory). Sem provedor de EAN
 * externo (fica como enriquecimento opcional futuro). Isolado por organização.
 */
import db from "./db.js";
import { sanitizeGtin } from "./eanUtil.js";
import { InventoryService } from "./InventoryService.js";
import { RetailInventoryService } from "./RetailInventoryService.js";
import { RetailStockModeService } from "./RetailStockModeService.js";
import { logAuthEvent } from "./auditLog.js";

export class RetailScanService {
  /** Lookup do produto pelo código de barras no catálogo próprio. */
  static lookupByEan(orgId: string, rawEan: string): any {
    const ean = sanitizeGtin(rawEan);
    if (!ean) return { found: false, invalid: true, ean: String(rawEan || "") };
    const product = db.prepare(
      `SELECT id, name, ean, price FROM products_services WHERE organization_id = ? AND ean = ? LIMIT 1`
    ).get(orgId, ean) as any;
    if (!product) return { found: false, ean };
    return { found: true, ean, product: { id: product.id, name: product.name, ean: product.ean, price: Number(product.price || 0) }, coreStock: InventoryService.sellable(orgId, product.id, null) };
  }

  /**
   * Entrada de estoque por bipagem: acha o produto pelo EAN e credita a
   * quantidade no ledger AUTORITATIVO da loja/org (native→core, supervised→
   * sombra). Retorna o produto e o ledger usado. `store_required` quando o modo
   * é supervisionado e nenhuma loja foi informada.
   */
  static scanReceive(orgId: string, rawEan: string, qty: number, opts: { storeId?: string | null } = {}, actorId?: string): any {
    const q = Math.trunc(Number(qty) || 0);
    if (q <= 0) throw new Error("Quantidade inválida.");
    const hit = this.lookupByEan(orgId, rawEan);
    if (!hit.found) return hit; // invalid ou não encontrado → cliente decide o fallback

    const storeId = opts.storeId || null;
    const ledger = RetailStockModeService.authoritativeLedger(orgId, storeId);

    if (ledger === "shadow") {
      if (!storeId) throw new Error("store_required"); // sombra é por loja
      RetailInventoryService.applyMovement(orgId, storeId, hit.product.id, null, q, actorId);
    } else {
      InventoryService.recordMovement(orgId, { productId: hit.product.id, type: "entrada", quantity: q, origin: "scan", createdBy: actorId });
    }

    try { logAuthEvent(orgId, actorId || "system", hit.product.id, "RETAIL_SCAN_RECEIVE", { ean: hit.ean, qty: q, ledger, storeId }); } catch { /* noop */ }
    return { found: true, ledger, storeId, product: hit.product, quantity: q };
  }
}
