/**
 * Retail Ops — Estoque por loja + alertas de negativo (ADR-083, Fase F).
 *
 * Camada de estoque POR LOJA que PERMITE quantidade < 0 (sem o MAX(0,…) do
 * core), para EXPOR a divergência: quando um item fica negativo, abre-se um
 * `retail_stock_alert` com uma causa provável para o operador investigar. O
 * estoque core (inventory_items) segue clampado e intocado (ADR-083 D6). Camada
 * aditiva, isolada por organização, auditada.
 */
import { randomUUID } from "node:crypto";
import db from "./db.js";
import { logAuthEvent } from "./auditLog.js";

// Causas prováveis de estoque negativo (heurística; a explicação com dados de
// venda vem quando a conciliação externa — Fase E — estiver ligada).
export const NEGATIVE_STOCK_CAUSES = [
  "venda sem baixa correta no estoque",
  "transferência entre lojas não registrada",
  "entrada de mercadoria não lançada",
  "divergência de inventário/contagem",
];

const vk = (variantId?: string | null) => (variantId ? String(variantId) : "");

export class RetailInventoryService {
  static get(orgId: string, storeId: string, productId: string, variantId?: string | null): any | null {
    return (db.prepare(
      `SELECT * FROM retail_store_inventory WHERE organization_id = ? AND store_id = ? AND product_service_id = ? AND variant_id = ?`
    ).get(orgId, storeId, productId, vk(variantId)) as any) || null;
  }

  /** Define o saldo absoluto (permite negativo) e (re)avalia o alerta. */
  static setQuantity(orgId: string, storeId: string, productId: string, variantId: string | null | undefined, quantityAvailable: number, quantityReserved = 0, actorId?: string): any {
    const qty = Math.trunc(Number(quantityAvailable || 0));
    db.prepare(
      `INSERT INTO retail_store_inventory (id, organization_id, store_id, product_service_id, variant_id, quantity_available, quantity_reserved, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(organization_id, store_id, product_service_id, variant_id) DO UPDATE SET
         quantity_available = excluded.quantity_available, quantity_reserved = excluded.quantity_reserved, updated_at = CURRENT_TIMESTAMP`
    ).run(randomUUID(), orgId, storeId, productId, vk(variantId), qty, Math.trunc(Number(quantityReserved || 0)));
    this.evaluateAlert(orgId, storeId, productId, variantId, qty);
    try { logAuthEvent(orgId, actorId || "system", storeId, "RETAIL_STOCK_SET", { productId, qty }); } catch { /* noop */ }
    return this.get(orgId, storeId, productId, variantId);
  }

  /** Aplica um delta (venda = negativo, entrada = positivo). PODE ficar negativo. */
  static applyMovement(orgId: string, storeId: string, productId: string, variantId: string | null | undefined, delta: number, actorId?: string): any {
    const cur = this.get(orgId, storeId, productId, variantId);
    const next = Math.trunc(Number(cur?.quantity_available || 0)) + Math.trunc(Number(delta || 0));
    return this.setQuantity(orgId, storeId, productId, variantId, next, Number(cur?.quantity_reserved || 0), actorId);
  }

  /** Abre um alerta quando fica negativo; resolve quando volta a >= 0. */
  private static evaluateAlert(orgId: string, storeId: string, productId: string, variantId: string | null | undefined, qty: number): void {
    if (qty < 0) {
      db.prepare(
        `INSERT INTO retail_stock_alerts (id, organization_id, store_id, product_service_id, variant_id, alert_type, quantity, status)
         VALUES (?, ?, ?, ?, ?, 'negative_stock', ?, 'open')
         ON CONFLICT(organization_id, store_id, product_service_id, variant_id, alert_type) DO UPDATE SET
           quantity = excluded.quantity, status = 'open', detected_at = CURRENT_TIMESTAMP, resolved_at = NULL, resolution_note = NULL`
      ).run(randomUUID(), orgId, storeId, productId, vk(variantId), qty);
    } else {
      db.prepare(
        `UPDATE retail_stock_alerts SET status = 'resolved', resolved_at = CURRENT_TIMESTAMP, resolution_note = COALESCE(resolution_note, 'estoque normalizado')
          WHERE organization_id = ? AND store_id = ? AND product_service_id = ? AND variant_id = ? AND alert_type = 'negative_stock' AND status = 'open'`
      ).run(orgId, storeId, productId, vk(variantId));
    }
  }

  static listNegative(orgId: string): any[] {
    return db.prepare(
      `SELECT i.*, s.name AS store_name, p.name AS product_name
         FROM retail_store_inventory i
         JOIN retail_stores s ON s.id = i.store_id
    LEFT JOIN products_services p ON p.id = i.product_service_id
        WHERE i.organization_id = ? AND i.quantity_available < 0
        ORDER BY i.quantity_available ASC`
    ).all(orgId) as any[];
  }

  static byStore(orgId: string, storeId: string): any[] {
    return db.prepare(
      `SELECT i.*, p.name AS product_name FROM retail_store_inventory i
    LEFT JOIN products_services p ON p.id = i.product_service_id
        WHERE i.organization_id = ? AND i.store_id = ? ORDER BY i.quantity_available ASC`
    ).all(orgId, storeId) as any[];
  }

  static listAlerts(orgId: string, status = "open"): any[] {
    return db.prepare(
      `SELECT a.*, s.name AS store_name, p.name AS product_name
         FROM retail_stock_alerts a
    LEFT JOIN retail_stores s ON s.id = a.store_id
    LEFT JOIN products_services p ON p.id = a.product_service_id
        WHERE a.organization_id = ? AND a.status = ? ORDER BY a.detected_at DESC`
    ).all(orgId, status).map((a: any) => ({ ...a, possibleCauses: NEGATIVE_STOCK_CAUSES })) as any[];
  }

  static resolveAlert(orgId: string, id: string, note: string | undefined, actorId?: string): any | null {
    const a = db.prepare(`SELECT * FROM retail_stock_alerts WHERE organization_id = ? AND id = ?`).get(orgId, id) as any;
    if (!a) return null;
    db.prepare(`UPDATE retail_stock_alerts SET status = 'resolved', resolved_at = CURRENT_TIMESTAMP, resolution_note = ? WHERE organization_id = ? AND id = ?`)
      .run(note || "resolvido manualmente", orgId, id);
    try { logAuthEvent(orgId, actorId || "system", id, "RETAIL_STOCK_ALERT_RESOLVED", { note }); } catch { /* noop */ }
    return db.prepare(`SELECT * FROM retail_stock_alerts WHERE id = ?`).get(id);
  }
}
