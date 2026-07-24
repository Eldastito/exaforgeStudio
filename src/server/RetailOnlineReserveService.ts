import db from "./db.js";
import { randomUUID } from "crypto";
import { logAuthEvent } from "./auditLog.js";

/**
 * Loja Virtual → PDV (ADR-143 Fase 0) — reserva e-commerce + baixa pendente.
 *
 * Resolve o conflito dos "dois vendedores" SEM depender da Alterdata:
 *  - D1: a loja virtual vende de um POOL RESERVADO por loja/produto (Saldo do
 *    ERP − buffer). `available = qty_reserved − baixas pendentes`. Reserva
 *    esgotada BLOQUEIA a venda → nunca vende o que não tem (sem oversell).
 *  - D3: cada venda online vira uma BAIXA PENDENTE (por order/item). Na
 *    sobrescrita absoluta do Saldo (sync Alterdata), `netStoreQty` re-aplica as
 *    pendentes — a venda online para de sumir (anti-clobber). Quando o operador
 *    lança a baixa no PDV (Fase 0 manual) ou o write-back confirma (Fase 1), a
 *    pendência vira `confirmed` e deixa de ser descontada.
 *
 * Determinístico, idempotente por (order, item), opt-in por org, isolado.
 */

const vk = (variantId?: string | null) => (variantId ? String(variantId) : "");
const trunc = (n: any) => Math.trunc(Number(n) || 0);

export interface OnlineSaleItem { productId: string; variantId?: string | null; qty: number; }

export class RetailOnlineReserveService {
  static isEnabled(orgId: string): boolean {
    try {
      const r = db.prepare("SELECT online_store_reserve FROM organization_settings WHERE organization_id = ?").get(orgId) as any;
      return !!Number(r?.online_store_reserve);
    } catch { return false; }
  }
  static setEnabled(orgId: string, on: boolean): boolean {
    db.prepare("UPDATE organization_settings SET online_store_reserve = ? WHERE organization_id = ?").run(on ? 1 : 0, orgId);
    return this.isEnabled(orgId);
  }

  /** Filial da qual a LOJA VIRTUAL (checkout público) vende. NULL = não aplica. */
  static getOnlineStoreId(orgId: string): string | null {
    try {
      const r = db.prepare("SELECT online_store_id FROM organization_settings WHERE organization_id = ?").get(orgId) as any;
      return r?.online_store_id || null;
    } catch { return null; }
  }
  static setOnlineStoreId(orgId: string, storeId: string | null): string | null {
    db.prepare("UPDATE organization_settings SET online_store_id = ? WHERE organization_id = ?").run(storeId || null, orgId);
    return this.getOnlineStoreId(orgId);
  }

  // ── Reserva e-commerce (D1) ───────────────────────────────────────────────────
  static setReserve(orgId: string, storeId: string, productId: string, variantId: string | null | undefined, qty: number, actorId?: string): any {
    db.prepare(
      `INSERT INTO retail_online_reserve (id, organization_id, store_id, product_service_id, variant_id, qty_reserved, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(organization_id, store_id, product_service_id, variant_id) DO UPDATE SET
         qty_reserved = excluded.qty_reserved, updated_at = CURRENT_TIMESTAMP`
    ).run(randomUUID(), orgId, storeId, productId, vk(variantId), Math.max(0, trunc(qty)));
    try { logAuthEvent(orgId, actorId || "system", storeId, "RETAIL_ONLINE_RESERVE_SET", { productId, variantId: vk(variantId), qty: Math.max(0, trunc(qty)) }); } catch { /* noop */ }
    return this.getReserve(orgId, storeId, productId, variantId);
  }
  static getReserve(orgId: string, storeId: string, productId: string, variantId?: string | null): any | null {
    return (db.prepare("SELECT * FROM retail_online_reserve WHERE organization_id=? AND store_id=? AND product_service_id=? AND variant_id=?").get(orgId, storeId, productId, vk(variantId)) as any) || null;
  }
  static listReserves(orgId: string, storeId?: string): any[] {
    const base = `SELECT r.*, s.name AS store_name, p.name AS product_name,
                         (r.qty_reserved - COALESCE((SELECT SUM(w.qty) FROM retail_online_writeback w
                            WHERE w.organization_id=r.organization_id AND w.store_id=r.store_id
                              AND w.product_service_id=r.product_service_id AND w.variant_id=r.variant_id
                              AND w.status='pending'),0)) AS available
                    FROM retail_online_reserve r
               LEFT JOIN retail_stores s ON s.id = r.store_id
               LEFT JOIN products_services p ON p.id = r.product_service_id
                   WHERE r.organization_id = ?`;
    if (storeId) return db.prepare(`${base} AND r.store_id = ? ORDER BY p.name`).all(orgId, storeId) as any[];
    return db.prepare(`${base} ORDER BY s.name, p.name`).all(orgId) as any[];
  }

  /** Remove a reserva de um produto/variante numa loja. */
  static removeReserve(orgId: string, storeId: string, productId: string, variantId?: string | null, actorId?: string): { ok: boolean } {
    const r = db.prepare("DELETE FROM retail_online_reserve WHERE organization_id=? AND store_id=? AND product_service_id=? AND variant_id=?").run(orgId, storeId, productId, vk(variantId));
    if (r.changes > 0) { try { logAuthEvent(orgId, actorId || "system", storeId, "RETAIL_ONLINE_RESERVE_REMOVED", { productId, variantId: vk(variantId) }); } catch { /* noop */ } }
    return { ok: r.changes > 0 };
  }

  /** Soma das baixas AINDA pendentes de um produto/variante numa loja. */
  static pendingQty(orgId: string, storeId: string, productId: string, variantId?: string | null): number {
    const r = db.prepare("SELECT COALESCE(SUM(qty),0) s FROM retail_online_writeback WHERE organization_id=? AND store_id=? AND product_service_id=? AND variant_id=? AND status='pending'").get(orgId, storeId, productId, vk(variantId)) as any;
    return trunc(r?.s);
  }

  /** Quanto a loja virtual ainda pode vender: reserva − baixas pendentes. */
  static available(orgId: string, storeId: string, productId: string, variantId?: string | null): number {
    const r = this.getReserve(orgId, storeId, productId, variantId);
    if (!r) return 0; // sem reserva definida → a loja virtual não vende (seguro).
    return trunc(r.qty_reserved) - this.pendingQty(orgId, storeId, productId, variantId);
  }

  /** Saldo por-loja reconciliado (D3): saldo do ERP menos as baixas online pendentes. */
  static netStoreQty(orgId: string, storeId: string, productId: string, variantId: string | null | undefined, erpQty: number): number {
    return trunc(erpQty) - this.pendingQty(orgId, storeId, productId, variantId);
  }

  // ── Venda online → baixa pendente (D1 bloqueio + D3 ledger) ───────────────────
  /**
   * Registra a venda online como baixas pendentes, bloqueando se a reserva não
   * cobrir (sem oversell). Idempotente por `order_id` (re-registrar não duplica).
   */
  static recordSale(orgId: string, input: { orderId: string; storeId: string; items: OnlineSaleItem[] }, actorId?: string): { ok: boolean; skipped?: boolean; deduped?: boolean; recorded?: number; blocked?: Array<{ productId: string; variantId: string; requested: number; available: number }> } {
    if (!this.isEnabled(orgId)) return { ok: true, skipped: true };
    const items = (input.items || []).filter((i) => i && i.productId && trunc(i.qty) > 0);
    if (!input.storeId || !items.length) return { ok: true, skipped: true };

    // Idempotência: se já há baixa para este pedido, não re-registra.
    const already = db.prepare("SELECT COUNT(*) c FROM retail_online_writeback WHERE organization_id=? AND order_id=?").get(orgId, input.orderId) as any;
    if (Number(already?.c) > 0) return { ok: true, deduped: true };

    // Bloqueio por reserva (D1): agrega por produto/variante e confere available.
    const blocked: Array<{ productId: string; variantId: string; requested: number; available: number }> = [];
    const agg = new Map<string, { productId: string; variantId: string; qty: number }>();
    for (const it of items) {
      const key = `${it.productId}|${vk(it.variantId)}`;
      const cur = agg.get(key) || { productId: it.productId, variantId: vk(it.variantId), qty: 0 };
      cur.qty += trunc(it.qty); agg.set(key, cur);
    }
    for (const a of agg.values()) {
      const avail = this.available(orgId, input.storeId, a.productId, a.variantId);
      if (a.qty > avail) blocked.push({ productId: a.productId, variantId: a.variantId, requested: a.qty, available: avail });
    }
    if (blocked.length) return { ok: false, blocked };

    const ins = db.prepare("INSERT INTO retail_online_writeback (id, organization_id, order_id, store_id, product_service_id, variant_id, qty, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')");
    let recorded = 0;
    for (const a of agg.values()) { ins.run(randomUUID(), orgId, input.orderId, input.storeId, a.productId, a.variantId, a.qty); recorded++; }
    try { logAuthEvent(orgId, actorId || "system", input.orderId, "RETAIL_ONLINE_SALE_RECORDED", { storeId: input.storeId, recorded }); } catch { /* noop */ }
    return { ok: true, recorded };
  }

  /** Baixas pendentes (para o operador lançar no PDV — Fase 0 manual assistida). */
  static listPending(orgId: string, opts: { storeId?: string } = {}): any[] {
    const base = `SELECT w.*, s.name AS store_name, p.name AS product_name
                    FROM retail_online_writeback w
               LEFT JOIN retail_stores s ON s.id = w.store_id
               LEFT JOIN products_services p ON p.id = w.product_service_id
                   WHERE w.organization_id = ? AND w.status = 'pending'`;
    if (opts.storeId) return db.prepare(`${base} AND w.store_id = ? ORDER BY w.created_at`).all(orgId, opts.storeId) as any[];
    return db.prepare(`${base} ORDER BY w.created_at`).all(orgId) as any[];
  }

  /** Confirma a baixa (operador lançou no PDV / write-back confirmou). Por pedido. */
  static confirmByOrder(orgId: string, orderId: string, actorId?: string): { ok: boolean; confirmed: number } {
    const r = db.prepare("UPDATE retail_online_writeback SET status='confirmed', updated_at=CURRENT_TIMESTAMP WHERE organization_id=? AND order_id=? AND status='pending'").run(orgId, orderId);
    if (r.changes > 0) { try { logAuthEvent(orgId, actorId || "system", orderId, "RETAIL_ONLINE_WRITEBACK_CONFIRMED", { confirmed: r.changes }); } catch { /* noop */ } }
    return { ok: true, confirmed: r.changes };
  }

  /**
   * Libera a reserva de um pedido (cancelado/estornado): remove as baixas AINDA
   * pendentes — o estoque online volta a ficar disponível. Baixas já confirmadas
   * (lançadas no PDV) não são tocadas. Idempotente.
   */
  static releaseByOrder(orgId: string, orderId: string, actorId?: string): { ok: boolean; released: number } {
    const r = db.prepare("DELETE FROM retail_online_writeback WHERE organization_id=? AND order_id=? AND status='pending'").run(orgId, orderId);
    if (r.changes > 0) { try { logAuthEvent(orgId, actorId || "system", orderId, "RETAIL_ONLINE_WRITEBACK_RELEASED", { released: r.changes }); } catch { /* noop */ } }
    return { ok: true, released: r.changes };
  }

  /** Confirma uma baixa específica pelo id da linha. */
  static confirmItem(orgId: string, id: string, actorId?: string): { ok: boolean } {
    const r = db.prepare("UPDATE retail_online_writeback SET status='confirmed', updated_at=CURRENT_TIMESTAMP WHERE organization_id=? AND id=? AND status='pending'").run(orgId, id);
    if (r.changes > 0) { try { logAuthEvent(orgId, actorId || "system", id, "RETAIL_ONLINE_WRITEBACK_CONFIRMED", { confirmed: 1 }); } catch { /* noop */ } }
    return { ok: r.changes > 0 };
  }
}

export default RetailOnlineReserveService;
