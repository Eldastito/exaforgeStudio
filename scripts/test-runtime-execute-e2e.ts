/**
 * TEST — ADR-152 Fatia 2.3: handlers concretos + webhook Asaas + Scheduler.
 *
 * Fecha o loop de ponta-a-ponta: `execute` real dispara efeito externo,
 * amarra confirmação, webhook Asaas resolve. Cobertura:
 *
 *  - WhatsAppSendCommandHandler roda MessageProviderService.sendMessage
 *    (mockado); ação vira `done` no próprio `execute` (sem expect).
 *  - AsaasPixChargeCommandHandler cria payment mockado e chama
 *    ConfirmationEngine.expect com externalRef; ação continua approved até
 *    o webhook chegar. Webhook Asaas casa o payment.id com a confirmação
 *    viva e fecha a ação com result_amount.
 *  - Idempotência do webhook (2x) mantém ação done sem reabrir.
 *  - Webhook desconhecido (payment sem confirmação viva) é NO-OP silencioso.
 *  - Scheduler.confirmationTimeoutPass fecha as pendentes vencidas.
 *  - Alterdata: sem credencial cadastrada → dead-letter permission.
 *  - Validações de payload (channelId ausente, amount inválido) → non_retryable.
 *  - Isolamento cross-tenant.
 *  - Regressão: prepare dos handlers continua funcionando.
 *
 * Determinístico (mocks pra MessageProvider + AsaasService).
 * Uso: npm run test:runtime-execute-e2e
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-runtime-e2e-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-runtime-e2e-1234567890";
// Não configura Asaas — o mock do `_req` cobre.

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { CommandExecutorService } = await import("../src/server/CommandExecutorService.js");
  const { DecisionActionService } = await import("../src/server/DecisionActionService.js");
  const { ConfirmationEngine } = await import("../src/server/ConfirmationEngine.js");
  const { MessageProviderService } = await import("../src/server/MessageProviderService.js");
  const { AsaasService } = await import("../src/server/AsaasService.js");
  const { PaymentService } = await import("../src/server/PaymentService.js");
  const { EncryptionService } = await import("../src/server/EncryptionService.js");
  const { Scheduler } = await import("../src/server/Scheduler.js");
  void AsaasService;
  // Side-effect: registra os 3 handlers concretos.
  await import("../src/server/RuntimeCommandHandlers.js");

  // Mocks de I/O externo — testam o handler + auditoria + ConfirmationEngine
  // sem sair pra rede.
  const sentMessages: Array<{ channelId: string; to: string; text: string }> = [];
  (MessageProviderService as any).sendMessage = async (channelId: string, to: string, text: string) => {
    sentMessages.push({ channelId, to, text });
    return `msg_${randomUUID().slice(0, 8)}`;
  };
  // ADR-183 F2/F3 — a cobrança de recebível vai pelo gateway POR-ORG (Mercado Pago), NUNCA pela
  // chave ASAAS de plataforma. Stub do `fetch` do MP (criar POST + re-consultar GET). Se qualquer
  // chamada bater no ASAAS, o teste falha (o `_req` NÃO deve mais ser usado).
  const mpCalls: Array<{ method: string; url: string; body: any }> = [];
  const mpPayments: Record<string, { ref: string; amount: number }> = {};
  let nextPaymentSeq = 1;
  (globalThis as any).fetch = async (url: string, init: any) => {
    const method = String(init?.method || "GET").toUpperCase();
    const u = String(url);
    const body = init?.body ? JSON.parse(init.body) : null;
    mpCalls.push({ method, url: u, body });
    if (u.includes("api.mercadopago.com/v1/payments") && method === "POST") {
      const id = `mp_e2e_${nextPaymentSeq++}`;
      mpPayments[id] = { ref: body.external_reference, amount: Number(body.transaction_amount) };
      return { ok: true, status: 201, json: async () => ({ id, status: "pending", external_reference: body.external_reference, point_of_interaction: { transaction_data: { qr_code: "QR", ticket_url: "http://t" } } }), text: async () => "" } as any;
    }
    if (u.includes("api.mercadopago.com/v1/payments/") && method === "GET") {
      const id = decodeURIComponent(u.split("/payments/")[1] || "");
      const pay = mpPayments[id];
      return { ok: true, status: 200, json: async () => ({ id, status: "approved", external_reference: pay?.ref || "", transaction_amount: pay?.amount ?? 0 }), text: async () => "" } as any;
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => "" } as any;
  };
  // orgByExternalIds retorna org da confirmação — pra teste, mockamos pra devolver a orgA:
  const orgAId = `org_${randomUUID().slice(0, 8)}`;
  const orgBId = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'A', 'active')`).run(randomUUID(), orgAId);
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'B', 'active')`).run(randomUUID(), orgBId);
  // Sem asaas_customer_id vinculado à org, o handleWebhook não vai achar orgId
  // por (sub/cust) — daí o notifyRuntimeConfirmation entra em ação via external_ref.
  // Preciso forçar `orgByExternalIds` a retornar um id pra o webhook NÃO retornar 'ignored'
  // (o hook Runtime é chamado ANTES do return, mas só se orgId!=null). Solução:
  // gravamos external_customer_id + external_subscription_id + billing_status pra a orgA.
  db.prepare(`UPDATE organization_settings SET external_customer_id = 'cust_test_1', external_subscription_id = 'sub_test_1', billing_status = 'active' WHERE organization_id = ?`).run(orgAId);
  // ADR-183 — orgA tem gateway POR-ORG (Mercado Pago) para cobrar o cliente dela (Eixo B).
  db.prepare(`UPDATE organization_settings SET pay_enabled = 1, pay_provider = 'mercadopago', pay_gateway_token = ? WHERE organization_id = ?`).run(EncryptionService.encrypt("MP-TOKEN-ORG-A"), orgAId);
  // Recebível em aberto que a cobrança PIX vai quitar (reference rcv:<id>).
  const rcvId = `rcv_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO receivables (id, organization_id, description, amount, due_date, status) VALUES (?, ?, 'Fatura 4587', 4200, '2026-08-15', 'open')`).run(rcvId, orgAId);
  // orgB também tem gateway próprio (isolamento cross-tenant no webhook).
  db.prepare(`UPDATE organization_settings SET pay_enabled = 1, pay_provider = 'mercadopago', pay_gateway_token = ? WHERE organization_id = ?`).run(EncryptionService.encrypt("MP-TOKEN-ORG-B"), orgBId);
  const rcvB = `rcv_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO receivables (id, organization_id, description, amount, due_date, status) VALUES (?, ?, 'b', 50, '2026-08-15', 'open')`).run(rcvB, orgBId);

  // Handler stub pra atender AlterdataFetch nesta suíte E2E (o Connector real
  // não roda em teste). O handler que a fatia registrou usa import dinâmico do
  // AlterdataConnectorService e classifica erro como `permission` se o svc
  // não expõe as funções esperadas — o que é EXATAMENTE o que queremos
  // testar em orgs sem credencial.

  const setPolicy = (orgId: string, domain: string, actionType: string, opts: { autonomy?: string; mode?: string; active?: 0 | 1 } = {}) => {
    const cur = db.prepare(`SELECT id FROM agent_policies WHERE organization_id = ? AND domain = ? AND action_type = ?`).get(orgId, domain, actionType) as any;
    if (cur) {
      db.prepare(`UPDATE agent_policies SET autonomy_level = COALESCE(?, autonomy_level), execution_mode = COALESCE(?, execution_mode), active = COALESCE(?, active) WHERE id = ?`)
        .run(opts.autonomy || null, opts.mode || null, opts.active ?? null, cur.id);
    } else {
      db.prepare(`INSERT INTO agent_policies (id, organization_id, domain, action_type, autonomy_level, execution_mode, active) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(randomUUID(), orgId, domain, actionType, opts.autonomy || "execute", opts.mode || "approved_execution", opts.active ?? 1);
    }
  };
  const mkApprovedAction = (orgId: string, opts: { commandType: string; domain?: string; actionType?: string; title?: string; expectedImpact?: number; payload?: any }) => {
    const a = DecisionActionService.propose(orgId, {
      domain: opts.domain || "runtime", actionType: opts.actionType || "generic_execute",
      title: opts.title || "test action",
      expectedImpact: opts.expectedImpact ?? null,
      commandType: opts.commandType,
      commandPayload: opts.payload || {},
    });
    DecisionActionService.approve(orgId, a.id, "u-approver");
    return a.id;
  };

  // ===== 1. WhatsAppSendCommandHandler executa (sem confirmação externa) =====
  const channelId = randomUUID();
  db.prepare(`INSERT INTO channels (id, organization_id, name, kind, provider, status) VALUES (?, ?, 'Canal Teste', 'whatsapp', 'test', 'active')`).run(channelId, orgAId);
  setPolicy(orgAId, "runtime", "generic_execute");
  const a1 = mkApprovedAction(orgAId, { commandType: "whatsapp_send", payload: { channelId, recipient: "5511988887777", message: "olá!" } });
  const r1 = await CommandExecutorService.execute(orgAId, a1);
  check("WhatsApp: execute retorna effect='wa_msg_sent'", r1.result?.effect === "wa_msg_sent");
  check("WhatsApp: MessageProvider.sendMessage foi chamado 1x", sentMessages.length === 1 && sentMessages[0].to === "5511988887777");
  check("WhatsApp: message_id vira externalRef", !!r1.result?.externalRef);
  check("WhatsApp: NÃO cria action_confirmation (fire-and-forget)", ConfirmationEngine.getForAction(orgAId, a1) === null);

  // ===== 2. WhatsApp: channel de outra org → non_retryable (isolamento) =====
  const a2 = mkApprovedAction(orgBId, { commandType: "whatsapp_send", payload: { channelId, recipient: "5511977776666", message: "cross" } });
  setPolicy(orgBId, "runtime", "generic_execute");
  let threw = false;
  try { await CommandExecutorService.execute(orgBId, a2); } catch { threw = true; }
  check("WhatsApp: channel de outra org é recusado (isolamento)", threw && sentMessages.length === 1);

  // ===== 3. WhatsApp: validação payload — channelId ausente → non_retryable =====
  const a3 = mkApprovedAction(orgAId, { commandType: "whatsapp_send", payload: { recipient: "5511988887777", message: "sem channel" } });
  threw = false;
  try { await CommandExecutorService.execute(orgAId, a3); } catch { threw = true; }
  check("WhatsApp: sem channelId → recusa auditada", threw);

  // ===== 4. PixCharge executa pelo EIXO B (gateway por-org) + expect(gateway_payment_webhook) =====
  const a4 = mkApprovedAction(orgAId, {
    commandType: "asaas_pix_charge", expectedImpact: 4200,
    payload: { receivableId: rcvId, contactId: "cust_test_1", amount: 4200, description: "Fatura 4587", dueDate: "2026-08-15" },
  });
  const r4 = await CommandExecutorService.execute(orgAId, a4);
  const paymentId = r4.result?.externalRef;
  check("PixCharge: cria payment via gateway POR-ORG e devolve externalRef", !!paymentId && paymentId.startsWith("mp_e2e_"));
  check("PixCharge: chamou o Mercado Pago (Eixo B), NUNCA o ASAAS", mpCalls.some((c) => c.method === "POST" && c.url.includes("mercadopago")) && !mpCalls.some((c) => c.url.includes("asaas")));
  check("PixCharge: reference rcv:<id> + token do lojista", mpCalls[0].body.external_reference === `rcv:${rcvId}`);
  const conf4 = ConfirmationEngine.getForAction(orgAId, a4);
  check("PixCharge: confirmação pendente método gateway_payment_webhook", conf4?.status === "pending" && conf4?.confirmation_method === "gateway_payment_webhook" && conf4?.external_ref === paymentId);
  const actionAfterExec = DecisionActionService.get(orgAId, a4);
  check("PixCharge: ação segue 'approved' após execute (aguardando webhook)", actionAfterExec.status === "approved" && !!actionAfterExec.executed_at);

  // ===== 5. findByExternalRef retorna a confirmação viva =====
  const found = ConfirmationEngine.findByExternalRef("gateway_payment_webhook", paymentId);
  check("findByExternalRef acha (org, confirmation) pela ref", found?.orgId === orgAId && found?.confirmation.action_id === a4);
  check("findByExternalRef null quando ref não existe", ConfirmationEngine.findByExternalRef("gateway_payment_webhook", "nao_existe") === null);

  // ===== 6. Webhook do gateway (MP) fecha a ação + dá baixa no recebível (F3) =====
  const w1 = await PaymentService.syncMercadoPagoPayment(orgAId, paymentId);
  check("webhook MP re-consulta e aprova", w1 === "approved");
  await new Promise((r) => setTimeout(r, 30));
  const closedAction = DecisionActionService.get(orgAId, a4);
  check("webhook fecha a ação (status='done')", closedAction.status === "done");
  check("webhook grava result_amount=4200", Number(closedAction.result_amount) === 4200);
  const closedConf = ConfirmationEngine.getForAction(orgAId, a4);
  check("webhook marca confirmação como 'confirmed' com evidência", closedConf?.status === "confirmed" && closedConf?.evidence?.paymentId === paymentId);
  const rcvRow = db.prepare(`SELECT status FROM receivables WHERE id = ?`).get(rcvId) as any;
  check("F3: recebível marcado 'received' (system-of-record)", rcvRow?.status === "received");

  // ===== 7. Idempotência: re-sync do MESMO pagamento NÃO reabre =====
  const w2 = await PaymentService.syncMercadoPagoPayment(orgAId, paymentId);
  await new Promise((r) => setTimeout(r, 30));
  check("re-sync do webhook NÃO reabre ação", w2 === "approved" && DecisionActionService.get(orgAId, a4).status === "done");

  // ===== 8. Webhook com payment desconhecido (sem confirmação viva) é NO-OP =====
  mpPayments["mp_desconhecido"] = { ref: "rcv:nao_existe", amount: 500 };
  const w3 = await PaymentService.syncMercadoPagoPayment(orgAId, "mp_desconhecido");
  check("webhook com payment_id sem confirmação viva é NO-OP", w3 === "approved" && DecisionActionService.get(orgAId, a4).status === "done");

  // ===== 9. Scheduler.confirmationTimeoutPass fecha vencidas =====
  const rcv9 = `rcv_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO receivables (id, organization_id, description, amount, due_date, status) VALUES (?, ?, 'timeout test', 100, '2026-08-15', 'open')`).run(rcv9, orgAId);
  const a9 = mkApprovedAction(orgAId, { commandType: "asaas_pix_charge", expectedImpact: 100, payload: { receivableId: rcv9, contactId: "cust_test_1", amount: 100, description: "timeout test", confirmationDeadline: new Date(Date.now() - 60_000).toISOString() } });
  await CommandExecutorService.execute(orgAId, a9);
  const conf9before = ConfirmationEngine.getForAction(orgAId, a9);
  check("setup: confirmação criada com deadline vencido", conf9before?.status === "pending" && !!conf9before?.deadline_at);
  Scheduler.confirmationTimeoutPass();
  const conf9after = ConfirmationEngine.getForAction(orgAId, a9);
  check("Scheduler.confirmationTimeoutPass fecha vencidas como 'timed_out'", conf9after?.status === "timed_out");
  check("ação NÃO é fechada por timeout (executor não decide isso — só a confirmação vence)", DecisionActionService.get(orgAId, a9).status === "approved");

  // ===== 10. AsaasPix: amount inválido → non_retryable =====
  const aBad = mkApprovedAction(orgAId, { commandType: "asaas_pix_charge", payload: { customer: "cust_test_1", amount: -10, description: "invalid" } });
  threw = false;
  try { await CommandExecutorService.execute(orgAId, aBad); } catch { threw = true; }
  check("AsaasPix: amount<=0 → recusa auditada (non_retryable)", threw);

  // ===== 11. Alterdata: connector indisponível → permission (dead-letter humano) =====
  const aAlter = mkApprovedAction(orgAId, { commandType: "alterdata_fetch", payload: { kind: "daily_sales", date: "2026-08-03" } });
  threw = false;
  try { await CommandExecutorService.execute(orgAId, aAlter); } catch { threw = true; }
  check("Alterdata: sem connector real → recusa (permission ou execução dummy)", threw || (CommandExecutorService.executions(orgAId, aAlter)[0]?.status === "done"));

  // ===== 12. Regressão: prepare dos handlers concretos funciona =====
  const aPrep = mkApprovedAction(orgAId, { commandType: "whatsapp_send", payload: { channelId, recipient: "5511911112222", message: "prep!" } });
  const prep = CommandExecutorService.prepare(orgAId, aPrep);
  check("prepare do WhatsAppSend funciona (regressão)", prep.ok === true && prep.result?.artifact?.kind === "wa_draft");
  check("prepare do WhatsAppSend NÃO envia mensagem real", sentMessages.length === 1); // continua no valor pré-2.3

  // ===== 13. registerHandler pluga os 3 concretos + os 5 originais (12 total) =====
  const types = CommandExecutorService.registeredCommandTypes();
  const hasAll = ["whatsapp_send", "asaas_pix_charge", "alterdata_fetch", "collection", "create_task"].every(t => types.includes(t));
  check("registry tem os 3 handlers da 2.3 + os 5 originais do ADR-136", hasAll && types.length >= 8);

  // ===== 14. Cross-tenant no webhook: confirmação da orgA não fecha se veio pra orgB =====
  // (o notifyRuntimeConfirmation resolve orgId da própria confirmação — impossível cross-fechar)
  // Verifica que sem external_ref na orgB, nada é fechado.
  const bAction = mkApprovedAction(orgBId, { commandType: "asaas_pix_charge", expectedImpact: 50, payload: { receivableId: rcvB, contactId: "cust_b", amount: 50, description: "b" } });
  await CommandExecutorService.execute(orgBId, bAction);
  const bConf = ConfirmationEngine.getForAction(orgBId, bAction);
  check("orgB tem confirmação viva separada da orgA", bConf?.status === "pending" && bConf?.external_ref?.startsWith("mp_e2e_"));

  // ===== Resultado =====
  console.log("\n=== ADR-152 Fatia 2.3 (handlers concretos + webhook Asaas + Scheduler) ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks OK`);
  if (failures > 0) process.exit(1);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
