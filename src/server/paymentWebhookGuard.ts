/**
 * paymentWebhookGuard — integridade do webhook de pagamento GENÉRICO (SEC-F20).
 *
 * O path genérico (gateway "custom") marcava pedido como pago com folgas perigosas:
 *  (1) `paid` assumia TRUE quando o payload não trazia `status` — qualquer POST com o
 *      segredo da org marcava qualquer pedido como pago sem pagamento real;
 *  (2) nenhuma conferência de VALOR (marcar pago com valor menor);
 *  (3) sem replay/dedup.
 * Estas funções PURAS concentram as decisões (1) e (2), testáveis em CI; o replay/dedup
 * (efeito colateral, `claimWebhookEvent`) e o `markPaid` ficam no handler.
 */

export interface GenericWebhookResolution {
  orderId: string | null;
  externalId: string | null;
  /** true só quando há status RECONHECIDO de pago (nunca por ausência de status). */
  paid: boolean;
}

/** Resolve pedido/id-externo e se o status é EXPLICITAMENTE pago. */
export function resolveGenericPaymentWebhook(body: any): GenericWebhookResolution {
  const b = body || {};
  let orderId: string | null = b.orderId || b.order_id || null;
  let externalId: string | null = b.externalId || b.payment_id || b.id || null;
  if (!orderId && b.data && b.data.external_reference) {
    orderId = b.data.external_reference;
    externalId = b.data.id || externalId;
  }
  const paid = ["paid", "approved", "pago", "completed"].includes(String(b.status || "").toLowerCase());
  return { orderId, externalId, paid };
}

/**
 * Confere o valor do payload contra o valor esperado do pedido. Regra: quando o payload
 * TRAZ um valor, ele tem que bater (tolerância de centavo). Sem valor no payload → passa
 * (não dá pra conferir, não inventa) — a proteção principal é o status pago explícito.
 */
export function paymentAmountMatches(body: any, expectedAmount: number | null | undefined): boolean {
  const b = body || {};
  const payloadAmount = Number(b.amount ?? b.value ?? (b.data && b.data.transaction_amount) ?? NaN);
  if (!Number.isFinite(payloadAmount)) return true; // sem valor no payload
  if (expectedAmount == null || !Number.isFinite(Number(expectedAmount))) return true; // sem esperado
  return Math.abs(payloadAmount - Number(expectedAmount)) <= 0.01;
}
