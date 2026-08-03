/**
 * TEST — ADR-152 Fatia 4b: Piloto Cobrança MVP (end-to-end).
 *
 * O 2º piloto do Runtime. Testa o loop completo de UM lembrete de cobrança:
 *   1. seed do playbook `receivable_collection_v1` (idempotente).
 *   2. start pra (receivableId) → process_instance detected.
 *   3. runToCompletion → advance/execute/completeStep num único step
 *      composto `collection_send_reminder`:
 *        a. cria PIX no Asaas (mock _req);
 *        b. amarra ConfirmationEngine.expect(asaas_payment_webhook, paymentId);
 *        c. envia WhatsApp (mock sendMessage) com QR/link.
 *   4. Webhook Asaas chega → notifyRuntimeConfirmation → confirmação
 *      fecha ação com result_amount → outcome F3.1 registra
 *      revenue_recovered.
 *   5. Timeout: se webhook NÃO chega até deadline+ →
 *      Scheduler.confirmationTimeoutPass fecha 'timed_out'.
 *   6. Idempotência: 2 start no mesmo receivable → dedupe por subject vivo.
 *   7. Isolamento multi-tenant.
 *   8. Validações de payload (phone/channelId/customerId/amount) → 400
 *      no start; non_retryable no execute.
 *   9. Guarda: receivable com status != 'open' é rejeitado.
 *
 * Determinístico (mocks pra MessageProvider + AsaasService).
 * Uso: npm run test:piloto-cobranca
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-piloto-cobranca-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-piloto-cobranca-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { CollectionPlaybookService } = await import("../src/server/CollectionPlaybook.js");
  const { ProcessRuntimeService } = await import("../src/server/ProcessRuntimeService.js");
  const { DecisionActionService } = await import("../src/server/DecisionActionService.js");
  const { ConfirmationEngine } = await import("../src/server/ConfirmationEngine.js");
  const { MessageProviderService } = await import("../src/server/MessageProviderService.js");
  const { AsaasService } = await import("../src/server/AsaasService.js");
  const { OutcomeMeasurementService } = await import("../src/server/OutcomeMeasurementService.js");
  const { Scheduler } = await import("../src/server/Scheduler.js");

  // ── Mocks I/O externo ──────────────────────────────────────────────────
  const sentMessages: Array<{ channelId: string; to: string; text: string }> = [];
  (MessageProviderService as any).sendMessage = async (channelId: string, to: string, text: string) => {
    sentMessages.push({ channelId, to, text });
    return `msg_${randomUUID().slice(0, 8)}`;
  };
  const createdPayments: Array<{ body: any }> = [];
  let nextPaymentSeq = 1;
  let asaasShouldFail: { status: number; message: string } | null = null;
  (AsaasService as any)._req = async (method: string, urlPath: string, body: any) => {
    if (asaasShouldFail) { const e: any = new Error(asaasShouldFail.message); e.status = asaasShouldFail.status; throw e; }
    if (method === "POST" && urlPath === "/payments") {
      const id = `pay_col_${nextPaymentSeq++}`;
      createdPayments.push({ body });
      return { id, status: "PENDING", value: body?.value, dueDate: body?.dueDate };
    }
    return null;
  };
  // Get pra webhook confirm — devolve CONFIRMED.
  (AsaasService as any).getPayment = async (id: string) => ({ id, status: "CONFIRMED", value: 100 });

  // ── Helpers ────────────────────────────────────────────────────────────
  const mkOrg = () => {
    const id = `org_${randomUUID().slice(0, 8)}`;
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, execution_runtime_enabled, external_customer_id, external_subscription_id, billing_status) VALUES (?, ?, 'X', 'active', 1, ?, ?, 'active')`)
      .run(randomUUID(), id, `cust_${id}`, `sub_${id}`);
    return id;
  };
  const setPolicy = (orgId: string, domain: string, actionType: string) => {
    db.prepare(`INSERT INTO agent_policies (id, organization_id, domain, action_type, autonomy_level, execution_mode, active) VALUES (?, ?, ?, ?, 'execute', 'approved_execution', 1)`)
      .run(randomUUID(), orgId, domain, actionType);
  };
  const setPoliciesForCollection = (orgId: string) => {
    // Runner precisa executar o step composto.
    setPolicy(orgId, "runtime", "runtime_step_send_reminder");
    // O executor recusa se o action não tiver policy pro seu commandType.
    setPolicy(orgId, "runtime", "collection_send_reminder");
  };
  const mkChannel = (orgId: string) => {
    const id = randomUUID();
    db.prepare(`INSERT INTO channels (id, organization_id, name, provider, status, kind) VALUES (?, ?, 'Canal Cobrança', 'whatsapp_cloud', 'active', 'client')`)
      .run(id, orgId);
    return id;
  };
  const mkReceivable = (orgId: string, amount: number, dueDate: string, status: string = "open") => {
    const id = randomUUID();
    db.prepare(`INSERT INTO receivables (id, organization_id, description, amount, due_date, status) VALUES (?, ?, 'Fatura teste', ?, ?, ?)`)
      .run(id, orgId, amount, dueDate, status);
    return id;
  };
  const confirmationOf = (orgId: string, actionId: string) => ConfirmationEngine.getForAction(orgId, actionId);

  // ============================================================
  // Setup
  // ============================================================
  const orgA = mkOrg();
  const orgB = mkOrg();
  setPoliciesForCollection(orgA);
  setPoliciesForCollection(orgB);
  const channelA = mkChannel(orgA);
  const channelB = mkChannel(orgB);

  // ===== 1. seed idempotente =====
  const def1 = CollectionPlaybookService.seed(orgA);
  check("seed cria playbook receivable_collection_v1 v1", def1.process_type === "receivable_collection_v1" && def1.version === 1);
  const def2 = CollectionPlaybookService.seed(orgA);
  check("seed é idempotente (não cria v2)", def2.id === def1.id && def2.version === 1);

  // ===== 2. Happy path: cria + envia + amarra webhook + fecha pagando =====
  const recA = mkReceivable(orgA, 100, "2026-08-30");
  const instA = CollectionPlaybookService.start(orgA, {
    receivableId: recA, phone: "5511988887777", channelId: channelA,
    customerId: `cust_${orgA}`, amount: 100, dueDate: "2026-08-30",
    description: "Fatura de exemplo",
  });
  check("start cria instance 'detected' com subject=receivableId", instA.status === "detected" && instA.subject_id === recA);
  check("context recebe phone/channelId/customerId/amount/dueDate", instA.context?.phone === "5511988887777" && instA.context?.channelId === channelA && Number(instA.context?.amount) === 100);

  const beforeMsgs = sentMessages.length;
  const runA = await ProcessRuntimeService.runToCompletion(orgA, instA.id, { actor: "u-runner" });
  check("runToCompletion termina em 'completed' (webhook async, action fica open)", runA.instance.status === "completed");
  check("1 step executado (send_reminder)", runA.steps.filter((s: any) => s.nextStep !== null).length === 1);
  check("PIX criado no Asaas (_req chamado com POST /payments)", createdPayments.length === 1 && createdPayments[0].body.value === 100 && createdPayments[0].body.billingType === "PIX");
  check("WhatsApp enviado (MessageProvider.sendMessage 1×)", sentMessages.length === beforeMsgs + 1);
  const sent = sentMessages[sentMessages.length - 1];
  check("mensagem tem valor formatado (R$ 100,00)", /R\$ ?100,00/.test(sent.text));
  check("mensagem enviada pro phone/channel corretos", sent.channelId === channelA && sent.to === "5511988887777");

  const sendResult = runA.instance.result?.send_reminder;
  check("result.send_reminder (artifact) tem paymentId", !!sendResult?.paymentId && String(sendResult.paymentId).startsWith("pay_col_"));
  check("result.send_reminder.kind='collection_reminder_sent'", sendResult?.kind === "collection_reminder_sent");

  // ===== 3. ConfirmationEngine.expect foi amarrada com externalRef=paymentId =====
  // ProcessRuntimeService.runStep chama DecisionActionService.propose sem
  // amarrar process_instance_id (ADR-136 não expõe esse campo). Recuperamos
  // pela action_type = runtime_step_<stepId> + command_type do step +
  // created_at recente (só há uma nesta org com esse commandType até aqui).
  const actionsCollection = db.prepare(`SELECT id, status, result_amount FROM decision_actions WHERE organization_id = ? AND command_type = 'collection_send_reminder' ORDER BY created_at ASC`).all(orgA) as any[];
  check("1 DecisionAction 'collection_send_reminder' criada pela runStep", actionsCollection.length === 1);
  const actionId: string = actionsCollection[0]?.id;
  check("actionId do step send_reminder existe", !!actionId);
  const confBefore = confirmationOf(orgA, actionId);
  check("ConfirmationEngine.expect ativa amarrada ao paymentId", confBefore?.status === "pending" && confBefore?.confirmation_method === "asaas_payment_webhook" && !!confBefore?.external_ref);
  const paymentId: string = confBefore.external_ref;
  const found = ConfirmationEngine.findByExternalRef("asaas_payment_webhook", paymentId);
  check("findByExternalRef(payment_id) retorna a confirmação viva da orgA", found?.orgId === orgA && found?.confirmation.action_id === actionId);

  // ===== 4. Webhook Asaas fecha ação com result_amount → outcome revenue_recovered =====
  (AsaasService as any).getPayment = async (id: string) => ({ id, status: "CONFIRMED", value: 100 });
  const w1 = await (AsaasService as any).handleWebhook({}, {
    id: "evt_col_1", event: "PAYMENT_RECEIVED",
    payment: { id: paymentId, status: "RECEIVED", value: 100, subscription: `sub_${orgA}`, customer: `cust_${orgA}`, dueDate: "2026-08-30" },
  });
  check("webhook Asaas OK", w1.status === "ok");
  await new Promise((r) => setTimeout(r, 30));

  const closedAction = DecisionActionService.get(orgA, actionId);
  check("webhook fecha a ação (status='done')", closedAction.status === "done");
  check("webhook grava result_amount=100", Number(closedAction.result_amount) === 100);
  const closedConf = confirmationOf(orgA, actionId);
  check("confirmação vira 'confirmed' com evidence.paymentId", closedConf?.status === "confirmed" && closedConf?.evidence?.paymentId === paymentId);

  // Ledger F3.1 — a categoria revenue_recovered deve ter registro.
  const ledA = OutcomeMeasurementService.ledger(orgA, {});
  check("ledger F3.1 acumula revenue_recovered ≥ 100", Number(ledA.totals?.categories?.revenueRecovered || 0) >= 100);

  // ===== 5. Webhook duplicado NÃO reabre =====
  const w2 = await (AsaasService as any).handleWebhook({}, {
    id: "evt_col_1_dup", event: "PAYMENT_RECEIVED",
    payment: { id: paymentId, status: "RECEIVED", value: 100, subscription: `sub_${orgA}`, customer: `cust_${orgA}`, dueDate: "2026-08-30" },
  });
  await new Promise((r) => setTimeout(r, 30));
  check("webhook duplicado é NO-OP (ação permanece done)", w2.status === "ok" && DecisionActionService.get(orgA, actionId).status === "done");

  // ===== 6. Idempotência do start (dedupe por subject vivo) =====
  const recIdem = mkReceivable(orgA, 200, "2026-09-05");
  const inst1 = CollectionPlaybookService.start(orgA, {
    receivableId: recIdem, phone: "5511911112222", channelId: channelA,
    customerId: `cust_${orgA}`, amount: 200, dueDate: "2026-09-05",
  });
  // Antes de rodar, start 2× no mesmo subject devolve a mesma instance.
  const inst2 = CollectionPlaybookService.start(orgA, {
    receivableId: recIdem, phone: "5511911112222", channelId: channelA,
    customerId: `cust_${orgA}`, amount: 200, dueDate: "2026-09-05",
  });
  check("start 2× no mesmo receivable com instance viva devolve a MESMA (dedupe)", inst1.id === inst2.id);

  // ===== 7. Timeout: Scheduler.confirmationTimeoutPass fecha vencidas =====
  const recTimeout = mkReceivable(orgA, 50, "2026-08-01");
  const instTimeout = CollectionPlaybookService.start(orgA, {
    receivableId: recTimeout, phone: "5511922223333", channelId: channelA,
    customerId: `cust_${orgA}`, amount: 50, dueDate: "2026-08-01",
    // Deadline no passado — sweep pega direto.
    confirmationDeadline: new Date(Date.now() - 3600_000).toISOString(),
  });
  const actionsBefore = db.prepare(`SELECT id FROM decision_actions WHERE organization_id = ? AND command_type = 'collection_send_reminder'`).all(orgA) as any[];
  const beforeCount = actionsBefore.length;
  await ProcessRuntimeService.runToCompletion(orgA, instTimeout.id, { actor: "u-runner" });
  const actsTimeoutAll = db.prepare(`SELECT id, created_at FROM decision_actions WHERE organization_id = ? AND command_type = 'collection_send_reminder' ORDER BY created_at ASC`).all(orgA) as any[];
  check("nova DecisionAction criada pra instTimeout", actsTimeoutAll.length === beforeCount + 1);
  const actionTimeout: string = actsTimeoutAll[actsTimeoutAll.length - 1]?.id;
  const confT_before = confirmationOf(orgA, actionTimeout);
  check("setup timeout: confirmação criada com deadline vencido", confT_before?.status === "pending");
  Scheduler.confirmationTimeoutPass();
  const confT_after = confirmationOf(orgA, actionTimeout);
  check("Scheduler.confirmationTimeoutPass fecha vencidas como 'timed_out'", confT_after?.status === "timed_out");
  // Ação segue 'approved' (executor não decide fechamento — só a confirmação vence; alta operacional aparece na aba Operações).
  check("ação NÃO é fechada por timeout (permanece 'approved')", DecisionActionService.get(orgA, actionTimeout).status === "approved");

  // ===== 8. Isolamento cross-tenant =====
  const recB = mkReceivable(orgB, 300, "2026-09-01");
  CollectionPlaybookService.seed(orgB);
  const instOrgB_do_A = CollectionPlaybookService.start(orgA, {
    receivableId: recB, phone: "5511933334444", channelId: channelA,
    customerId: `cust_${orgA}`, amount: 300, dueDate: "2026-09-01",
  });
  // Uma instance criada em orgA com um receivable de orgB (que pertence a orgB) — o handler
  // vai recusar via `receivable não pertence à org` (non_retryable). O runner deve marcar failed.
  const runCross = await ProcessRuntimeService.runToCompletion(orgA, instOrgB_do_A.id, { actor: "u-runner" });
  check("cross-tenant: run marca process como failed (receivable de outra org)", runCross.instance.status === "failed" || runCross.instance.status === "escalated");

  // orgB não vê instance criada em orgA:
  let crossThrew = false;
  try { await ProcessRuntimeService.runToCompletion(orgB, instTimeout.id, { actor: "u-runner" }); } catch { crossThrew = true; }
  check("orgB não roda instance de orgA (isolamento ProcessRuntimeService)", crossThrew);

  // ===== 9. Validação de payload no start (rota-agnóstica) =====
  let threwVal = false; try { CollectionPlaybookService.start(orgA, { receivableId: "", phone: "5511900001111", channelId: channelA, customerId: `cust_${orgA}`, amount: 50, dueDate: "2026-08-30" } as any); } catch { threwVal = true; }
  check("start sem receivableId → throw", threwVal);
  threwVal = false; try { CollectionPlaybookService.start(orgA, { receivableId: "x", phone: "", channelId: channelA, customerId: `cust_${orgA}`, amount: 50, dueDate: "2026-08-30" } as any); } catch { threwVal = true; }
  check("start sem phone → throw", threwVal);
  threwVal = false; try { CollectionPlaybookService.start(orgA, { receivableId: "x", phone: "111", channelId: "", customerId: `cust_${orgA}`, amount: 50, dueDate: "2026-08-30" } as any); } catch { threwVal = true; }
  check("start sem channelId → throw", threwVal);
  threwVal = false; try { CollectionPlaybookService.start(orgA, { receivableId: "x", phone: "111", channelId: channelA, customerId: "", amount: 50, dueDate: "2026-08-30" } as any); } catch { threwVal = true; }
  check("start sem customerId → throw", threwVal);
  threwVal = false; try { CollectionPlaybookService.start(orgA, { receivableId: "x", phone: "111", channelId: channelA, customerId: `cust_${orgA}`, amount: -1, dueDate: "2026-08-30" } as any); } catch { threwVal = true; }
  check("start amount≤0 → throw", threwVal);
  threwVal = false; try { CollectionPlaybookService.start(orgA, { receivableId: "x", phone: "111", channelId: channelA, customerId: `cust_${orgA}`, amount: 50, dueDate: "30/08/2026" } as any); } catch { threwVal = true; }
  check("start dueDate fora do formato YYYY-MM-DD → throw", threwVal);

  // ===== 10. Guarda: receivable status != 'open' é rejeitado =====
  const recPaid = mkReceivable(orgA, 40, "2026-09-15", "received");
  const instPaid = CollectionPlaybookService.start(orgA, {
    receivableId: recPaid, phone: "5511944445555", channelId: channelA,
    customerId: `cust_${orgA}`, amount: 40, dueDate: "2026-09-15",
  });
  const runPaid = await ProcessRuntimeService.runToCompletion(orgA, instPaid.id, { actor: "u-runner" });
  check("receivable 'received' bloqueia execute (process não completa OK)", runPaid.instance.status === "failed" || runPaid.instance.status === "escalated");

  // ===== 11. Asaas falha (503) → non-completion, PIX-less; NÃO envia mensagem =====
  const msgsBeforeFail = sentMessages.length;
  const recFail = mkReceivable(orgA, 90, "2026-10-01");
  const instFail = CollectionPlaybookService.start(orgA, {
    receivableId: recFail, phone: "5511955556666", channelId: channelA,
    customerId: `cust_${orgA}`, amount: 90, dueDate: "2026-10-01",
  });
  asaasShouldFail = { status: 503, message: "Asaas indisponível" };
  const runFail = await ProcessRuntimeService.runToCompletion(orgA, instFail.id, { actor: "u-runner" });
  asaasShouldFail = null;
  check("Asaas 503 → processo não completa em 'completed'", runFail.instance.status !== "completed");
  check("Asaas 503: G-4b-3 — NÃO envia WhatsApp sem PIX (contagem inalterada)", sentMessages.length === msgsBeforeFail);

  // ============================================================
  // Resultado
  // ============================================================
  console.log("\n=== ADR-152 Fatia 4b (Piloto Cobrança MVP) ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks OK`);
  if (failures > 0) process.exit(1);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
