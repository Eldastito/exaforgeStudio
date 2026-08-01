import db from "./db.js";
import { randomUUID, createHash } from "crypto";
import { PaymentService } from "./PaymentService.js";

/**
 * ZappFlow Comigo — Pix dinâmico com webhook (ADR-118 / ADR-088 D3 nível 2).
 *
 * QR com txid único → o PSP confirma por webhook → o pedido libera sozinho.
 * Concilia por txid/external_reference, idempotente. Provider plugável:
 *  - `mock`         → payload determinístico (dev/teste, comportamento original).
 *  - `mercadopago`  → Gap G, ADR-149: cria cobrança real via MP `/v1/payments`,
 *                     confirma via webhook `/api/webhooks/payment` que existe
 *                     (rota `syncMercadoPagoPayment` roteia `external_reference`
 *                     `cmg:<orderId>` pra este service).
 * NUNCA lê notificação de banco (ADR-088 D3). Isolado por organization_id.
 */

const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

// Payload copia-e-cola do provider mock — determinístico a partir do txid/valor
// (formato inspirado no BR Code; suficiente p/ dev/teste, real vem do PSP).
function mockPayload(txid: string, amount: number): string {
  const digest = createHash("sha256").update(`${txid}:${amount}`).digest("hex").slice(0, 12).toUpperCase();
  return `00020126BR.GOV.BCB.PIX-COMIGO-MOCK-${txid}-${round2(amount).toFixed(2)}-${digest}`;
}

// ── Injeção pro teste (fetch mock pra MP) ──────────────────────────────────
// Mesmo padrão consagrado do repo (ComigoImpactService/MenuSuggestService).
// O fetchFn default é o global fetch — sobrescrever nos testes evita bater na
// API real do Mercado Pago.
type FetchFn = (input: any, init?: any) => Promise<any>;
let fetchFn: FetchFn = ((globalThis as any).fetch?.bind(globalThis)) as FetchFn;
export const _internals = {
  setFetchFn(fn: FetchFn | null) {
    fetchFn = fn || (((globalThis as any).fetch?.bind(globalThis)) as FetchFn);
  },
};

// ── Helpers do provider Mercado Pago ───────────────────────────────────────

const MP_API = "https://api.mercadopago.com";

/** Lê o access token cifrado da org (mesma coluna que PaymentService usa). */
function mpToken(orgId: string): string | null {
  const o = db.prepare(
    `SELECT pay_gateway_token FROM organization_settings WHERE organization_id = ?`
  ).get(orgId) as any;
  return (o?.pay_gateway_token && String(o.pay_gateway_token).trim()) || null;
}

/** URL de notificação da org (mesma que PaymentService usa — reusa o segredo). */
function notificationUrl(orgId: string): string | null {
  const base = (process.env.APP_URL || "").replace(/\/$/, "");
  if (!base) return null;
  const o = db.prepare(
    `SELECT pay_webhook_secret FROM organization_settings WHERE organization_id = ?`
  ).get(orgId) as any;
  let secret = o?.pay_webhook_secret as string | undefined;
  if (!secret) {
    try { secret = PaymentService.rotateWebhookSecret(orgId); } catch { /* sem base, sem URL — segue sem */ }
  }
  return secret ? `${base}/api/webhooks/payment?secret=${secret}` : null;
}

/**
 * Cria cobrança real no Mercado Pago. Retorna dados normalizados ou null se
 * falhar (rede/API sem token/etc.) — o caller cai pro mock nesse caso.
 * `external_reference` = `cmg:<orderId>` — é o que o webhook usa pra rotear.
 */
async function createMpCharge(orgId: string, orderId: string, amount: number): Promise<{ paymentId: string; qrCode: string; qrCodeBase64: string; ticketUrl: string } | null> {
  const token = mpToken(orgId);
  if (!token) return null;
  const body: any = {
    transaction_amount: Number(round2(amount).toFixed(2)),
    description: `Comigo #${String(orderId).slice(0, 8)}`,
    payment_method_id: "pix",
    external_reference: `cmg:${orderId}`,
    payer: {
      email: `comigo-${String(orderId).replace(/[^a-z0-9]/gi, "").slice(0, 16)}@checkout.exaforge.app`,
      first_name: "Cliente",
    },
  };
  const notifUrl = notificationUrl(orgId);
  if (notifUrl) body.notification_url = notifUrl;
  try {
    const res = await fetchFn(`${MP_API}/v1/payments`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        // Idempotency-Key: garante que reintentar não crie 2 cobranças no MP.
        "X-Idempotency-Key": `cmg-${orderId}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      console.error("[ComigoPix/MP] falha ao criar Pix:", res.status);
      return null;
    }
    const data: any = await res.json().catch(() => ({}));
    const tx = data?.point_of_interaction?.transaction_data || {};
    const qrCode: string = tx.qr_code || "";
    const qrCodeBase64: string = tx.qr_code_base64 || "";
    const ticketUrl: string = tx.ticket_url || "";
    const paymentId = String(data.id || "");
    if (!paymentId || !qrCode) {
      console.error("[ComigoPix/MP] resposta sem qr_code/id.");
      return null;
    }
    return { paymentId, qrCode, qrCodeBase64, ticketUrl };
  } catch (e) {
    console.error("[ComigoPix/MP] erro de rede:", e);
    return null;
  }
}

export class ComigoPixService {
  static provider(): string { return process.env.COMIGO_PIX_PROVIDER || "mock"; }

  /**
   * Cria (ou reusa) a cobrança Pix dinâmica de um pedido aberto. Idempotente por
   * pedido: se já há uma cobrança pendente, devolve a mesma (sem chamar o PSP).
   *
   * Quando provider = 'mercadopago' e a org tem token, chama a API do MP e
   * grava qr_code_base64 + external_id (payment id do MP). Se o MP falhar,
   * NÃO cai pro mock silenciosamente — devolve erro pro caller decidir. Cair
   * pro mock aqui seria enganar o operador ("ah, o Pix apareceu, mas ninguém
   * paga porque é um QR falso"). Melhor errar e mostrar UI de reintentar.
   */
  static async createCharge(orgId: string, orderId: string): Promise<{ ok: true; chargeId: string; txid: string; qrPayload: string; qrCodeBase64?: string; amount: number; provider: string; reused: boolean; ticketUrl?: string } | { ok: false; error: string }> {
    const order = db.prepare("SELECT id, status, total FROM comigo_orders WHERE organization_id = ? AND id = ?").get(orgId, orderId) as any;
    if (!order) return { ok: false, error: "order_not_found" };
    if (order.status !== "open") return { ok: false, error: "order_not_open" };
    const amount = round2(order.total);
    if (!(amount > 0)) return { ok: false, error: "empty_order" };

    const pending = db.prepare("SELECT * FROM comigo_pix_charges WHERE organization_id = ? AND order_id = ? AND status = 'pending'").get(orgId, orderId) as any;
    if (pending) {
      return { ok: true, chargeId: pending.id, txid: pending.txid, qrPayload: pending.qr_payload, qrCodeBase64: pending.qr_code_base64 || undefined, amount: pending.amount, provider: pending.provider, reused: true };
    }

    const id = randomUUID();
    const provider = this.provider();

    if (provider === "mercadopago") {
      const mp = await createMpCharge(orgId, orderId, amount);
      if (!mp) return { ok: false, error: "provider_failed" };
      // txid pro Comigo é o próprio payment id do MP — único e curto o bastante.
      const txid = mp.paymentId.slice(0, 35);
      db.prepare(
        `INSERT INTO comigo_pix_charges (id, organization_id, order_id, txid, amount, status, provider, qr_payload, qr_code_base64, external_id) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`
      ).run(id, orgId, orderId, txid, amount, provider, mp.qrCode, mp.qrCodeBase64 || null, mp.paymentId);
      return { ok: true, chargeId: id, txid, qrPayload: mp.qrCode, qrCodeBase64: mp.qrCodeBase64 || undefined, amount, provider, reused: false, ticketUrl: mp.ticketUrl || undefined };
    }

    // Fallback mock (comportamento original, dev/teste).
    const txid = `cmg${id.replace(/-/g, "").slice(0, 26)}`;
    const qrPayload = mockPayload(txid, amount);
    db.prepare(
      `INSERT INTO comigo_pix_charges (id, organization_id, order_id, txid, amount, status, provider, qr_payload) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`
    ).run(id, orgId, orderId, txid, amount, provider, qrPayload);
    return { ok: true, chargeId: id, txid, qrPayload, amount, provider, reused: false };
  }

  /**
   * Confirma por txid (mock: quem chama o webhook `/api/webhooks/comigo-pix`).
   * Idempotente: reentrega ou cobrança já paga não paga em dobro; só fecha
   * pedido ainda 'open' (não sobrescreve pagamento manual).
   */
  static confirmByTxid(orgId: string, txid: string, e2eId?: string) {
    const charge = db.prepare("SELECT * FROM comigo_pix_charges WHERE organization_id = ? AND txid = ?").get(orgId, txid) as any;
    if (!charge) return { ok: false, error: "charge_not_found" };
    if (charge.status === "paid") return { ok: true, alreadyPaid: true, orderId: charge.order_id };

    db.prepare("UPDATE comigo_pix_charges SET status = 'paid', paid_at = CURRENT_TIMESTAMP, e2e_id = ? WHERE id = ?").run(e2eId || null, charge.id);
    const upd = db.prepare("UPDATE comigo_orders SET status = 'paid', paid_via = 'pix_dyn', paid_at = CURRENT_TIMESTAMP WHERE organization_id = ? AND id = ? AND status = 'open'")
      .run(orgId, charge.order_id);
    return { ok: true, orderId: charge.order_id, orderClosed: upd.changes > 0 };
  }

  /**
   * Confirma por external_reference (chamada pelo webhook geral `/api/webhooks/payment`,
   * via `PaymentService.syncMercadoPagoPayment` — o MP devolve `external_reference`
   * = "cmg:<orderId>"). Localiza a cobrança pendente pelo pedido, marca paga.
   * Idempotente na chamada e no fechamento do pedido.
   */
  static confirmByReference(orgId: string, orderId: string, externalPaymentId?: string) {
    const charge = db.prepare("SELECT * FROM comigo_pix_charges WHERE organization_id = ? AND order_id = ? ORDER BY created_at DESC LIMIT 1").get(orgId, orderId) as any;
    if (!charge) return { ok: false, error: "charge_not_found" };
    if (charge.status === "paid") return { ok: true, alreadyPaid: true, orderId };

    db.prepare("UPDATE comigo_pix_charges SET status = 'paid', paid_at = CURRENT_TIMESTAMP, external_id = COALESCE(external_id, ?) WHERE id = ?").run(externalPaymentId || null, charge.id);
    const upd = db.prepare("UPDATE comigo_orders SET status = 'paid', paid_via = 'pix_dyn', paid_at = CURRENT_TIMESTAMP WHERE organization_id = ? AND id = ? AND status = 'open'")
      .run(orgId, orderId);
    return { ok: true, orderId, orderClosed: upd.changes > 0 };
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
    const c = db.prepare("SELECT id, txid, amount, status, qr_payload, qr_code_base64, provider, external_id FROM comigo_pix_charges WHERE organization_id = ? AND order_id = ? ORDER BY created_at DESC LIMIT 1").get(orgId, orderId) as any;
    const order = db.prepare("SELECT status, paid_via FROM comigo_orders WHERE organization_id = ? AND id = ?").get(orgId, orderId) as any;
    return { charge: c || null, orderStatus: order?.status || null, paidVia: order?.paid_via || null };
  }
}

export default ComigoPixService;
