import db from "./db.js";
import { BusinessSignalService } from "./BusinessSignalService.js";

/**
 * Sinal "separar agora" da retirada na loja (ADR-207 F4).
 *
 * Folha de propósito (só db + ledger): o `OrdersService` precisa chamá-la de forma síncrona
 * no `updateStatus`, e a fila (`StorePickupQueueService`) importa o `OrdersService` — manter
 * o sinal separado evita o ciclo. O alerta mora em `business_signals` (convenção nº 12), nunca
 * em tabela própria; o sinal NÃO carrega dinheiro (a equipe só precisa saber O QUE separar).
 */
const key = (orderId: string) => `pickup.separate|${orderId}`;

export class StorePickupSignal {
  /** Pedido de retirada PAGO → "separar agora" na loja (idempotente por pedido, best-effort). */
  static publishSeparate(orgId: string, orderId: string): void {
    try {
      const o = db.prepare("SELECT id, pickup_store_id, contact_id, reserve_expires_at FROM orders WHERE id = ? AND organization_id = ? AND fulfillment_method = 'pickup'").get(orderId, orgId) as any;
      if (!o?.pickup_store_id) return;
      const items = db.prepare("SELECT name_snapshot AS name, quantity FROM order_items WHERE order_id = ? ORDER BY rowid").all(orderId) as any[];
      const store = db.prepare("SELECT name FROM retail_stores WHERE id = ? AND organization_id = ?").get(o.pickup_store_id, orgId) as any;
      BusinessSignalService.publish(orgId, {
        domain: "retail_online", signalType: "pickup_separate_now",
        severity: "attention", basis: "fact", confidence: 1,
        sourceService: "StorePickupQueueService", sourceEntityType: "retail_store", sourceEntityId: o.pickup_store_id,
        subjectType: "order", subjectId: orderId,
        evidence: {
          orderShort: orderId.slice(0, 8), store: store?.name || null,
          items: items.map((i) => ({ name: i.name, quantity: i.quantity })),
          note: "Pedido de retirada pago — separar as peças e marcar como separado/pronto (PAGO ≠ SEPARADO ≠ RETIRADO)",
        },
        dedupeKey: key(orderId),
      });
    } catch { /* o alerta é best-effort: nunca derruba a mudança de status do pedido */ }
  }

  /** Separado/entregue/cancelado: o alerta não vale mais. */
  static resolve(orgId: string, orderId: string): void {
    try { BusinessSignalService.resolveByDedupe(orgId, key(orderId)); } catch { /* noop */ }
  }
}

export default StorePickupSignal;
