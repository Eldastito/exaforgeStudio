/**
 * stonePaymentGuard — verificação do webhook Stone/Pagar.me por RE-CONSULTA (SEC-F27).
 *
 * PROBLEMA: `syncStonePayment` marcava o pedido PAGO lendo o `status` do CORPO do webhook.
 * Um POST forjado (`{type:"order.paid", data:{code:"<id do pedido>"}}`) com o segredo da org
 * na URL confirmaria um pedido sem pagamento real. O Mercado Pago já NÃO confia no corpo —
 * pega só o id e RE-CONSULTA a API. Esta guarda leva o Stone ao mesmo padrão.
 *
 * FLUXO: do evento tira-se o ID do recurso → RE-CONSULTA a API do Pagar.me → decide pelo objeto
 * AUTORITATIVO (status/code/amount). Estas funções são PURAS (sem rede/DB) para dar teste
 * determinístico; a re-consulta (fetch) e os efeitos (markPaid) ficam no PaymentService.
 *
 * FAIL CLOSED: sem id, sem status 'paid' autoritativo, sem referência, ou valor divergente →
 * NÃO confirma (retorna null lá no service). Melhor não confirmar do que confirmar uma forja.
 */

export interface StoneFetchTarget { kind: "order" | "charge"; id: string }

/**
 * Do evento do webhook, qual recurso RE-CONSULTAR — NUNCA se confia no status do corpo, só no id.
 * Preferimos resolver a ORDER (onde gravamos o `code` = referência do pedido); um evento de
 * `charge` que traga o order id também resolve pela order; sem isso, cai na própria charge.
 */
export function stoneFetchTargetFromEvent(event: any): StoneFetchTarget | null {
  const type = String(event?.type || "").toLowerCase();
  const data = event?.data || {};
  if (type.startsWith("order.")) {
    const id = data?.id;
    return id ? { kind: "order", id: String(id) } : null;
  }
  if (type.startsWith("charge.")) {
    const orderId = data?.order_id || data?.order?.id;
    if (orderId) return { kind: "order", id: String(orderId) };
    const id = data?.id;
    return id ? { kind: "charge", id: String(id) } : null;
  }
  return null;
}

export interface StoneAuthoritative { paid: boolean; ref: string | null; amountCents: number | null }

/**
 * Decide a partir do objeto AUTORITATIVO (resposta da API do Pagar.me), não do webhook.
 * Pago = `status==='paid'` OU qualquer charge do pedido em 'paid' (link de 1 cobrança).
 * A referência do pedido vem do `code`/metadata AUTORITATIVOS (foi o que gravamos ao criar o link).
 */
export function resolveStoneAuthoritative(obj: any): StoneAuthoritative {
  const status = String(obj?.status || "").toLowerCase();
  const chargePaid = Array.isArray(obj?.charges)
    && obj.charges.some((c: any) => String(c?.status || "").toLowerCase() === "paid");
  const paid = status === "paid" || chargePaid;
  const refRaw = obj?.code || obj?.metadata?.reference || obj?.metadata?.orderId || null;
  const amountCents = typeof obj?.amount === "number" ? obj.amount : null;
  return { paid, ref: refRaw ? String(refRaw) : null, amountCents };
}

/**
 * Defesa em profundidade: confere o valor AUTORITATIVO (centavos) contra o esperado (reais, da
 * cobrança guardada). Sem base para comparar (algum lado ausente) → não bloqueia (o gate duro é o
 * status 'paid' autoritativo); havendo os dois, divergência REPROVA.
 */
export function stoneAmountMatches(amountCents: number | null, expectedReais: number | null | undefined): boolean {
  if (amountCents == null || expectedReais == null) return true;
  return Math.round(Number(expectedReais) * 100) === Math.round(amountCents);
}
