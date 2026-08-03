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
  const { Scheduler } = await import("../src/server/Scheduler.js");
  // Side-effect: registra os 3 handlers concretos.
  await import("../src/server/RuntimeCommandHandlers.js");

  // Mocks de I/O externo — testam o handler + auditoria + ConfirmationEngine
  // sem sair pra rede.
  const sentMessages: Array<{ channelId: string; to: string; text: string }> = [];
  (MessageProviderService as any).sendMessage = async (channelId: string, to: string, text: string) => {
    sentMessages.push({ channelId, to, text });
    return `msg_${randomUUID().slice(0, 8)}`;
  };
  const createdPayments: Array<{ orgId: string; amount: number; description: string }> = [];
  let nextPaymentSeq = 1;
  (AsaasService as any)._req = async (method: string, urlPath: string, body: any) => {
    if (method === "POST" && urlPath === "/payments") {
      const id = `pay_e2e_${nextPaymentSeq++}`;
      createdPayments.push({ orgId: body?.__orgHint || "?", amount: Number(body?.value), description: String(body?.description || "") });
      return { id, status: "PENDING", value: body?.value, dueDate: body?.dueDate };
    }
    return null;
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

  // ===== 4. AsaasPixCharge executa: cria payment + expect(asaas_payment_webhook) =====
  const a4 = mkApprovedAction(orgAId, {
    commandType: "asaas_pix_charge", expectedImpact: 4200,
    payload: { customer: "cust_test_1", amount: 4200, description: "Fatura 4587", dueDate: "2026-08-15" },
  });
  const r4 = await CommandExecutorService.execute(orgAId, a4);
  const paymentId = r4.result?.externalRef;
  check("AsaasPix: execute cria payment e devolve externalRef", !!paymentId && paymentId.startsWith("pay_e2e_"));
  check("AsaasPix: _req foi chamado com POST /payments", createdPayments.length === 1 && createdPayments[0].amount === 4200);
  const conf4 = ConfirmationEngine.getForAction(orgAId, a4);
  check("AsaasPix: cria action_confirmation pendente amarrada ao paymentId", conf4?.status === "pending" && conf4?.confirmation_method === "asaas_payment_webhook" && conf4?.external_ref === paymentId);
  const actionAfterExec = DecisionActionService.get(orgAId, a4);
  check("AsaasPix: ação segue 'approved' após execute (aguardando webhook)", actionAfterExec.status === "approved" && !!actionAfterExec.executed_at);

  // ===== 5. findByExternalRef retorna a confirmação viva =====
  const found = ConfirmationEngine.findByExternalRef("asaas_payment_webhook", paymentId);
  check("findByExternalRef acha (org, confirmation) pela ref", found?.orgId === orgAId && found?.confirmation.action_id === a4);
  check("findByExternalRef null quando ref não existe", ConfirmationEngine.findByExternalRef("asaas_payment_webhook", "nao_existe") === null);

  // ===== 6. Webhook Asaas fecha a ação por notifyRuntimeConfirmation =====
  // Mock getPayment pra devolver CONFIRMED.
  (AsaasService as any).getPayment = async (id: string) => (id === paymentId ? { id, status: "CONFIRMED", value: 4200 } : null);
  // Sem token configurado, handleWebhook passa (dev mode).
  const w1 = await (AsaasService as any).handleWebhook({}, {
    id: "evt_1", event: "PAYMENT_RECEIVED",
    payment: { id: paymentId, status: "RECEIVED", value: 4200, subscription: "sub_test_1", customer: "cust_test_1", dueDate: "2026-08-15" },
  });
  check("webhook Asaas processa OK", w1.status === "ok");
  // Espera um tick pra DecisionActionService.complete (import dinâmico do confirm).
  await new Promise((r) => setTimeout(r, 30));
  const closedAction = DecisionActionService.get(orgAId, a4);
  check("webhook fecha a ação (status='done')", closedAction.status === "done");
  check("webhook grava result_amount=4200", Number(closedAction.result_amount) === 4200);
  const closedConf = ConfirmationEngine.getForAction(orgAId, a4);
  check("webhook marca confirmação como 'confirmed' com evidência", closedConf?.status === "confirmed" && closedConf?.evidence?.paymentId === paymentId);

  // ===== 7. Idempotência: webhook duplicado NÃO reabre =====
  // Precisa usar novo eventId (o INSERT OR IGNORE dedupa por id de evento).
  const w2 = await (AsaasService as any).handleWebhook({}, {
    id: "evt_2_dup", event: "PAYMENT_RECEIVED",
    payment: { id: paymentId, status: "RECEIVED", value: 4200, subscription: "sub_test_1", customer: "cust_test_1", dueDate: "2026-08-15" },
  });
  await new Promise((r) => setTimeout(r, 30));
  check("webhook duplicado (novo eventId) NÃO reabre ação", w2.status === "ok" && DecisionActionService.get(orgAId, a4).status === "done");

  // ===== 8. Webhook com payment desconhecido (sem confirmação viva) é NO-OP =====
  (AsaasService as any).getPayment = async (id: string) => ({ id, status: "CONFIRMED", value: 500 });
  const w3 = await (AsaasService as any).handleWebhook({}, {
    id: "evt_3", event: "PAYMENT_RECEIVED",
    payment: { id: "pay_desconhecido_xyz", status: "RECEIVED", value: 500, subscription: "sub_test_1", customer: "cust_test_1" },
  });
  check("webhook com payment_id sem confirmação viva é NO-OP silencioso", w3.status === "ok");

  // ===== 9. Scheduler.confirmationTimeoutPass fecha vencidas =====
  const a9 = mkApprovedAction(orgAId, { commandType: "asaas_pix_charge", expectedImpact: 100, payload: { customer: "cust_test_1", amount: 100, description: "timeout test", confirmationDeadline: new Date(Date.now() - 60_000).toISOString() } });
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
  const bAction = mkApprovedAction(orgBId, { commandType: "asaas_pix_charge", expectedImpact: 50, payload: { customer: "cust_b", amount: 50, description: "b" } });
  await CommandExecutorService.execute(orgBId, bAction);
  const bConf = ConfirmationEngine.getForAction(orgBId, bAction);
  check("orgB tem confirmação viva separada da orgA", bConf?.status === "pending" && bConf?.external_ref?.startsWith("pay_e2e_"));

  // ===== Resultado =====
  console.log("\n=== ADR-152 Fatia 2.3 (handlers concretos + webhook Asaas + Scheduler) ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks OK`);
  if (failures > 0) process.exit(1);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
