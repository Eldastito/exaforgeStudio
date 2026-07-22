import db from "./db.js";
import { randomUUID, createHash } from "crypto";
import { PaymentService } from "./PaymentService.js";

/**
 * ZappFlow Comigo — Pix dinâmico com webhook (ADR-118 / ADR-088 D3 nível 2).
 *
 * QR com txid único → o PSP confirma por webhook → o pedido libera sozinho.
 * Concilia por txid, idempotente. Provider plugável (mock p/ dev/teste; PSP real
 * — Mercado Pago/Efí/Asaas/Cora — liga por config). NUNCA lê notificação de
 * banco (ADR-088 D3). Isolado por organization_id.
 */

const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

// Payload copia-e-cola do provider mock — determinístico a partir do txid/valor
// (formato inspirado no BR Code; suficiente p/ dev/teste, real vem do PSP).
function mockPayload(txid: string, amount: number): string {
  const digest = createHash("sha256").update(`${txid}:${amount}`).digest("hex").slice(0, 12).toUpperCase();
  return `00020126BR.GOV.BCB.PIX-COMIGO-MOCK-${txid}-${round2(amount).toFixed(2)}-${digest}`;
}

export class ComigoPixService {
  static provider(): string { return process.env.COMIGO_PIX_PROVIDER || "mock"; }

  /**
   * Cria (ou reusa) a cobrança Pix dinâmica de um pedido aberto. Idempotente por
   * pedido: se já há uma cobrança pendente, devolve a mesma.
   */
  static createCharge(orgId: string, orderId: string) {
    const order = db.prepare("SELECT id, status, total FROM comigo_orders WHERE organization_id = ? AND id = ?").get(orgId, orderId) as any;
    if (!order) return { ok: false, error: "order_not_found" };
    if (order.status !== "open") return { ok: false, error: "order_not_open" };
    const amount = round2(order.total);
    if (!(amount > 0)) return { ok: false, error: "empty_order" };

    const pending = db.prepare("SELECT * FROM comigo_pix_charges WHERE organization_id = ? AND order_id = ? AND status = 'pending'").get(orgId, orderId) as any;
    if (pending) return { ok: true, chargeId: pending.id, txid: pending.txid, qrPayload: pending.qr_payload, amount: pending.amount, provider: pending.provider, reused: true };

    const id = randomUUID();
    const txid = `cmg${id.replace(/-/g, "").slice(0, 26)}`; // txid Pix: alfanumérico, ≤ 35
    const provider = this.provider();
    const qrPayload = mockPayload(txid, amount);
    db.prepare(`INSERT INTO comigo_pix_charges (id, organization_id, order_id, txid, amount, status, provider, qr_payload) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`)
      .run(id, orgId, orderId, txid, amount, provider, qrPayload);
    return { ok: true, chargeId: id, txid, qrPayload, amount, provider, reused: false };
  }

  /**
   * Confirma por txid (chamado pelo webhook do PSP). Idempotente: reentrega ou
   * cobrança já paga não paga em dobro; só fecha pedido ainda 'open'.
   */
  static confirmByTxid(orgId: string, txid: string, e2eId?: string) {
    const charge = db.prepare("SELECT * FROM comigo_pix_charges WHERE organization_id = ? AND txid = ?").get(orgId, txid) as any;
    if (!charge) return { ok: false, error: "charge_not_found" };
    if (charge.status === "paid") return { ok: true, alreadyPaid: true, orderId: charge.order_id };

    db.prepare("UPDATE comigo_pix_charges SET status = 'paid', paid_at = CURRENT_TIMESTAMP, e2e_id = ? WHERE id = ?").run(e2eId || null, charge.id);
    // Fecha o pedido como pago via Pix dinâmico — só se ainda estava aberto
    // (evita sobrescrever um pedido que o operador já fechou de outro jeito).
    const upd = db.prepare("UPDATE comigo_orders SET status = 'paid', paid_via = 'pix_dyn', paid_at = CURRENT_TIMESTAMP WHERE organization_id = ? AND id = ? AND status = 'open'")
      .run(orgId, charge.order_id);
    return { ok: true, orderId: charge.order_id, orderClosed: upd.changes > 0 };
  }

  /** Webhook do PSP: autentica pelo segredo da org e concilia por txid. */
  static handleWebhook(secret: string, body: any): { status: "ok" | "unauthorized" | "ignored"; orgId?: string } {
    const orgId = PaymentService.orgByWebhookSecret(secret);
    if (!orgId) return { status: "unauthorized" };
    const txid = String(body?.txid || body?.data?.txid || "").trim();
    const paid = body?.status ? ["paid", "approved", "pago", "concluida", "completed"].includes(String(body.status).toLowerCase()) : true;
    if (!txid || !paid) return { status: "ignored", orgId };
    this.confirmByTxid(orgId, txid, body?.e2eId || body?.endToEndId);
    return { status: "ok", orgId };
  }

  /** Última cobrança do pedido (para o Balcão fazer polling). */
  static statusOf(orgId: string, orderId: string) {
    const c = db.prepare("SELECT id, txid, amount, status, qr_payload, provider FROM comigo_pix_charges WHERE organization_id = ? AND order_id = ? ORDER BY created_at DESC LIMIT 1").get(orgId, orderId) as any;
    const order = db.prepare("SELECT status, paid_via FROM comigo_orders WHERE organization_id = ? AND id = ?").get(orgId, orderId) as any;
    return { charge: c || null, orderStatus: order?.status || null, paidVia: order?.paid_via || null };
  }
}

export default ComigoPixService;
