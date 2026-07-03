import db from "./db.js";
import { v4 as uuidv4 } from "uuid";
import { NotificationService } from "./NotificationService.js";

/**
 * Movimentação de estoque atômica e validada. Modelo:
 * - quantity_available: total em mãos (na prateleira).
 * - quantity_reserved:  quanto está preso em pedidos pendentes.
 * - vendável = quantity_available - quantity_reserved.
 *
 * O estoque é mantido por LINHA de inventory_items, identificada por
 * (product_service_id, variant_id). Produtos sem variação usam variant_id = NULL,
 * mantendo compatibilidade com o que já existia.
 *
 * reserve/release/commit/restock operam sobre a linha certa (produto ou variação).
 * recordMovement registra entrada/saída/ajuste/transferência (loja física -> e-commerce)
 * com custo, atualizando o custo médio.
 */
export class InventoryService {
  private static row(orgId: string, productId: string, variantId?: string | null): any {
    if (variantId) {
      return db.prepare('SELECT * FROM inventory_items WHERE organization_id = ? AND product_service_id = ? AND variant_id = ?').get(orgId, productId, variantId);
    }
    return db.prepare('SELECT * FROM inventory_items WHERE organization_id = ? AND product_service_id = ? AND variant_id IS NULL').get(orgId, productId);
  }

  private static ensureRow(orgId: string, productId: string, variantId?: string | null): any {
    let r = this.row(orgId, productId, variantId);
    if (!r) {
      const id = uuidv4();
      db.prepare('INSERT INTO inventory_items (id, organization_id, product_service_id, variant_id, quantity_available) VALUES (?, ?, ?, ?, 0)')
        .run(id, orgId, productId, variantId || null);
      r = this.row(orgId, productId, variantId);
    }
    return r;
  }

  /** Estoque vendável atual (produto ou variação). null = sem controle de estoque. */
  static sellable(orgId: string, productId: string, variantId?: string | null): number | null {
    const inv = this.row(orgId, productId, variantId);
    if (!inv) return null;
    return (inv.quantity_available || 0) - (inv.quantity_reserved || 0);
  }

  /** Custo médio atual de um item (produto ou variação). 0 se não houver. */
  static avgCost(orgId: string, productId: string, variantId?: string | null): number {
    const r = this.row(orgId, productId, variantId);
    return r?.avg_cost || 0;
  }

  static hasStockControl(orgId: string, productId: string): boolean {
    const p = db.prepare('SELECT stock_control_enabled FROM products_services WHERE id = ? AND organization_id = ?').get(productId, orgId) as any;
    return !!(p && p.stock_control_enabled);
  }

  static reserve(orgId: string, productId: string, qty: number, variantId?: string | null) {
    if (!this.hasStockControl(orgId, productId)) return;
    const sellable = this.sellable(orgId, productId, variantId);
    if (sellable === null) return;
    if (qty > sellable) {
      throw new Error(`Estoque insuficiente: disponível ${sellable}, pedido ${qty}.`);
    }
    const r = this.ensureRow(orgId, productId, variantId);
    db.prepare('UPDATE inventory_items SET quantity_reserved = quantity_reserved + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(qty, r.id);
  }

  static release(orgId: string, productId: string, qty: number, variantId?: string | null) {
    if (!this.hasStockControl(orgId, productId)) return;
    const r = this.row(orgId, productId, variantId);
    if (r) db.prepare('UPDATE inventory_items SET quantity_reserved = MAX(0, quantity_reserved - ?), updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(qty, r.id);
  }

  static commit(orgId: string, productId: string, qty: number, variantId?: string | null) {
    if (!this.hasStockControl(orgId, productId)) return;
    const r = this.row(orgId, productId, variantId);
    if (r) db.prepare('UPDATE inventory_items SET quantity_available = MAX(0, quantity_available - ?), quantity_reserved = MAX(0, quantity_reserved - ?), updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(qty, qty, r.id);
    this.checkLowStock(orgId, productId, variantId);
  }

  /**
   * Após uma baixa, avisa se o disponível cruzou o limite de alerta
   * (inventory_items.low_stock_threshold). Notifica com dedupe (1x por 12h).
   */
  private static checkLowStock(orgId: string, productId: string, variantId?: string | null) {
    try {
      const r = this.row(orgId, productId, variantId);
      if (!r) return;
      const threshold = r.low_stock_threshold || 0;
      if (threshold <= 0) return;
      const available = (r.quantity_available || 0) - (r.quantity_reserved || 0);
      if (available <= threshold) {
        const p = db.prepare('SELECT name FROM products_services WHERE id = ?').get(productId) as any;
        if (p?.name) NotificationService.lowStock(orgId, p.name, available);
      }
    } catch (e) { /* noop */ }
  }

  static restock(orgId: string, productId: string, qty: number, variantId?: string | null) {
    if (!this.hasStockControl(orgId, productId)) return;
    const r = this.ensureRow(orgId, productId, variantId);
    db.prepare('UPDATE inventory_items SET quantity_available = quantity_available + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(qty, r.id);
  }

  /** Define a quantidade absoluta em mãos (gestão humana / importação). */
  static setQuantity(orgId: string, productId: string, quantity: number, variantId?: string | null) {
    const r = this.ensureRow(orgId, productId, variantId);
    db.prepare('UPDATE inventory_items SET quantity_available = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(Math.max(0, quantity), r.id);
  }

  /**
   * Registra uma movimentação de estoque e ajusta o saldo.
   *  - entrada/transferencia: soma ao disponível e recalcula o custo médio.
   *  - saida: subtrai do disponível.
   *  - ajuste: define o disponível para a quantidade informada (inventário).
   * Retorna o id do movimento.
   */
  static recordMovement(orgId: string, params: {
    productId: string; variantId?: string | null; type: 'entrada' | 'saida' | 'ajuste' | 'transferencia';
    quantity: number; unitCost?: number; origin?: string; note?: string; createdBy?: string;
    supplierContactId?: string | null; // contato do CRM com is_supplier=1 (entradas por nota fiscal, ADR-024)
  }): string {
    const qty = Math.abs(parseInt(String(params.quantity), 10) || 0);
    if (qty <= 0 && params.type !== 'ajuste') throw new Error("Quantidade inválida.");

    const tx = db.transaction(() => {
      const r = this.ensureRow(orgId, params.productId, params.variantId);
      const current = r.quantity_available || 0;
      const currentCost = r.avg_cost || 0;

      if (params.type === 'entrada' || params.type === 'transferencia') {
        const newQty = current + qty;
        // Custo médio ponderado quando há custo informado.
        let newCost = currentCost;
        if (params.unitCost && params.unitCost > 0) {
          newCost = ((current * currentCost) + (qty * params.unitCost)) / (newQty || 1);
        }
        db.prepare('UPDATE inventory_items SET quantity_available = ?, avg_cost = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(newQty, newCost, r.id);
      } else if (params.type === 'saida') {
        db.prepare('UPDATE inventory_items SET quantity_available = MAX(0, quantity_available - ?), updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(qty, r.id);
      } else if (params.type === 'ajuste') {
        db.prepare('UPDATE inventory_items SET quantity_available = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(qty, r.id);
      }

      const movId = uuidv4();
      db.prepare(`
        INSERT INTO stock_movements (id, organization_id, product_service_id, variant_id, type, quantity, unit_cost, origin, note, created_by, supplier_contact_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(movId, orgId, params.productId, params.variantId || null, params.type, qty, params.unitCost || 0, params.origin || null, params.note || null, params.createdBy || null, params.supplierContactId || null);
      return movId;
    });
    return tx();
  }

  /** Histórico de movimentações de um produto. */
  static listMovements(orgId: string, productId: string): any[] {
    return db.prepare(`
      SELECT sm.*, pv.name AS variant_name
      FROM stock_movements sm
      LEFT JOIN product_variants pv ON pv.id = sm.variant_id
      WHERE sm.organization_id = ? AND sm.product_service_id = ?
      ORDER BY sm.created_at DESC LIMIT 100
    `).all(orgId, productId);
  }
}
