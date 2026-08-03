import db from "./db.js";
import { logAuthEvent } from "./auditLog.js";
import { CommandExecutorService, type CommandHandler, type ExecutedResult } from "./CommandExecutorService.js";
import { ConfirmationEngine } from "./ConfirmationEngine.js";
import { MessageProviderService } from "./MessageProviderService.js";
import { AsaasService } from "./AsaasService.js";
import { ProcessRuntimeService } from "./ProcessRuntimeService.js";
import type { PlaybookDefinition } from "./PlaybookEngine.js";

/**
 * Piloto 2 do Execution Runtime — RECEIVABLE COLLECTION MVP (ADR-152 F4b).
 *
 * Playbook `receivable_collection_v1` (1 step composto):
 *   collection_send_reminder →
 *     (1) cria PIX charge no Asaas (AsaasService._req POST /payments);
 *     (2) amarra ConfirmationEngine.expect(asaas_payment_webhook, paymentId,
 *         deadline=dueDate+30d) — F2.1;
 *     (3) envia mensagem WhatsApp com QR/link do PIX via
 *         MessageProviderService (F2.3 padrão).
 *   → $end (process_instance vira 'completed' — o envio foi feito).
 *
 * O ACOMPANHAMENTO da cobrança é FEITO PELA FUNDAÇÃO F2.3 (não precisa
 * novo código):
 *   - Se o cliente PAGA → webhook Asaas chega → notifyRuntimeConfirmation
 *     casa payment.id com action_confirmations → ConfirmationEngine.confirm
 *     → DecisionActionService.complete → action fica 'done' com
 *     result_amount = valor pago. Outcome F3.1 é registrado com
 *     revenue_recovered.
 *   - Se timeout (deadline vence sem webhook) → Scheduler.
 *     confirmationTimeoutPass fecha como 'timed_out' → aparece na aba
 *     Operações (F3.2) como exceção `integration_failed` pro humano
 *     decidir (reenviar? escalar? dispensar?).
 *
 * Fatias FUTURAS que aumentam autonomia:
 *   F4b.2 — intent classifier via AIOrchestratorService: interpreta 10
 *           respostas do cliente (§13.4: "vou pagar", "manda o pix", "já
 *           paguei", "posso parcelar?", "não reconheço", etc). Adiciona
 *           steps `wait_reply → interpret_intent → (promise/dispute/
 *           escalate/pay/pause)`.
 *   F4b.3 — cadência multi-tentativa: se não pagou em N dias, envia 2ª
 *           lembrança (mais firme) e 3ª (com aviso de negativação).
 *
 * Decisões pendentes do §F (dono do produto):
 *   D1/D2/D5/D8/D9/D10: resolvidas na F4a (mesmas garantias servem aqui).
 *   D4: LGPD — cobrança recebida NÃO é problema LGPD (cliente já é dono
 *       do crédito no ZappFlow); só a F4c (Recuperação Comercial —
 *       contato PROATIVO em massa a leads) exige revisão jurídica.
 *
 * Guardas RN (F4b):
 *   G-4b-1: PIX + msg WhatsApp são criados no MESMO handler pra garantir
 *           que o cliente sempre recebe o QR/link com o payment amarrado
 *           — nunca envia só a mensagem sem o PIX pronto.
 *   G-4b-2: idempotência do payment vem do AsaasService (transação); o
 *           expect é idempotente por (org, action_id) — chamar 2× devolve
 *           a linha (F2.1 já garante).
 *   G-4b-3: se a criação do PIX falha, NADA é enviado (não manda mensagem
 *           "aqui está seu PIX" sem PIX). Erro classificado propaga pro
 *           JobQueueError (F2.1 backoff).
 *   G-4b-4: valor > R$ 5.000 exige aprovação humana (via policy —
 *           agent_policies.max_auto_amount). Sem essa policy, o executor
 *           F2.2 recusa via 3 guardas (autonomy/mode/policy).
 *   G-4b-5: contato precisa ter phone válido; contactos sem phone
 *           não geram processo (checagem em start()).
 */

const payloadOf = (action: any) => { try { return action.command_payload_json ? JSON.parse(action.command_payload_json) : {}; } catch { return {}; } };

// ── Handler composto ─────────────────────────────────────────────────────

/**
 * collection_send_reminder — 1 handler que faz o cluster completo (PIX +
 * expect + mensagem). Alternativa considerada era 2 steps no playbook
 * (asaas_pix_charge → whatsapp_send), mas o WhatsApp precisa do paymentId
 * do step anterior E de uma mensagem template com PIX embutido —
 * combinar tudo aqui deixa a intent clara e evita o handler WhatsApp
 * genérico ter de "conhecer" formato de cobrança.
 *
 * Payload esperado:
 *   {
 *     receivableId, contactId, phone, channelId,
 *     amount, description, dueDate,
 *     customerId,                    // customer.id no Asaas (pré-existente)
 *     messageTemplate?,              // opcional, tem default por dueDate
 *   }
 */
const CollectionSendReminderHandler: CommandHandler = {
  key: "CollectionSendReminderHandler",
  commandTypes: ["collection_send_reminder"],
  prepare(_orgId, action) {
    const p = payloadOf(action);
    return {
      summary: `Lembrete de cobrança preparado (R$ ${Number(p.amount || 0).toFixed(2)} · vence ${p.dueDate || "?"})`,
      artifact: { kind: "collection_reminder_draft", contactId: p.contactId, phone: p.phone, amount: p.amount, dueDate: p.dueDate, description: p.description },
    };
  },
  async execute(orgId, action): Promise<ExecutedResult> {
    const p = payloadOf(action);
    // Validação de payload (G-4b-5) — non_retryable pra ir direto pra
    // dead-letter (F2.1) em vez de retentar com dados ruins.
    if (!p.receivableId) throwHandler("non_retryable", "collection_send_reminder exige receivableId no payload.");
    if (!p.phone) throwHandler("non_retryable", "collection_send_reminder exige phone no payload (contato sem WhatsApp não é cobrável autonomamente).");
    if (!p.channelId) throwHandler("non_retryable", "collection_send_reminder exige channelId (canal WhatsApp da org).");
    const amount = Number(p.amount);
    if (!(amount > 0)) throwHandler("non_retryable", "collection_send_reminder.amount deve ser > 0.");

    // Valida channel pertence à org (isolamento — mesma regra do
    // WhatsAppSendCommandHandler F2.3).
    const ch = db.prepare(`SELECT id, status FROM channels WHERE id = ? AND organization_id = ?`).get(p.channelId, orgId) as any;
    if (!ch) throwHandler("non_retryable", `channel ${p.channelId} não pertence à org.`);
    if (ch.status === "disabled") throwHandler("external_unavailable", `channel ${p.channelId} está desabilitado.`);

    // Valida receivable existe e é da org (isolamento).
    const rec = db.prepare(`SELECT id, status, amount FROM receivables WHERE id = ? AND organization_id = ?`).get(p.receivableId, orgId) as any;
    if (!rec) throwHandler("non_retryable", `receivable ${p.receivableId} não pertence à org.`);
    if (rec.status !== "open") throwHandler("non_retryable", `receivable ${p.receivableId} não está 'open' (atual: ${rec.status}).`);

    // (1) Cria PIX charge no Asaas. Reusa createPixCharge helper —
    // classificação de erro por HTTP status (F2.3).
    let paymentId: string | null = null;
    try {
      paymentId = await createPixCharge(orgId, {
        customerId: String(p.customerId || ""),
        amount,
        description: String(p.description || `Cobrança R$ ${amount.toFixed(2)}`).slice(0, 200),
        dueDate: String(p.dueDate || ""),
      });
    } catch (e: any) { throwHandler(classifyAsaas(e), `Asaas falhou ao criar PIX: ${e?.message || e}`); }
    if (!paymentId) throwHandler("external_unavailable", "Asaas devolveu resposta sem paymentId.");

    // (2) Amarra confirmação por webhook (F2.1 + F2.3). Deadline default:
    // dueDate + 30d (mesmo AsaasPixChargeCommandHandler F2.3).
    try {
      ConfirmationEngine.expect(orgId, {
        actionId: action.id, method: "asaas_payment_webhook",
        externalRef: paymentId,
        deadlineAt: p.confirmationDeadline || defaultConfirmationDeadline(p.dueDate),
      });
    } catch (e: any) { console.warn("[Collection] expect falhou (payment já criado):", e?.message || e); }

    // (3) Envia mensagem WhatsApp com QR/link do PIX. Se falhar aqui, o
    // PIX já existe mas o cliente não recebeu — auditamos e retornamos
    // erro classificado. O `sweepTimeouts` (F2.3) fecha a confirmação
    // no deadline mesmo assim, sinalizando na aba Operações (F3.2).
    const message = String(p.messageTemplate || defaultMessage(amount, p.dueDate, p.description)).trim();
    let messageId: string | undefined;
    try {
      messageId = await MessageProviderService.sendMessage(String(p.channelId), String(p.phone), message);
    } catch (e: any) { throwHandler("external_unavailable", `Falha ao enviar WhatsApp: ${e?.message || e}`); }

    try { logAuthEvent(orgId, "runtime", null, "RUNTIME_COLLECTION_SENT", { receivableId: p.receivableId, phone: p.phone, amount, paymentId, messageId: messageId || null }); } catch { /* noop */ }

    return {
      summary: `Cobrança enviada (R$ ${amount.toFixed(2)} → ${p.phone})`,
      artifact: {
        kind: "collection_reminder_sent",
        receivableId: p.receivableId, contactId: p.contactId, phone: p.phone,
        amount, paymentId, messageId: messageId || null, dueDate: p.dueDate,
      },
      effect: "collection_reminder_sent",
      externalRef: paymentId,
    };
  },
};

CommandExecutorService.registerHandler(CollectionSendReminderHandler);

// ── Definição do playbook ────────────────────────────────────────────────

export const RECEIVABLE_COLLECTION_V1: PlaybookDefinition = {
  startStep: "send_reminder",
  steps: [
    {
      id: "send_reminder",
      commandType: "collection_send_reminder",
      successCondition: { op: "truthy", path: "results.send_reminder.paymentId" },
      timeoutSeconds: 60, // Asaas + WhatsApp em conjunto
      maxAttempts: 3,
      onFailure: "escalate", // sem cobrar via canal, gerente decide
      next: "$end",
    },
  ],
};

// ── Seed helper + kickoff pra Cobrança ───────────────────────────────────

export class CollectionPlaybookService {
  /** Cria a definição `receivable_collection_v1` na org (idempotente). */
  static seed(orgId: string, actorId?: string): any {
    const existing = ProcessRuntimeService.latestActiveDefinition(orgId, "receivable_collection_v1");
    if (existing) return existing;
    return ProcessRuntimeService.defineProcess(orgId, {
      processType: "receivable_collection_v1",
      name: "Cobrança automatizada de recebível",
      description: "Cria PIX Asaas + envia WhatsApp com o QR/link + amarra confirmação por webhook. MVP: 1 lembrete. Cadência multi-tentativa vem em F4b.2.",
      triggerType: "manual",
      objective: "Receber pagamento OU escalar pro humano quando timeout/erro.",
      autonomyLevelDefault: "execute",
      slaDefinition: { deadline: "dueDate+30d", timezone: "America/Sao_Paulo" },
      steps: RECEIVABLE_COLLECTION_V1,
    }, actorId);
  }

  /**
   * Inicia uma cobrança pro receivable. `context` reúne o que o handler
   * precisa (phone, channelId, customerId, amount, dueDate, description).
   * Dedupe conservador do ProcessRuntimeService (por subject vivo) impede
   * cobrança dupla no mesmo receivable.
   */
  static start(orgId: string, input: {
    receivableId: string; contactId?: string; phone: string; channelId: string;
    customerId: string; amount: number; dueDate: string;
    description?: string; messageTemplate?: string;
    confirmationDeadline?: string;
  }, createdBy?: string): any {
    if (!input?.receivableId) throw new Error("receivableId obrigatório.");
    if (!input?.phone) throw new Error("phone obrigatório (contato sem WhatsApp não é cobrável automaticamente).");
    if (!input?.channelId) throw new Error("channelId obrigatório.");
    if (!input?.customerId) throw new Error("customerId (Asaas) obrigatório.");
    if (!(Number(input?.amount) > 0)) throw new Error("amount > 0 obrigatório.");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(input?.dueDate || ""))) throw new Error("dueDate deve ser YYYY-MM-DD.");
    return ProcessRuntimeService.startForSubject(orgId, {
      processType: "receivable_collection_v1",
      subjectType: "receivable",
      subjectId: input.receivableId,
      context: { ...input },
      priority: 5, riskLevel: "low",
      expectedValue: Number(input.amount),
      createdBy: createdBy || null,
    }, createdBy || undefined);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

function throwHandler(cls: "retryable" | "external_unavailable" | "permission" | "non_retryable", message: string): never {
  const err = new Error(message) as any;
  err.errorClass = cls;
  throw err;
}

function classifyAsaas(err: any): "external_unavailable" | "permission" | "non_retryable" | "retryable" {
  const status = Number(err?.status || err?.response?.status);
  if (status === 401 || status === 403) return "permission";
  if (status >= 500 || status === 429) return "external_unavailable";
  if (status >= 400 && status < 500) return "non_retryable";
  return "retryable";
}

function defaultConfirmationDeadline(dueDate?: string | null): string {
  const base = dueDate ? new Date(String(dueDate)) : new Date();
  const deadline = new Date(base);
  deadline.setDate(deadline.getDate() + 30);
  return deadline.toISOString();
}

function defaultMessage(amount: number, dueDate: string, description?: string): string {
  const dueBR = String(dueDate || "").split("-").reverse().join("/");
  const item = description ? `\nReferente a: ${description}` : "";
  return `Olá! 👋\n\nLembrando do valor de R$ ${amount.toFixed(2).replace(".", ",")} ${dueBR ? `com vencimento em ${dueBR}` : "em aberto"}.${item}\n\nPra facilitar, gerei o PIX pra você — o link/QR chega em seguida.\n\nQualquer coisa é só responder por aqui. 🙏`;
}

/**
 * Cria PIX charge avulsa no Asaas via _req interno (mesmo padrão do
 * AsaasPixChargeCommandHandler da F2.3). Deixamos aqui a duplicata pra
 * evitar dependência circular F2.3 ↔ F4b — quando a F4b.2 refatorar,
 * uma extração pra `AsaasService.createPixCharge` (público) resolve.
 */
async function createPixCharge(orgId: string, p: { customerId: string; amount: number; description: string; dueDate?: string | null }): Promise<string | null> {
  const svc: any = AsaasService as any;
  if (typeof svc.createPixCharge === "function") {
    const r = await svc.createPixCharge(orgId, p);
    return r?.id || r?.paymentId || null;
  }
  if (typeof svc._req === "function") {
    const body: any = {
      billingType: "PIX",
      value: Number(p.amount),
      description: p.description,
      dueDate: p.dueDate || new Date(Date.now() + 3 * 86400_000).toISOString().slice(0, 10),
    };
    if (p.customerId) body.customer = p.customerId;
    const r = await svc._req.call(svc, "POST", "/payments", body);
    return r?.id || null;
  }
  throwHandler("permission", "Asaas não expõe createPixCharge/_req — plumbing PIX avulso pendente.");
  return null; // unreachable
}
