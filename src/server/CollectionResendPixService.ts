import { AsaasService } from "./AsaasService.js";
import { MessageProviderService } from "./MessageProviderService.js";
import { BusinessSignalService } from "./BusinessSignalService.js";
import { logAuthEvent } from "./auditLog.js";

/**
 * Re-emissão automática de PIX sob demanda (ADR-152 F4b.3).
 *
 * Chamado pelo `CollectionReplyService` quando o intent classificado é
 * `resend_pix`. Fluxo:
 *   1. Busca payment no Asaas via `AsaasService.getPayment(paymentId)`.
 *   2. Extrai `invoiceUrl` (link universal da fatura no Asaas — tem PIX +
 *      boleto + cartão, hospedado pelo próprio Asaas).
 *   3. Envia WhatsApp com o link + valor + vencimento via `MessageProvider
 *      Service.sendMessage` (padrão pré-existente do repo).
 *   4. Loga audit event `RUNTIME_COLLECTION_PIX_RESENT`.
 *
 * Design decisions:
 *   - **NÃO cria payment novo** — reusa o `paymentId` original (já é o
 *     PIX válido; criar novo confunde o cliente e polui o Asaas).
 *   - **`invoiceUrl` em vez de PIX copia-cola** (`pixCopiaECola`
 *     bruto): a página do invoice já dá QR + copia-cola + valor + opções
 *     de pagamento; UX melhor + funciona quando o WhatsApp truncar links.
 *   - **Fail-loud via BusinessSignal**: se qualquer passo falha, publica
 *     `collection:resend_pix_failed` (severity=attention) pro dono ver
 *     na aba Operações. Assim o dono sabe que ele precisa mandar
 *     manualmente. NÃO alerta o cliente da falha (evita comunicação de
 *     erro técnico).
 *
 * Guardas F4b.3-A:
 *   G-4b.3-A-1: parâmetros obrigatórios validados antes de qualquer
 *               chamada externa (fail-fast, sem custo Asaas).
 *   G-4b.3-A-2: Asaas ausente/não configurado → `sent:false` + sinal
 *               (não trava caller — este service é opt-in).
 *   G-4b.3-A-3: sendMessage falha → sinal + `sent:false` (idem).
 *   G-4b.3-A-4: nunca throws — sempre devolve `ResendResult`.
 */

export interface ResendPixInput {
  actionId: string;
  paymentId: string;
  channelId: string;
  phone: string;
  amount?: number | null;
  dueDate?: string | null;
}

export interface ResendResult {
  sent: boolean;
  messageId?: string;
  invoiceUrl?: string;
  error?: string;
}

export class CollectionResendPixService {
  static async sendNow(orgId: string, opts: ResendPixInput): Promise<ResendResult> {
    if (!orgId || !opts?.actionId || !opts?.paymentId || !opts?.channelId || !opts?.phone) {
      return { sent: false, error: "params_invalid" };
    }

    // (1) Buscar payment no Asaas.
    let payment: any = null;
    try { payment = await AsaasService.getPayment(opts.paymentId); }
    catch (e: any) { return this.fail(orgId, opts.actionId, "asaas_getPayment_error", e?.message); }
    if (!payment) return this.fail(orgId, opts.actionId, "asaas_not_configured_or_not_found", null);

    const url: string | null = payment.invoiceUrl || payment.bankSlipUrl || null;
    if (!url) return this.fail(orgId, opts.actionId, "asaas_no_url", null);

    // (2) Compor mensagem — usa dados do payload (que veio do
    // send_reminder original) como fonte da verdade, com fallback pro
    // que o Asaas devolveu.
    const amount = opts.amount != null ? Number(opts.amount) : Number(payment.value || 0);
    const dueBR = String(opts.dueDate || payment.dueDate || "").split("-").reverse().join("/");
    const valueStr = amount > 0 ? `R$ ${amount.toFixed(2).replace(".", ",")}` : "";
    const dueStr = dueBR ? ` · vence ${dueBR}` : "";
    const parts = [valueStr, dueStr].filter(Boolean).join("");
    const msg = `Aqui está o PIX de novo 👇\n\n${url}${parts ? `\n\nValor: ${parts}` : ""}\n\nSe não conseguir abrir, me responde aqui que a gente resolve. 🙏`;

    // (3) Enviar.
    let messageId: string | undefined;
    try { messageId = await MessageProviderService.sendMessage(opts.channelId, opts.phone, msg); }
    catch (e: any) { return this.fail(orgId, opts.actionId, "sendMessage_error", e?.message); }

    // (4) Audit.
    try {
      logAuthEvent(orgId, null, null, "RUNTIME_COLLECTION_PIX_RESENT", {
        actionId: opts.actionId, paymentId: opts.paymentId,
        messageId: messageId || null, invoiceUrl: url, amount, dueDate: opts.dueDate,
      });
    } catch { /* noop */ }

    return { sent: true, messageId, invoiceUrl: url };
  }

  private static fail(orgId: string, actionId: string, reason: string, detail: string | null | undefined): ResendResult {
    try {
      BusinessSignalService.publish(orgId, {
        domain: "collection",
        signalType: "resend_pix_failed",
        severity: "attention",
        basis: "fact",
        confidence: 1,
        sourceService: "CollectionResendPixService",
        sourceEntityType: "decision_action",
        sourceEntityId: actionId,
        evidence: { actionId, reason, detail: detail || null },
        // Dedupe por (action, reason) pra falhas repetidas não flood
        // sinais duplicados — a aba Operações mostra o último detalhe.
        dedupeKey: `collection:resend_pix_failed:${actionId}:${reason}`,
      });
    } catch { /* noop */ }
    return { sent: false, error: reason };
  }
}

export default CollectionResendPixService;
