import db from "./db.js";
import { v4 as uuidv4 } from "uuid";

/**
 * Movimentação de estoque atômica e validada. Modelo:
 * - quantity_available: total em mãos (na prateleira).
 * - quantity_reserved:  quanto está preso em pedidos pendentes.
 * - vendável = quantity_available - quantity_reserved.
 *
 * reserve  : segura estoque para um pedido (reserved += qty). Falha se não há vendável.
 * release  : solta a reserva (reserved -= qty) — usado em cancelamento antes da baixa.
 * commit   : baixa definitiva (available -= qty, reserved -= qty) — venda concretizada.
 * restock  : devolve à prateleira (available += qty) — reembolso/devolução.
 */
export class InventoryService {
  /** Estoque vendável atual de um produto (ou null se não controla estoque). */
  static sellable(orgId: string, productId: string): number | null {
    const inv = db.prepare(
      'SELECT quantity_available, quantity_reserved FROM inventory_items WHERE organization_id = ? AND product_service_id = ?'
    ).get(orgId, productId) as any;
    if (!inv) return null; // sem controle de estoque
    return (inv.quantity_available || 0) - (inv.quantity_reserved || 0);
  }

  /** Indica se o produto tem controle de estoque ligado. */
  static hasStockControl(orgId: string, productId: string): boolean {
    const p = db.prepare('SELECT stock_control_enabled FROM products_services WHERE id = ? AND organization_id = ?').get(productId, orgId) as any;
    return !!(p && p.stock_control_enabled);
  }

  static reserve(orgId: string, productId: string, qty: number) {
    if (!this.hasStockControl(orgId, productId)) return;
    const sellable = this.sellable(orgId, productId);
    if (sellable === null) return;
    if (qty > sellable) {
      throw new Error(`Estoque insuficiente: disponível ${sellable}, pedido ${qty}.`);
    }
    db.prepare(
      'UPDATE inventory_items SET quantity_reserved = quantity_reserved + ?, updated_at = CURRENT_TIMESTAMP WHERE organization_id = ? AND product_service_id = ?'
    ).run(qty, orgId, productId);
  }

  static release(orgId: string, productId: string, qty: number) {
    if (!this.hasStockControl(orgId, productId)) return;
    db.prepare(
      'UPDATE inventory_items SET quantity_reserved = MAX(0, quantity_reserved - ?), updated_at = CURRENT_TIMESTAMP WHERE organization_id = ? AND product_service_id = ?'
    ).run(qty, orgId, productId);
  }

  static commit(orgId: string, productId: string, qty: number) {
    if (!this.hasStockControl(orgId, productId)) return;
    db.prepare(
      'UPDATE inventory_items SET quantity_available = MAX(0, quantity_available - ?), quantity_reserved = MAX(0, quantity_reserved - ?), updated_at = CURRENT_TIMESTAMP WHERE organization_id = ? AND product_service_id = ?'
    ).run(qty, qty, orgId, productId);
  }

  static restock(orgId: string, productId: string, qty: number) {
    if (!this.hasStockControl(orgId, productId)) return;
    db.prepare(
      'UPDATE inventory_items SET quantity_available = quantity_available + ?, updated_at = CURRENT_TIMESTAMP WHERE organization_id = ? AND product_service_id = ?'
    ).run(qty, orgId, productId);
  }

  /** Define/ajusta a quantidade em mãos de um produto (gestão humana). */
  static setQuantity(orgId: string, productId: string, quantity: number) {
    const existing = db.prepare('SELECT id FROM inventory_items WHERE organization_id = ? AND product_service_id = ?').get(orgId, productId) as any;
    if (existing) {
      db.prepare('UPDATE inventory_items SET quantity_available = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(Math.max(0, quantity), existing.id);
    } else {
      db.prepare('INSERT INTO inventory_items (id, organization_id, product_service_id, quantity_available) VALUES (?, ?, ?, ?)')
        .run(uuidv4(), orgId, productId, Math.max(0, quantity));
    }
  }
}
