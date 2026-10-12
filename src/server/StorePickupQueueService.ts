import db from "./db.js";
import { logAuthEvent } from "./auditLog.js";
import { OrdersService } from "./OrdersService.js";
import { StorePickupSignal } from "./StorePickupSignal.js";

/**
 * Fila "separar agora" da retirada na loja (ADR-207 F4).
 *
 * Fecha o buraco "vendi a última peça na loja física": depois que o cliente PAGA o pedido de
 * retirada, a equipe da loja precisa separar a peça antes que ela seja vendida no balcão. Estados
 * que a loja controla — PAGO ≠ SEPARADO ≠ PRONTO ≠ RETIRADO (cada um é um fato diferente):
 *   (sem marca) → separado → pronto → retirado
 * - Só AVANÇA (nunca volta); repetir o mesmo estado é no-op. Pedido não pago não entra na fila
 *   (a peça está só reservada — aparece à parte como "aguardando pagamento").
 * - `separado` leva o pedido a `em_preparo`; `retirado` a `entregue` — via `OrdersService`, que já
 *   sabe que o estoque foi baixado no pagamento (nada é baixado duas vezes).
 * - O alerta é um sinal em `business_signals` (StorePickupSignal), resolvido ao separar/retirar/cancelar.
 * - Escopo de loja é do chamador (a rota impõe o recorte do gerente); aqui tudo é por organização.
 * - Não manda mensagem ao cliente: aviso "pronto para retirar" é comunicação de saída (consentimento,
 *   horário) e fica fora desta fatia.
 */

export type PickupStage = "a_separar" | "separado" | "pronto" | "retirado";
const ORDER: PickupStage[] = ["a_separar", "separado", "pronto", "retirado"];
const PAID_OPEN = ["pago", "em_preparo"];

const stageOf = (row: any): PickupStage => (ORDER.includes(row?.pickup_status) ? row.pickup_status : "a_separar");

export class StorePickupQueueService {
  private static items(orderId: string) {
    return (db.prepare("SELECT name_snapshot AS name, quantity FROM order_items WHERE order_id = ? ORDER BY rowid").all(orderId) as any[])
      .map((i) => ({ name: i.name, quantity: i.quantity }));
  }

  private static customer(orgId: string, row: any): { name: string | null; phone: string | null } {
    if (row.contact_id) {
      const c = db.prepare("SELECT name, phone FROM contacts WHERE id = ? AND organization_id = ?").get(row.contact_id, orgId) as any;
      if (c) return { name: c.name || null, phone: c.phone || null };
    }
    // Cliente anônimo da vitrine: nome/telefone ficam só na observação do pedido ("Cliente: X (tel)").
    const m = /Cliente: ([^(·]+?)(?: \(([^)]*)\))?(?: ·|$)/.exec(String(row.notes || ""));
    return { name: m?.[1]?.trim() || null, phone: m?.[2]?.trim() || null };
  }

  /**
   * Fila das lojas de retirada. `storeIds` = recorte do gerente (null = todas). Sem dinheiro de propósito:
   * a equipe só precisa saber o que separar e para quem.
   */
  static queue(orgId: string, opts: { storeIds?: string[] | null; includeDone?: boolean } = {}) {
    const scope = opts.storeIds;
    if (Array.isArray(scope) && scope.length === 0) return { queue: [], awaitingPayment: [] };
    const inScope = Array.isArray(scope) ? ` AND o.pickup_store_id IN (${scope.map(() => "?").join(",")})` : "";
    const args = Array.isArray(scope) ? scope : [];
    const base = `SELECT o.id, o.status, o.pickup_store_id, o.pickup_status, o.pickup_status_at, o.reserve_expires_at, o.contact_id, o.notes, o.created_at, s.name AS store_name
                    FROM orders o LEFT JOIN retail_stores s ON s.id = o.pickup_store_id
                   WHERE o.organization_id = ? AND o.fulfillment_method = 'pickup'${inScope}`;
    const paidStatuses = opts.includeDone ? [...PAID_OPEN, "entregue", "concluido"] : PAID_OPEN;
    const paid = db.prepare(`${base} AND o.status IN (${paidStatuses.map(() => "?").join(",")}) ORDER BY o.created_at`).all(orgId, ...args, ...paidStatuses) as any[];
    const waiting = db.prepare(`${base} AND o.status = 'aguardando_pagamento' ORDER BY o.created_at`).all(orgId, ...args) as any[];
    const shape = (r: any) => ({
      orderId: r.id, orderShort: String(r.id).slice(0, 8), storeId: r.pickup_store_id, storeName: r.store_name || null,
      stage: r.status === "aguardando_pagamento" ? null : stageOf(r), stageAt: r.pickup_status_at || null,
      reserveExpiresAt: r.reserve_expires_at || null, createdAt: r.created_at,
      customer: this.customer(orgId, r), items: this.items(r.id),
    });
    // Retirado sai da fila ativa (só aparece com includeDone).
    const queue = paid.map(shape).filter((q) => opts.includeDone || q.stage !== "retirado");
    return { queue, awaitingPayment: waiting.map(shape) };
  }

  /**
   * Avança a etapa de um pedido de retirada PAGO. Nunca volta, nunca pula para fora da lista, não age
   * em pedido não pago/cancelado/de outra empresa. O recorte de loja do gerente é checado pelo chamador.
   */
  static advance(orgId: string, orderId: string, to: string, actorId?: string): { ok: true; stage: PickupStage; changed: boolean } | { ok: false; error: string } {
    if (!ORDER.includes(to as PickupStage) || to === "a_separar") return { ok: false, error: "etapa_invalida" };
    const o = db.prepare("SELECT id, status, pickup_status, fulfillment_method FROM orders WHERE id = ? AND organization_id = ?").get(orderId, orgId) as any;
    if (!o || o.fulfillment_method !== "pickup") return { ok: false, error: "pedido_nao_encontrado" };
    if (!PAID_OPEN.includes(o.status)) return { ok: false, error: o.status === "aguardando_pagamento" ? "pedido_nao_pago" : "pedido_encerrado" };
    const cur = stageOf(o);
    if (cur === to) return { ok: true, stage: cur, changed: false };
    if (ORDER.indexOf(to as PickupStage) < ORDER.indexOf(cur)) return { ok: false, error: "etapa_nao_volta" };

    const tx = db.transaction(() => {
      // Status do pedido acompanha (o estoque já foi baixado no pagamento — updateStatus não baixa de novo).
      if (to === "separado" && o.status === "pago") OrdersService.updateStatus(orgId, orderId, "em_preparo");
      if (to === "retirado") OrdersService.updateStatus(orgId, orderId, "entregue");
      db.prepare("UPDATE orders SET pickup_status = ?, pickup_status_at = CURRENT_TIMESTAMP, pickup_status_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND organization_id = ?")
        .run(to, actorId || null, orderId, orgId);
    });
    tx();
    // O alerta de "separar agora" cumpriu o papel assim que alguém separou (ou além).
    StorePickupSignal.resolve(orgId, orderId);
    try { logAuthEvent(orgId, actorId || "system", orderId, "STORE_PICKUP_STAGE", { from: cur, to }); } catch { /* noop */ }
    return { ok: true, stage: to as PickupStage, changed: true };
  }
}

export default StorePickupQueueService;
