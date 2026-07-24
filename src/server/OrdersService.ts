import db from "./db.js";
import { v4 as uuidv4 } from "uuid";
import { InventoryService } from "./InventoryService.js";
import { CustomerProfileService } from "./CustomerProfileService.js";
import { GoogleAutomationService } from "./GoogleAutomationService.js";
import { RetailOnlineReserveService } from "./RetailOnlineReserveService.js";

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

interface NewOrderItem { productId?: string; variantId?: string; name?: string; unitPrice?: number; quantity: number; }

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
    discountPercent?: number; couponId?: string; storeId?: string;
  }): { id: string; status: OrderStatus; total: number; items: any[]; discount: number } {
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
        // Resolve a variação (se houver) para nome/preço/estoque corretos.
        let variant: any = null;
        if (it.variantId) {
          variant = db.prepare('SELECT * FROM product_variants WHERE id = ? AND organization_id = ?').get(it.variantId, orgId);
        }
        const name = variant ? `${product?.name || it.name} (${variant.name})` : (product?.name || it.name);
        if (!name) throw new Error("Item de pedido sem produto/nome.");
        const unitPrice = (variant?.price ?? product?.price ?? it.unitPrice ?? 0);
        const lineTotal = unitPrice * it.quantity;
        total += lineTotal;

        // Custo unitário no momento da venda (snapshot, para cálculo de lucro/margem).
        const unitCost = product?.id ? InventoryService.avgCost(orgId, product.id, variant?.id || null) : 0;

        // Reserva (e valida) o estoque, se o produto controla estoque.
        if (product?.id) {
          InventoryService.reserve(orgId, product.id, it.quantity, variant?.id || null);
          if (params.autoClose) {
            InventoryService.commit(orgId, product.id, it.quantity, variant?.id || null);
          }
        }

        resolved.push({
          id: uuidv4(), product_service_id: product?.id || null, variant_id: variant?.id || null, name_snapshot: name,
          unit_price: unitPrice, unit_cost: unitCost, quantity: it.quantity, line_total: lineTotal,
          stock_committed: params.autoClose ? 1 : 0,
        });
      }

      // Desconto (ex.: cupom de indicação): aplica % sobre o total dos itens.
      const pct = Math.min(90, Math.max(0, Number(params.discountPercent || 0)));
      const discount = pct > 0 ? Math.round(total * (pct / 100) * 100) / 100 : 0;
      const finalTotal = Math.max(0, Math.round((total - discount) * 100) / 100);

      db.prepare(`
        INSERT INTO orders (id, organization_id, contact_id, ticket_id, status, total_amount, discount_amount, coupon_id, created_by, notes, store_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(orderId, orgId, params.contactId || null, params.ticketId || null, status, finalTotal, discount, params.couponId || null, params.createdBy || null, params.notes || null, params.storeId || null);

      const insItem = db.prepare(`
        INSERT INTO order_items (id, order_id, organization_id, product_service_id, variant_id, name_snapshot, unit_price, unit_cost, quantity, line_total, stock_committed)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const r of resolved) {
        insItem.run(r.id, orderId, orgId, r.product_service_id, r.variant_id || null, r.name_snapshot, r.unit_price, r.unit_cost || 0, r.quantity, r.line_total, r.stock_committed);
      }

      // Loja Virtual → PDV (ADR-143 Fase 0): pedido de uma FILIAL vende da reserva
      // e-commerce e registra a baixa pendente. Reserva insuficiente BLOQUEIA a
      // venda (sem oversell) — o throw desfaz a transação inteira. Opt-in.
      if (params.storeId && RetailOnlineReserveService.isEnabled(orgId)) {
        const r = RetailOnlineReserveService.recordSale(orgId, {
          orderId, storeId: params.storeId,
          items: resolved.filter((x) => x.product_service_id).map((x) => ({ productId: x.product_service_id, variantId: x.variant_id, qty: x.quantity })),
        }, params.createdBy);
        if (r.ok === false) {
          const names = (r.blocked || []).map((b) => resolved.find((x) => x.product_service_id === b.productId)?.name_snapshot || b.productId).join(", ");
          throw new Error(`Estoque online insuficiente na loja para: ${names}.`);
        }
      }

      return { total: finalTotal, discount, resolved };
    });

    const { total, discount, resolved } = tx();
    // Atualiza o perfil de CRM do contato (se já nasceu faturado via autoClose).
    if (params.contactId) CustomerProfileService.recomputePurchaseStats(orgId, params.contactId);
    // Automações Google (best-effort): planilha de vendas + confirmação por e-mail.
    GoogleAutomationService.logOrder(orgId, orderId).catch(() => {});
    GoogleAutomationService.confirmOrder(orgId, orderId).catch(() => {});
    return { id: orderId, status, total, items: resolved, discount };
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
          InventoryService.commit(orgId, item.product_service_id, item.quantity, item.variant_id);
          db.prepare('UPDATE order_items SET stock_committed = 1 WHERE id = ?').run(item.id);
        } else if (becomingReversed) {
          if (item.stock_committed) {
            // Já tinha baixado: devolve à prateleira.
            InventoryService.restock(orgId, item.product_service_id, item.quantity, item.variant_id);
          } else {
            // Só estava reservado: solta a reserva.
            InventoryService.release(orgId, item.product_service_id, item.quantity, item.variant_id);
          }
          db.prepare('UPDATE order_items SET stock_committed = 0 WHERE id = ?').run(item.id);
        }
      }

      db.prepare('UPDATE orders SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(newStatus, orderId);
    });

    tx();
    // Recalcula o perfil de CRM (compra concretizada/estornada muda os agregados).
    if (order.contact_id) CustomerProfileService.recomputePurchaseStats(orgId, order.contact_id);
  }

  /**
   * Verifica se já existe um pedido recente (não-terminal) para o mesmo ticket
   * com EXATAMENTE os mesmos itens/quantidades — evita reservas duplicadas
   * quando o cliente confirma "sim" várias vezes.
   */
  static hasRecentDuplicate(orgId: string, ticketId: string, items: { productId?: string; name: string; quantity: number }[], minutes = 60): boolean {
    if (!ticketId) return false;
    try {
      const recent = db.prepare(`
        SELECT id FROM orders
        WHERE organization_id = ? AND ticket_id = ?
          AND status NOT IN ('cancelado','reembolso','devolucao')
          AND created_at >= datetime('now', ?)
      `).all(orgId, ticketId, `-${minutes} minutes`) as any[];
      if (!recent.length) return false;

      const sig = (arr: { name: string; quantity: number }[]) =>
        arr.map(i => `${(i.name || '').toLowerCase().trim()}x${i.quantity}`).sort().join('|');
      const wanted = sig(items as any);

      for (const o of recent) {
        const its = db.prepare('SELECT name_snapshot as name, quantity FROM order_items WHERE order_id = ?').all(o.id) as any[];
        if (sig(its) === wanted) return true;
      }
      return false;
    } catch (e) {
      return false;
    }
  }

  static getOrder(orgId: string, orderId: string): any {
    const order = db.prepare('SELECT * FROM orders WHERE id = ? AND organization_id = ?').get(orderId, orgId) as any;
    if (!order) return null;
    order.items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(orderId);
    return order;
  }

  /**
   * Pedido ATIVO mais recente de um contato que ainda pode ser cancelado pelo
   * cliente (aguardando pagamento, pago ou em preparo — não cancela o que já foi entregue).
   */
  static latestCancelableOrder(orgId: string, contactId: string): any {
    return db.prepare(`
      SELECT * FROM orders
      WHERE organization_id = ? AND contact_id = ?
        AND status IN ('aguardando_pagamento','pago','em_preparo')
      ORDER BY created_at DESC LIMIT 1
    `).get(orgId, contactId);
  }
}
