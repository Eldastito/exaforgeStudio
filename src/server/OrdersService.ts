import db from "./db.js";
import { v4 as uuidv4 } from "uuid";
import { InventoryService } from "./InventoryService.js";

export type OrderStatus =
  | "aguardando_pagamento" | "pago" | "em_preparo" | "entregue"
  | "concluido" | "cancelado" | "reembolso" | "devolucao";

// Status em que a baixa de estoque (commit) já deve ter ocorrido.
const FULFILLED_STATUSES: OrderStatus[] = ["pago", "em_preparo", "entregue", "concluido"];
// Status que devolvem o estoque.
const REVERSING_STATUSES: OrderStatus[] = ["cancelado", "reembolso", "devolucao"];

const ALL_STATUSES = new Set<OrderStatus>([
  "aguardando_pagamento", "pago", "em_preparo", "entregue",
  "concluido", "cancelado", "reembolso", "devolucao",
]);

interface NewOrderItem { productId?: string; name?: string; unitPrice?: number; quantity: number; }

export class OrdersService {
  static isValidStatus(s: string): s is OrderStatus {
    return ALL_STATUSES.has(s as OrderStatus);
  }

  /**
   * Cria um pedido. Valida e RESERVA o estoque de cada item. Se autoClose=true,
   * já faz a baixa definitiva (commit) e marca como 'pago'.
   * Tudo numa transação: se faltar estoque de qualquer item, nada é aplicado.
   */
  static createOrder(orgId: string, params: {
    contactId?: string; ticketId?: string; items: NewOrderItem[];
    createdBy?: string; autoClose?: boolean; notes?: string;
  }): { id: string; status: OrderStatus; total: number; items: any[] } {
    const items = (params.items || []).filter(i => i && i.quantity > 0);
    if (items.length === 0) throw new Error("Pedido sem itens.");

    const orderId = uuidv4();
    const status: OrderStatus = params.autoClose ? "pago" : "aguardando_pagamento";

    const tx = db.transaction(() => {
      let total = 0;
      const resolved: any[] = [];

      for (const it of items) {
        let product: any = null;
        if (it.productId) {
          product = db.prepare('SELECT * FROM products_services WHERE id = ? AND organization_id = ? AND active = 1').get(it.productId, orgId);
        }
        const name = product?.name || it.name;
        if (!name) throw new Error("Item de pedido sem produto/nome.");
        const unitPrice = (product?.price ?? it.unitPrice ?? 0);
        const lineTotal = unitPrice * it.quantity;
        total += lineTotal;

        // Reserva (e valida) o estoque, se o produto controla estoque.
        if (product?.id) {
          InventoryService.reserve(orgId, product.id, it.quantity);
          if (params.autoClose) {
            InventoryService.commit(orgId, product.id, it.quantity);
          }
        }

        resolved.push({
          id: uuidv4(), product_service_id: product?.id || null, name_snapshot: name,
          unit_price: unitPrice, quantity: it.quantity, line_total: lineTotal,
          stock_committed: params.autoClose ? 1 : 0,
        });
      }

      db.prepare(`
        INSERT INTO orders (id, organization_id, contact_id, ticket_id, status, total_amount, created_by, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(orderId, orgId, params.contactId || null, params.ticketId || null, status, total, params.createdBy || null, params.notes || null);

      const insItem = db.prepare(`
        INSERT INTO order_items (id, order_id, organization_id, product_service_id, name_snapshot, unit_price, quantity, line_total, stock_committed)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const r of resolved) {
        insItem.run(r.id, orderId, orgId, r.product_service_id, r.name_snapshot, r.unit_price, r.quantity, r.line_total, r.stock_committed);
      }

      return { total, resolved };
    });

    const { total, resolved } = tx();
    return { id: orderId, status, total, items: resolved };
  }

  /** Atualiza o status de um pedido, aplicando os efeitos de estoque corretos. */
  static updateStatus(orgId: string, orderId: string, newStatus: OrderStatus): void {
    const order = db.prepare('SELECT * FROM orders WHERE id = ? AND organization_id = ?').get(orderId, orgId) as any;
    if (!order) throw new Error("Pedido não encontrado.");
    if (order.status === newStatus) return;

    const itemsRows = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(orderId) as any[];

    const tx = db.transaction(() => {
      const becomingFulfilled = FULFILLED_STATUSES.includes(newStatus);
      const becomingReversed = REVERSING_STATUSES.includes(newStatus);

      for (const item of itemsRows) {
        if (!item.product_service_id) continue;

        if (becomingFulfilled && !item.stock_committed) {
          // Baixa definitiva: reservado -> vendido.
          InventoryService.commit(orgId, item.product_service_id, item.quantity);
          db.prepare('UPDATE order_items SET stock_committed = 1 WHERE id = ?').run(item.id);
        } else if (becomingReversed) {
          if (item.stock_committed) {
            // Já tinha baixado: devolve à prateleira.
            InventoryService.restock(orgId, item.product_service_id, item.quantity);
          } else {
            // Só estava reservado: solta a reserva.
            InventoryService.release(orgId, item.product_service_id, item.quantity);
          }
          db.prepare('UPDATE order_items SET stock_committed = 0 WHERE id = ?').run(item.id);
        }
      }

      db.prepare('UPDATE orders SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(newStatus, orderId);
    });

    tx();
  }

  static getOrder(orgId: string, orderId: string): any {
    const order = db.prepare('SELECT * FROM orders WHERE id = ? AND organization_id = ?').get(orderId, orgId) as any;
    if (!order) return null;
    order.items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(orderId);
    return order;
  }
}
