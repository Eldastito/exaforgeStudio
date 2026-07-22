import db from "./db.js";
import { randomUUID } from "crypto";
import { ComigoPixService } from "./ComigoPixService.js";

/**
 * ZappFlow Comigo — Mesa/QR autoatendimento pay-first (ADR-119 / ADR-088 D4).
 *
 * O cliente lê o QR → cardápio → pede → PAGA (Pix dinâmico, ADR-118) → só então
 * o pedido cai na fila de preparo do Balcão. Sem atendente, sem login. Preço é
 * SEMPRE do servidor (nunca do cliente). Isolado por organization_id.
 */

const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

export class ComigoMesaService {
  /** Garante (e devolve) o token do QR da organização. */
  static ensureToken(orgId: string): string {
    const row = db.prepare("SELECT comigo_mesa_token FROM organization_settings WHERE organization_id = ?").get(orgId) as any;
    if (row?.comigo_mesa_token) return row.comigo_mesa_token;
    const token = `mesa_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
    db.prepare("UPDATE organization_settings SET comigo_mesa_token = ? WHERE organization_id = ?").run(token, orgId);
    return token;
  }

  static regenerate(orgId: string): string {
    const token = `mesa_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
    db.prepare("UPDATE organization_settings SET comigo_mesa_token = ? WHERE organization_id = ?").run(token, orgId);
    return token;
  }

  static orgByToken(token: string): string | null {
    if (!token) return null;
    const o = db.prepare("SELECT organization_id FROM organization_settings WHERE comigo_mesa_token = ?").get(token) as any;
    return o?.organization_id || null;
  }

  /** Cardápio: produtos ativos com preço do servidor. */
  static menu(orgId: string) {
    const rows = db.prepare(
      "SELECT id, name, price, type FROM products_services WHERE organization_id = ? AND active = 1 AND price IS NOT NULL ORDER BY name ASC"
    ).all(orgId) as any[];
    return rows.map((r) => ({ id: r.id, name: r.name, price: round2(r.price), type: r.type }));
  }

  /**
   * Pay-first: cria o pedido (source='mesa', preço do SERVIDOR) e a cobrança Pix
   * dinâmica. O pedido só entra na fila de preparo quando o Pix confirmar.
   */
  static placeOrder(orgId: string, params: { items: { productId: string; qty?: number }[]; sessionAlias?: string; consumo?: string }) {
    const items = Array.isArray(params.items) ? params.items : [];
    if (!items.length) return { ok: false, error: "empty_cart" };

    const orderId = randomUUID();
    db.prepare(`INSERT INTO comigo_orders (id, organization_id, session_alias, status, consumo, total, source) VALUES (?, ?, ?, 'open', ?, 0, 'mesa')`)
      .run(orderId, orgId, (params.sessionAlias || "").slice(0, 40) || null, params.consumo === "viagem" ? "viagem" : "local");

    let total = 0; let added = 0;
    for (const it of items) {
      const p = db.prepare("SELECT id, name, price FROM products_services WHERE organization_id = ? AND id = ? AND active = 1").get(orgId, it.productId) as any;
      if (!p || p.price == null) continue; // ignora item inválido/inativo (nunca confia no cliente)
      const qty = Math.max(1, Math.min(99, Math.floor(Number(it.qty) || 1)));
      const unit = round2(p.price);
      db.prepare(`INSERT INTO comigo_order_items (id, order_id, product_id, name, qty, unit_price, unit_cost_snapshot) VALUES (?, ?, ?, ?, ?, ?, 0)`)
        .run(randomUUID(), orderId, p.id, p.name, qty, unit);
      total += unit * qty; added++;
    }
    if (!added) {
      db.prepare("DELETE FROM comigo_orders WHERE id = ?").run(orderId);
      return { ok: false, error: "no_valid_items" };
    }
    db.prepare("UPDATE comigo_orders SET total = ? WHERE id = ?").run(round2(total), orderId);

    const charge = ComigoPixService.createCharge(orgId, orderId) as any;
    if (!charge.ok) return { ok: false, error: charge.error || "charge_failed" };
    return { ok: true, orderId, total: round2(total), txid: charge.txid, qrPayload: charge.qrPayload };
  }

  /** Status do pedido para o cliente (polling). */
  static orderStatus(orgId: string, orderId: string) {
    const o = db.prepare("SELECT status, paid_via, fulfilled_at FROM comigo_orders WHERE organization_id = ? AND id = ? AND source = 'mesa'").get(orgId, orderId) as any;
    if (!o) return { found: false };
    return { found: true, status: o.status, paid: o.status === "paid" || o.status === "done", paidVia: o.paid_via || null, fulfilled: !!o.fulfilled_at };
  }

  /** Fila de preparo: pedidos de mesa PAGOS e ainda não entregues. */
  static prepQueue(orgId: string) {
    const orders = db.prepare(
      "SELECT id, session_alias, consumo, total, paid_at FROM comigo_orders WHERE organization_id = ? AND source = 'mesa' AND status = 'paid' AND fulfilled_at IS NULL ORDER BY paid_at ASC"
    ).all(orgId) as any[];
    return orders.map((o) => ({
      ...o,
      items: db.prepare("SELECT name, qty FROM comigo_order_items WHERE order_id = ?").all(o.id),
    }));
  }

  static markFulfilled(orgId: string, orderId: string): boolean {
    const r = db.prepare("UPDATE comigo_orders SET fulfilled_at = CURRENT_TIMESTAMP WHERE organization_id = ? AND id = ? AND source = 'mesa' AND status = 'paid' AND fulfilled_at IS NULL")
      .run(orgId, orderId);
    return r.changes > 0;
  }
}

export default ComigoMesaService;
