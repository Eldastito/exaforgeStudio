/**
 * Retail Ops — Graduação supervisor → nativo (ADR-084 D5, loja única).
 *
 * O "resultado antes, migração depois": um cliente começa SUPERVISIONADO (o ERP/
 * PDV externo é a fonte; o ZappFlow só concilia na sombra `retail_store_inventory`)
 * e, quando quer o ZappFlow como sistema principal, PROMOVE a loja para NATIVO —
 * semeando o estoque do núcleo (`inventory_items`) a partir do saldo atual da
 * sombra e virando o modo para `native`.
 *
 * Escopo desta fatia: LOJA ÚNICA (o núcleo é por organização, sem store_id — ver
 * ADR-084 D4, Opção 3). Multiloja nativo (store_id no núcleo) é fatia futura. A
 * sombra pode ir a negativo (divergência); o núcleo não aceita negativo, então
 * quantidades negativas entram como 0 e são contadas no relatório. Auditado.
 */
import db from "./db.js";
import { InventoryService } from "./InventoryService.js";
import { RetailStockModeService } from "./RetailStockModeService.js";
import { logAuthEvent } from "./auditLog.js";

export class RetailGraduationService {
  /**
   * Promove uma loja supervisionada para nativa: semeia o núcleo a partir da
   * sombra e vira o modo para `native`. Falha se a loja já for nativa.
   */
  static graduate(orgId: string, storeId: string, actorId?: string): {
    storeId: string; storeName: string; fromMode: string; toMode: string;
    productsSeeded: number; negativesClamped: number;
  } {
    const store = db.prepare(`SELECT id, name FROM retail_stores WHERE organization_id = ? AND id = ?`).get(orgId, storeId) as any;
    if (!store) throw new Error("store_not_found");

    const fromMode = RetailStockModeService.resolve(orgId, storeId);
    if (fromMode === "native") throw new Error("already_native");

    const rows = db.prepare(
      `SELECT product_service_id, variant_id, quantity_available FROM retail_store_inventory WHERE organization_id = ? AND store_id = ?`
    ).all(orgId, storeId) as any[];

    let productsSeeded = 0, negativesClamped = 0;
    for (const r of rows) {
      const qty = Number(r.quantity_available || 0);
      if (qty < 0) negativesClamped++;
      // setQuantity clampa em max(0, qty) — o núcleo não guarda negativo.
      InventoryService.setQuantity(orgId, r.product_service_id, qty, r.variant_id || null);
      productsSeeded++;
    }

    RetailStockModeService.setStoreOverride(orgId, storeId, "native", actorId);
    try { logAuthEvent(orgId, actorId || "system", storeId, "RETAIL_STOCK_GRADUATED", { fromMode, toMode: "native", productsSeeded, negativesClamped }); } catch { /* noop */ }

    return { storeId, storeName: store.name, fromMode, toMode: "native", productsSeeded, negativesClamped };
  }
}
