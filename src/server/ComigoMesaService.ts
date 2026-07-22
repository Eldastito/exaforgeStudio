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
      `SELECT ps.id, ps.name, ps.price, ps.type, ps.description,
              (SELECT url FROM product_images pi WHERE pi.product_service_id = ps.id ORDER BY pi.position ASC, pi.created_at ASC LIMIT 1) AS image
       FROM products_services ps
       WHERE ps.organization_id = ? AND ps.active = 1 AND ps.price IS NOT NULL ORDER BY ps.name ASC`
    ).all(orgId) as any[];
    return rows.map((r) => ({ id: r.id, name: r.name, price: round2(r.price), type: r.type, description: r.description || null, image: r.image || null }));
  }

  /** Contato liberado para fiado na loja (match do telefone por dígitos). */
  private static authorizedFiadoContact(orgId: string, phone: string) {
    const digits = String(phone || "").replace(/\D/g, "");
    if (digits.length < 8) return null;
    const rows = db.prepare(`
      SELECT cc.contact_id, cc.credit_limit, cc.blacklisted, cc.store_fiado_enabled, ct.name, ct.identifier
      FROM comigo_customer_credit cc JOIN contacts ct ON ct.id = cc.contact_id
      WHERE cc.organization_id = ? AND cc.store_fiado_enabled = 1 AND cc.blacklisted = 0 AND cc.credit_limit > 0
    `).all(orgId) as any[];
    // Casa pelos últimos 8 dígitos (tolera DDI/formatação diferente).
    const tail = digits.slice(-8);
    return rows.find((r) => String(r.identifier || "").replace(/\D/g, "").endsWith(tail)) || null;
  }

  private static balanceOf(orgId: string, contactId: string): number {
    const debt = (db.prepare("SELECT COALESCE(SUM(amount),0) s FROM comigo_fiado_ledger WHERE organization_id = ? AND contact_id = ? AND kind='debt'").get(orgId, contactId) as any).s;
    const paid = (db.prepare("SELECT COALESCE(SUM(amount),0) s FROM comigo_fiado_ledger WHERE organization_id = ? AND contact_id = ? AND kind='payment'").get(orgId, contactId) as any).s;
    return round2(debt - paid);
  }

  /**
   * Elegibilidade de fiado do cliente na loja (ADR-124): só aparece para quem o
   * dono cadastrou e liberou, e dentro do limite. Nunca confia no cliente.
   */
  static fiadoEligibility(orgId: string, phone: string, cartTotal = 0) {
    const c = this.authorizedFiadoContact(orgId, phone);
    if (!c) return { authorized: false };
    const balance = this.balanceOf(orgId, c.contact_id);
    const limit = round2(c.credit_limit);
    const available = round2(Math.max(0, limit - balance));
    return { authorized: true, contactId: c.contact_id, name: c.name || "Cliente", limit, balance, available, fits: round2(balance + (Number(cartTotal) || 0)) <= limit };
  }

  /** Cria o pedido de mesa com os itens (preço do servidor). Retorna id + total. */
  private static createMesaOrder(orgId: string, params: { items: { productId: string; qty?: number }[]; sessionAlias?: string; consumo?: string }) {
    const items = Array.isArray(params.items) ? params.items : [];
    if (!items.length) return { orderId: null as any, total: 0, added: 0 };
    const orderId = randomUUID();
    db.prepare(`INSERT INTO comigo_orders (id, organization_id, session_alias, status, consumo, total, source) VALUES (?, ?, ?, 'open', ?, 0, 'mesa')`)
      .run(orderId, orgId, (params.sessionAlias || "").slice(0, 40) || null, params.consumo === "viagem" ? "viagem" : "local");
    let total = 0; let added = 0;
    for (const it of items) {
      const p = db.prepare("SELECT id, name, price FROM products_services WHERE organization_id = ? AND id = ? AND active = 1").get(orgId, it.productId) as any;
      if (!p || p.price == null) continue;
      const qty = Math.max(1, Math.min(99, Math.floor(Number(it.qty) || 1)));
      const unit = round2(p.price);
      db.prepare(`INSERT INTO comigo_order_items (id, order_id, product_id, name, qty, unit_price, unit_cost_snapshot) VALUES (?, ?, ?, ?, ?, ?, 0)`)
        .run(randomUUID(), orderId, p.id, p.name, qty, unit);
      total += unit * qty; added++;
    }
    if (!added) { db.prepare("DELETE FROM comigo_orders WHERE id = ?").run(orderId); return { orderId: null as any, total: 0, added: 0 }; }
    total = round2(total);
    db.prepare("UPDATE comigo_orders SET total = ? WHERE id = ?").run(total, orderId);
    return { orderId, total, added };
  }

  /**
   * Cria o pedido do cliente. `payment='pix'` (pay-first, Pix dinâmico) ou
   * `payment='fiado'` (só p/ cliente cadastrado e liberado, dentro do limite).
   */
  static placeOrder(orgId: string, params: { items: { productId: string; qty?: number }[]; sessionAlias?: string; consumo?: string; payment?: string; customer?: { phone?: string } }) {
    if (!Array.isArray(params.items) || !params.items.length) return { ok: false, error: "empty_cart" };

    // FIADO autorizado (ADR-124): valida ANTES de criar o pedido.
    if (params.payment === "fiado") {
      const phone = params.customer?.phone || "";
      // Pré-calcula o total pra checar o limite (preço do servidor).
      const draft = this.createMesaOrder(orgId, params);
      if (!draft.orderId) return { ok: false, error: "no_valid_items" };
      const elig = this.fiadoEligibility(orgId, phone, draft.total);
      if (!elig.authorized) { db.prepare("DELETE FROM comigo_orders WHERE id = ?").run(draft.orderId); db.prepare("DELETE FROM comigo_order_items WHERE order_id = ?").run(draft.orderId); return { ok: false, error: "fiado_not_authorized" }; }
      if (!elig.fits) { db.prepare("DELETE FROM comigo_orders WHERE id = ?").run(draft.orderId); db.prepare("DELETE FROM comigo_order_items WHERE order_id = ?").run(draft.orderId); return { ok: false, error: "fiado_over_limit", available: elig.available }; }
      // Grava a dívida e fecha o pedido como fiado — entra na fila de preparo.
      db.prepare(`INSERT INTO comigo_fiado_ledger (id, organization_id, contact_id, order_id, kind, amount) VALUES (?, ?, ?, ?, 'debt', ?)`)
        .run(randomUUID(), orgId, elig.contactId, draft.orderId, draft.total);
      db.prepare("UPDATE comigo_orders SET status = 'done', paid_via = 'fiado', contact_id = ? WHERE id = ?").run(elig.contactId, draft.orderId);
      return { ok: true, orderId: draft.orderId, total: draft.total, fiado: true };
    }

    // PIX dinâmico (pay-first).
    const draft = this.createMesaOrder(orgId, params);
    if (!draft.orderId) return { ok: false, error: "no_valid_items" };
    const charge = ComigoPixService.createCharge(orgId, draft.orderId) as any;
    if (!charge.ok) return { ok: false, error: charge.error || "charge_failed" };
    return { ok: true, orderId: draft.orderId, total: draft.total, txid: charge.txid, qrPayload: charge.qrPayload };
  }

  /** Status do pedido para o cliente (polling). */
  static orderStatus(orgId: string, orderId: string) {
    const o = db.prepare("SELECT status, paid_via, fulfilled_at FROM comigo_orders WHERE organization_id = ? AND id = ? AND source = 'mesa'").get(orgId, orderId) as any;
    if (!o) return { found: false };
    return { found: true, status: o.status, paid: o.status === "paid" || o.status === "done", paidVia: o.paid_via || null, fulfilled: !!o.fulfilled_at };
  }

  /** Fila de preparo: pedidos de mesa PAGOS (Pix) ou FIADO autorizado, não entregues. */
  static prepQueue(orgId: string) {
    const orders = db.prepare(
      "SELECT id, session_alias, consumo, total, paid_via, COALESCE(paid_at, created_at) AS at FROM comigo_orders WHERE organization_id = ? AND source = 'mesa' AND status IN ('paid','done') AND fulfilled_at IS NULL ORDER BY at ASC"
    ).all(orgId) as any[];
    return orders.map((o) => ({
      ...o,
      items: db.prepare("SELECT name, qty FROM comigo_order_items WHERE order_id = ?").all(o.id),
    }));
  }

  static markFulfilled(orgId: string, orderId: string): boolean {
    const r = db.prepare("UPDATE comigo_orders SET fulfilled_at = CURRENT_TIMESTAMP WHERE organization_id = ? AND id = ? AND source = 'mesa' AND status IN ('paid','done') AND fulfilled_at IS NULL")
      .run(orgId, orderId);
    return r.changes > 0;
  }
}

export default ComigoMesaService;
