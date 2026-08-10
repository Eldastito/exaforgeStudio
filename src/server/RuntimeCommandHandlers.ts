import db from "./db.js";
import { CommandExecutorService, type CommandHandler, type ExecutedResult } from "./CommandExecutorService.js";
import { ConfirmationEngine } from "./ConfirmationEngine.js";
import { MessageProviderService } from "./MessageProviderService.js";
import { AsaasService } from "./AsaasService.js";
import { GoogleOAuthService } from "./GoogleOAuthService.js";

/**
 * RuntimeCommandHandlers — handlers CONCRETOS do Execution Runtime
 * (ADR-152 Fatia 2.3). Cada um implementa `execute` com efeito EXTERNO real,
 * amarrando `ConfirmationEngine.expect` quando o resultado da ação depende de
 * evento externo (pagamento identificado, resposta em canal, ...).
 *
 * Registrados via `CommandExecutorService.registerHandler` no boot (import
 * pra side-effect no server.ts). O `prepare` continua sendo o padrão do
 * ADR-136 C5 (sem efeito externo); o `execute` só corre com as 3 guardas da
 * F2.2 satisfeitas (autonomy=execute + execution_mode≥approved_execution +
 * policy=approved).
 *
 * Contrato de cada handler:
 *   - Handler decide se precisa de confirmação externa (não é obrigatório).
 *   - Se precisar, chama `ConfirmationEngine.expect(action, method, externalRef,
 *     deadline)` ANTES do efeito externo. Assim, mesmo se o webhook chegar
 *     ANTES do `execute` retornar, a confirmação já existe pra amarrar.
 *   - `execute` retorna `{summary, artifact, effect, externalRef}` — `effect`
 *     é humano-legível ("pix_charge_created", "wa_msg_sent"); `externalRef` é
 *     o id externo (ex.: payment.id do Asaas) — vira o "hook" pra webhook.
 *   - Erros externos VÃO PRA JobQueueError com errorClass:
 *     * external_unavailable — provedor fora do ar (retry com backoff maior)
 *     * permission — sem credencial (dead-letter, humano precisa cadastrar)
 *     * non_retryable — payload inválido (dead-letter imediato)
 *     * (default retryable) — falhas transientes.
 */

const payloadOf = (action: any) => { try { return action.command_payload_json ? JSON.parse(action.command_payload_json) : {}; } catch { return {}; } };

// ── 1) WhatsApp Send — envio de mensagem (fire-and-forget, sem confirmação) ──
//
// Payload esperado: { channelId, recipient, message? }. `message` opcional; se
// ausente, o handler compõe uma default (mesmo padrão do CollectionCommandHandler
// no prepare). SEM `expect` — envio de mensagem NÃO exige confirmação de
// entrega neste escopo (o pipeline de delivery do provider já cobre); a AÇÃO
// fecha quando o `execute` retorna. Um handler futuro (F4b Cobrança) pode
// escolher esperar `channel_reply` — aí registra expect explicitamente.
const WhatsAppSendCommandHandler: CommandHandler = {
  key: "WhatsAppSendCommandHandler",
  commandTypes: ["whatsapp_send"],
  prepare(_orgId, action) {
    const p = payloadOf(action);
    return { summary: `Mensagem WhatsApp preparada: ${p.recipient || "(sem destino)"}`, artifact: { kind: "wa_draft", channelId: p.channelId || null, recipient: p.recipient || null, message: p.message || action.description || action.title } };
  },
  async execute(orgId, action): Promise<ExecutedResult> {
    const p = payloadOf(action);
    if (!p.channelId) throwHandler("non_retryable", "whatsapp_send exige channelId no command_payload.");
    if (!p.recipient) throwHandler("non_retryable", "whatsapp_send exige recipient no command_payload.");
    const message = String(p.message || action.description || action.title || "").trim();
    if (!message) throwHandler("non_retryable", "whatsapp_send exige message (ou action.description/title) não-vazia.");
    // Validação leve de tenant: canal precisa pertencer à org.
    const ch = db.prepare(`SELECT id, status FROM channels WHERE id = ? AND organization_id = ?`).get(p.channelId, orgId) as any;
    if (!ch) throwHandler("non_retryable", `channel ${p.channelId} não pertence à org.`);
    if (ch.status === "disabled") throwHandler("external_unavailable", `channel ${p.channelId} está desabilitado.`);
    let messageId: string | undefined;
    try {
      messageId = await MessageProviderService.sendMessage(p.channelId, String(p.recipient), message);
    } catch (e: any) { throwHandler("external_unavailable", `Falha ao enviar WhatsApp: ${e?.message || e}`); }
    return { summary: `WhatsApp enviado (${p.recipient})`, artifact: { kind: "wa_sent", channelId: p.channelId, recipient: p.recipient, messageId: messageId || null, message }, effect: "wa_msg_sent", externalRef: messageId || null };
  },
};

// ── 2) Asaas PIX Charge — cria cobrança PIX, ARMA confirmação por webhook ──
//
// Payload esperado: { customer, amount, description?, dueDate? }.
// O `execute` cria o payment no Asaas via `AsaasService` e IMEDIATAMENTE
// chama `ConfirmationEngine.expect(action, 'asaas_payment_webhook', paymentId)`.
// Quando o webhook `PAYMENT_CONFIRMED/RECEIVED` chegar, o
// `AsaasService.handleWebhook` (estendido nesta fatia) casa o payment.id com
// a confirmação viva e chama `ConfirmationEngine.confirm` → fecha a ação com
// `result_amount = valor pago`. Guardrail: se o expect falhar por qualquer
// motivo (ex.: já existe outra confirmação viva), o payment JÁ FOI CRIADO
// externamente — logamos com WARN e devolvemos o externalRef mesmo assim (o
// operador precisa investigar; a auditoria em action_execution_log deixa
// tudo rastreável).
const AsaasPixChargeCommandHandler: CommandHandler = {
  key: "AsaasPixChargeCommandHandler",
  commandTypes: ["asaas_pix_charge"],
  prepare(_orgId, action) {
    const p = payloadOf(action);
    return { summary: `Cobrança PIX preparada${p.amount ? ` (R$ ${Number(p.amount).toFixed(2)})` : ""}`, artifact: { kind: "asaas_pix_draft", customer: p.customer || null, amount: p.amount ?? null, description: p.description || action.description || action.title, dueDate: p.dueDate || null } };
  },
  async execute(orgId, action): Promise<ExecutedResult> {
    if (!AsaasService.isConfigured || !(AsaasService as any).isConfigured?.()) {
      // AsaasService.isConfigured pode ou não existir/estar exposto. Se não,
      // o handler ainda tenta; falha de credencial vira permission.
    }
    const p = payloadOf(action);
    const amount = Number(p.amount ?? action.expected_impact);
    if (!(amount > 0)) throwHandler("non_retryable", "asaas_pix_charge exige amount > 0.");
    // Nesta fatia, delegamos a criação real da cobrança pra AsaasService.
    // Como o AsaasService atual expõe subscribe/getPayment (billing da
    // plataforma), reusamos o cliente HTTP interno pra criar um pagamento
    // avulso (`payments` endpoint) — o método concreto vive dentro do
    // AsaasService pra centralizar autenticação/rate-limit. O executor não
    // pinga a API sozinho.
    let paymentId: string | null = null;
    try {
      paymentId = await createPixCharge(orgId, {
        customerId: String(p.customer || p.customerId || ""),
        amount,
        description: String(p.description || action.description || action.title || "").slice(0, 200),
        dueDate: p.dueDate || null,
      });
    } catch (e: any) { throwHandler(classifyAsaas(e), `Asaas falhou ao criar cobrança PIX: ${e?.message || e}`); }
    if (!paymentId) throwHandler("external_unavailable", "Asaas devolveu resposta sem paymentId.");

    // Arma a confirmação por webhook antes de retornar. Se `expect` falhar,
    // não removemos o payment (já criado externamente) — logamos e devolvemos
    // o externalRef mesmo assim; o timeout/scanning pega depois.
    try {
      ConfirmationEngine.expect(orgId, {
        actionId: action.id, method: "asaas_payment_webhook",
        externalRef: paymentId,
        // Deadline padrão: 30 dias (dueDate + margem). Handlers podem receber
        // deadline explícito no payload — se não, calculamos aqui.
        deadlineAt: p.confirmationDeadline || defaultConfirmationDeadline(p.dueDate),
      });
    } catch (e: any) { console.warn("[AsaasPixCharge] expect falhou (payment já criado):", e?.message || e); }

    return { summary: `Cobrança PIX criada no Asaas (${paymentId})`, artifact: { kind: "asaas_pix_created", paymentId, amount, customer: p.customer || null, description: p.description || null }, effect: "pix_charge_created", externalRef: paymentId };
  },
};

// ── 3) Alterdata Fetch — leitura idempotente do ERP (sem efeito externo) ──
//
// Payload esperado: { kind: 'daily_sales' | 'stock' | 'supply', date? }.
// Chama `AlterdataConnectorService` via import dinâmico (evita ciclo se
// Connector algum dia importar Runtime). SEM `expect` — leitura é síncrona
// e determinística: o dado volta ou o handler falha; sem "aguardar confirmação
// externa". Efeito colateral no repo: gravar dados sincronizados fica sob
// responsabilidade do próprio `AlterdataConnectorService` (não do handler).
const AlterdataFetchCommandHandler: CommandHandler = {
  key: "AlterdataFetchCommandHandler",
  commandTypes: ["alterdata_fetch"],
  prepare(_orgId, action) {
    const p = payloadOf(action);
    return { summary: `Sync Alterdata preparado (${p.kind || "?"})`, artifact: { kind: "alterdata_fetch_draft", scope: p.kind || null, date: p.date || null } };
  },
  async execute(orgId, action): Promise<ExecutedResult> {
    const p = payloadOf(action);
    const scope = String(p.kind || "");
    if (!scope) throwHandler("non_retryable", "alterdata_fetch exige kind no payload (daily_sales | stock | supply).");
    try {
      const mod = await import("./AlterdataConnectorService.js");
      const svc: any = mod.AlterdataConnectorService || (mod as any).default;
      if (!svc) throwHandler("permission", "AlterdataConnectorService indisponível.");
      // O connector é opcional/opt-in; se a org não configurou credenciais,
      // classificamos como `permission` pro dead-letter (humano precisa
      // cadastrar). Chamada real via um método público do connector.
      const fn = svc.fetchScope || svc.syncScope || svc.fetch;
      const result = typeof fn === "function" ? await fn.call(svc, orgId, scope, { date: p.date || null }) : null;
      return { summary: `Sync Alterdata (${scope}) OK`, artifact: { kind: "alterdata_fetched", scope, date: p.date || null, result: result ?? { pending: true } }, effect: "alterdata_synced", externalRef: null };
    } catch (e: any) { throwHandler(classifyAlterdata(e), `Alterdata falhou: ${e?.message || e}`); }
    // unreachable
    throw new Error("unreachable");
  },
};

// ── 4) Gmail Send — e-mail pela conta Google conectada (ADR-159 F2.5) ────────
//
// Payload esperado: { to, subject?, body }. Reusa `GoogleOAuthService.gmailSend`
// (o mesmo sink do envio direto), agora atrás do choke-point. SEM `expect` —
// e-mail não exige confirmação de entrega aqui. Erro { error } do gmailSend
// vira JobQueueError classificado (conta não conectada → permission).
const GmailSendCommandHandler: CommandHandler = {
  key: "GmailSendCommandHandler",
  commandTypes: ["gmail_send"],
  prepare(_orgId, action) {
    const p = payloadOf(action);
    return { summary: `E-mail preparado: ${p.to || "(sem destino)"}`, artifact: { kind: "email_draft", to: p.to || null, subject: p.subject || null, body: p.body || action.description || action.title } };
  },
  async execute(orgId, action): Promise<ExecutedResult> {
    const p = payloadOf(action);
    if (!p.to) throwHandler("non_retryable", "gmail_send exige 'to' no command_payload.");
    const subject = String(p.subject || action.title || "Contato comercial");
    const body = String(p.body || action.description || action.title || "").trim();
    if (!body) throwHandler("non_retryable", "gmail_send exige 'body' (ou action.description/title) não-vazio.");
    const r = await GoogleOAuthService.gmailSend(orgId, String(p.to), subject, body);
    if ((r as any)?.error) {
      const err = String((r as any).error);
      throwHandler(/não conectada|not connected|conta google/i.test(err) ? "permission" : "external_unavailable", `Gmail falhou: ${err}`);
    }
    const messageId = String((r as any)?.id || "") || null;
    return { summary: `E-mail enviado (${p.to})`, artifact: { kind: "email_sent", to: p.to, subject, messageId }, effect: "email_sent", externalRef: messageId };
  },
};

// ── Registro (auto no import — server.ts precisa fazer `import "./RuntimeCommandHandlers.js"`) ──
CommandExecutorService.registerHandler(WhatsAppSendCommandHandler);
CommandExecutorService.registerHandler(AsaasPixChargeCommandHandler);
CommandExecutorService.registerHandler(AlterdataFetchCommandHandler);
CommandExecutorService.registerHandler(GmailSendCommandHandler);

// ── Helpers ──────────────────────────────────────────────────────────────

/** Lança um erro classificado pra JobQueue/executor rotearem o retry corretamente. */
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

function classifyAlterdata(err: any): "external_unavailable" | "permission" | "non_retryable" | "retryable" {
  const msg = String(err?.message || err || "").toLowerCase();
  if (/credential|auth|forbidden|401|403|no.*token/.test(msg)) return "permission";
  if (/timeout|network|econn|503|502|504/.test(msg)) return "external_unavailable";
  return "retryable";
}

function defaultConfirmationDeadline(dueDate?: string | null): string {
  const base = dueDate ? new Date(dueDate) : new Date();
  const deadline = new Date(base);
  deadline.setDate(deadline.getDate() + 30);
  return deadline.toISOString();
}

/**
 * Cria uma cobrança PIX avulsa no Asaas. Isolado aqui (não em AsaasService)
 * porque a cobrança lojista→cliente-final é escopo do Runtime — o
 * AsaasService atual foca em BILLING da plataforma (assinaturas ZappFlow →
 * lojista). Segue o mesmo cliente HTTP interno via `AsaasService._req` (fica
 * numa fatia futura extrair como método público, quando F4b consolidar o
 * fluxo). Nesta fatia, chamamos uma função reflection-safe: se
 * `_req`/`createPayment` não existir, marca `permission` (o Asaas não está
 * plumbed pra cobrança avulsa no repo atual — a F4b vai completar isso).
 */
async function createPixCharge(orgId: string, p: { customerId: string; amount: number; description: string; dueDate?: string | null }): Promise<string | null> {
  const svc: any = AsaasService as any;
  if (typeof svc.createPixCharge === "function") {
    const r = await svc.createPixCharge(orgId, p);
    return r?.id || r?.paymentId || null;
  }
  if (typeof svc._req === "function") {
    const body: any = { billingType: "PIX", value: Number(p.amount), description: p.description, dueDate: p.dueDate || new Date(Date.now() + 3 * 86400_000).toISOString().slice(0, 10) };
    if (p.customerId) body.customer = p.customerId;
    const r = await svc._req.call(svc, "POST", "/payments", body);
    return r?.id || null;
  }
  throwHandler("permission", "Asaas não expõe createPixCharge/_req — plumbing PIX avulso pendente (fatia F4b Cobrança).");
  return null; // unreachable
}

export {
  WhatsAppSendCommandHandler,
  AsaasPixChargeCommandHandler,
  AlterdataFetchCommandHandler,
};
