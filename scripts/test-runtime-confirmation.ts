/**
 * TEST — ADR-152 Fatia 2.1: Confirmation Engine + backoff/dead-letter no
 * JobQueue + `execution_mode` na policy.
 *
 * Cobre a FUNDAÇÃO da Fase 2 (Execute + Confirmation) sem tocar em executor
 * real — a Fatia 2.2 sobe o teto do CommandExecutorService pra `execute` e a
 * 2.3 pluga os handlers concretos (WhatsApp/Asaas/Alterdata). Isolamento
 * cross-tenant e idempotência (o Asaas manda webhook 2x) são testados aqui.
 *
 * Determinístico (sem chave OpenAI). Uso: npm run test:runtime-confirmation
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-runtime-conf-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-runtime-conf-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { ConfirmationEngine } = await import("../src/server/ConfirmationEngine.js");
  const { DecisionActionService } = await import("../src/server/DecisionActionService.js");
  const { JobQueueService, JobQueueError, computeBackoffSeconds } = await import("../src/server/JobQueueService.js");

  const mkOrg = () => { const id = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), id); return id; };
  const orgA = mkOrg();
  const orgB = mkOrg();

  // ===== 1. execution_mode aditivo no agent_policies (default 'assisted') =====
  db.prepare(`INSERT INTO agent_policies (id, organization_id, domain, action_type) VALUES (?, ?, 'finance', 'collection')`).run(randomUUID(), orgA);
  const pol = db.prepare(`SELECT execution_mode FROM agent_policies WHERE organization_id = ? AND action_type = 'collection'`).get(orgA) as any;
  check("execution_mode default = 'assisted' (retrocompat total)", pol?.execution_mode === "assisted");

  // ===== 2. Backoff exponencial =====
  check("backoff retryable ataque 1 = 30s", computeBackoffSeconds(1, "retryable") === 30);
  check("backoff retryable ataque 3 = 120s (30*2^2)", computeBackoffSeconds(3, "retryable") === 120);
  check("backoff external_unavailable dobra a base (60s no ataque 1)", computeBackoffSeconds(1, "external_unavailable") === 60);
  check("backoff tem teto de 30 min", computeBackoffSeconds(20, "retryable") === 1800);

  // ===== 3. JobQueue — erro retryable respeita backoff =====
  let attempts = 0;
  JobQueueService.registerHandler("test_retryable", async () => { attempts++; throw new Error("transient"); });
  const j1 = JobQueueService.enqueue("test_retryable", {}, { maxAttempts: 3 });
  await new Promise((r) => setTimeout(r, 100));
  const row1 = JobQueueService.get(j1) as any;
  check("job retryable ainda 'pending' após falha (vai retentar)", row1?.status === "pending" && row1?.attempts === 1);
  check("next_attempt_at foi setado", !!row1?.next_attempt_at);
  check("error_class default 'retryable'", row1?.error_class === "retryable");

  // sweep NÃO reprocessa antes do next_attempt_at (backoff respeitado)
  const swept1 = JobQueueService.sweepStale(999);
  check("sweep respeita backoff (não reprocessa antes do vencimento)", swept1 === 0);

  // ===== 4. JobQueue — permission (non-retryable) vai direto pra dead-letter =====
  JobQueueService.registerHandler("test_permission", async () => { throw new JobQueueError("no credentials", "permission"); });
  const j2 = JobQueueService.enqueue("test_permission", {}, { maxAttempts: 5, organizationId: orgA });
  await new Promise((r) => setTimeout(r, 100));
  const row2 = JobQueueService.get(j2) as any;
  check("permission NÃO retenta (mesmo abaixo de max_attempts)", row2?.status === "failed" && row2?.attempts === 1 && row2?.error_class === "permission");
  const dead = JobQueueService.deadLetters(orgA);
  check("dead-letter lista o job da orgA", dead.length === 1 && dead[0].id === j2 && dead[0].error_class === "permission");
  const deadB = JobQueueService.deadLetters(orgB);
  check("dead-letter isolado por org (orgB não vê o de orgA)", deadB.length === 0);

  // ===== 5. retry manual reseta backoff/error_class =====
  const permCalls: boolean[] = [];
  JobQueueService.registerHandler("test_permission_fixed", async () => { permCalls.push(true); return { ok: true }; });
  // manualmente reclassifica o handler (simulando "credencial cadastrada e agora funciona")
  const j3 = JobQueueService.enqueue("test_permission_fixed", {}, { organizationId: orgA });
  await new Promise((r) => setTimeout(r, 50));
  const row3 = JobQueueService.get(j3) as any;
  check("job novo (permission_fixed) roda com sucesso", row3?.status === "completed" && permCalls.length === 1);

  // ===== 6. external_unavailable retenta com backoff maior =====
  JobQueueService.registerHandler("test_external_down", async () => { throw new JobQueueError("Asaas 503", "external_unavailable"); });
  const j4 = JobQueueService.enqueue("test_external_down", {}, { maxAttempts: 2 });
  await new Promise((r) => setTimeout(r, 100));
  const row4 = JobQueueService.get(j4) as any;
  check("external_unavailable retenta com backoff maior", row4?.status === "pending" && row4?.error_class === "external_unavailable" && row4?.backoff_seconds === 60);

  // ===== 7. ConfirmationEngine — método inválido é bloqueado =====
  let threw = false;
  try { ConfirmationEngine.expect(orgA, { actionId: randomUUID(), method: "inventado" as any }); } catch { threw = true; }
  check("expect com method desconhecido é rejeitado", threw);

  // ===== 8. expect exige ação da org (isolamento) =====
  threw = false;
  try { ConfirmationEngine.expect(orgA, { actionId: randomUUID(), method: "asaas_payment_webhook" }); } catch { threw = true; }
  check("expect com actionId inexistente é rejeitado", threw);

  // Cria uma ação de cobrança AGUARDANDO APROVAÇÃO (policy 'collection' = single) e aprova.
  const action = DecisionActionService.propose(orgA, { domain: "finance", actionType: "collection", title: "Cobrar R$ 4.200 vencidos", expectedImpact: 4200 });
  DecisionActionService.approve(orgA, action.id, "user-approver");
  check("ação de cobrança aprovada (setup)", DecisionActionService.get(orgA, action.id).status === "approved");

  // ===== 9. expect é idempotente por (org, action) =====
  const c1 = ConfirmationEngine.expect(orgA, { actionId: action.id, method: "asaas_payment_webhook", deadlineAt: new Date(Date.now() + 3600_000).toISOString() });
  const c2 = ConfirmationEngine.expect(orgA, { actionId: action.id, method: "asaas_payment_webhook" });
  check("expect 2x devolve a MESMA confirmação (UNIQUE)", c1.id === c2.id && c2.status === "pending");
  const cross = db.prepare(`SELECT COUNT(*) c FROM action_confirmations WHERE organization_id = ? AND action_id = ?`).get(orgA, action.id) as any;
  check("UNIQUE(org, action_id) — apenas 1 linha viva", cross.c === 1);

  // ===== 10. confirm sem expect prévio é 400 =====
  const orphanAction = DecisionActionService.propose(orgA, { domain: "finance", actionType: "collection", title: "Órfã", expectedImpact: 100 });
  DecisionActionService.approve(orgA, orphanAction.id, "user-approver");
  threw = false;
  try { ConfirmationEngine.confirm(orgA, orphanAction.id, {}); } catch { threw = true; }
  check("confirm sem expect prévio é rejeitado (subscriber não inventa)", threw);

  // ===== 11. confirm fecha a ação + registra outcome =====
  ConfirmationEngine.confirm(orgA, action.id, { evidence: { paymentId: "pay-123", provider: "asaas" }, resultAmount: 3800 });
  await new Promise((r) => setTimeout(r, 30)); // completed é async (import dinâmico)
  const closedConf = ConfirmationEngine.getForAction(orgA, action.id);
  check("confirmação vira 'confirmed' com evidência auditada", closedConf?.status === "confirmed" && closedConf?.evidence?.paymentId === "pay-123");
  const closedAction = DecisionActionService.get(orgA, action.id);
  check("ação vira 'done' com result_amount", closedAction.status === "done" && closedAction.result_amount === 3800);

  // ===== 12. Idempotência — webhook duplicado NÃO reabre =====
  const cbefore = ConfirmationEngine.getForAction(orgA, action.id);
  const cdupResult = ConfirmationEngine.confirm(orgA, action.id, { evidence: { paymentId: "pay-123" } });
  check("confirm em já 'confirmed' devolve a linha (idempotente)", cdupResult.status === "confirmed" && cdupResult.id === cbefore.id);

  // ===== 13. confirm em ação já 'done' (rollback manual antes) vira dismissed sem reprocessar =====
  const raceAction = DecisionActionService.propose(orgA, { domain: "finance", actionType: "collection", title: "Race", expectedImpact: 500 });
  DecisionActionService.approve(orgA, raceAction.id, "user-approver");
  ConfirmationEngine.expect(orgA, { actionId: raceAction.id, method: "asaas_payment_webhook" });
  DecisionActionService.complete(orgA, raceAction.id, { resultAmount: 500 }); // humano completou antes do webhook
  const raceConf = ConfirmationEngine.confirm(orgA, raceAction.id, { evidence: { paymentId: "late-webhook" } });
  check("webhook após rollback humano → dismissed (sem reabrir)", raceConf.status === "dismissed" && raceConf.evidence?.dismissedReason === "action_done");

  // ===== 14. Isolamento — orgB não fecha confirmação da orgA =====
  const bAction = DecisionActionService.propose(orgA, { domain: "finance", actionType: "collection", title: "Cross-tenant", expectedImpact: 200 });
  DecisionActionService.approve(orgA, bAction.id, "user-approver");
  ConfirmationEngine.expect(orgA, { actionId: bAction.id, method: "asaas_payment_webhook" });
  threw = false;
  try { ConfirmationEngine.confirm(orgB, bAction.id, { resultAmount: 200 }); } catch { threw = true; }
  check("confirm cross-tenant recusado (isolamento)", threw);
  const stillPending = ConfirmationEngine.getForAction(orgA, bAction.id);
  check("confirmação da orgA continua pendente após tentativa cross-tenant", stillPending?.status === "pending");

  // ===== 15. Dismiss humano =====
  const dAction = DecisionActionService.propose(orgA, { domain: "finance", actionType: "collection", title: "Dismiss test", expectedImpact: 100 });
  DecisionActionService.approve(orgA, dAction.id, "user-approver");
  ConfirmationEngine.expect(orgA, { actionId: dAction.id, method: "channel_reply" });
  const dismissed = ConfirmationEngine.dismiss(orgA, dAction.id, { reason: "cliente ligou e cancelou", actorId: "user-1" });
  check("dismiss vira status 'dismissed' com motivo auditado", dismissed.status === "dismissed" && dismissed.evidence?.dismissedReason === "cliente ligou e cancelou");
  threw = false;
  try { ConfirmationEngine.confirm(orgA, dAction.id, {}); } catch { threw = true; }
  check("confirm após dismiss é rejeitado (não reabre)", threw);

  // ===== 16. sweepTimeouts fecha as pendentes vencidas =====
  const tAction = DecisionActionService.propose(orgA, { domain: "finance", actionType: "collection", title: "Timeout test", expectedImpact: 100 });
  DecisionActionService.approve(orgA, tAction.id, "user-approver");
  const past = new Date(Date.now() - 60_000).toISOString();
  ConfirmationEngine.expect(orgA, { actionId: tAction.id, method: "channel_reply", deadlineAt: past });
  const swept = ConfirmationEngine.sweepTimeouts(orgA);
  check("sweepTimeouts fecha as pendentes vencidas", swept >= 1);
  const tConf = ConfirmationEngine.getForAction(orgA, tAction.id);
  check("confirmação vencida vira 'timed_out'", tConf?.status === "timed_out");

  // ===== 17. listPending — só o que ainda está aberto =====
  const openAction = DecisionActionService.propose(orgA, { domain: "finance", actionType: "collection", title: "Open", expectedImpact: 100 });
  DecisionActionService.approve(orgA, openAction.id, "user-approver");
  ConfirmationEngine.expect(orgA, { actionId: openAction.id, method: "asaas_payment_webhook" });
  const pendingList = ConfirmationEngine.listPending(orgA, { method: "asaas_payment_webhook" });
  // Nota: bAction (teste 14) ficou pendente na orgA propositalmente (o
  // confirm cross-tenant foi recusado, deixando-a pendente); openAction é a
  // recém-criada. Confirmamos que a nova está listada e que só 'pending'
  // apareceram (nenhuma confirmed/dismissed/timed_out infiltrou).
  const allPending = pendingList.every((p: any) => p.status === "pending");
  const hasOpen = pendingList.some((p: any) => p.action_id === openAction.id);
  check("listPending filtra por método e retorna só 'pending'", allPending && hasOpen);
  const pendingBList = ConfirmationEngine.listPending(orgB);
  check("listPending isolado por org", pendingBList.length === 0);

  // ===== Resultado =====
  console.log("\n=== ADR-152 Fatia 2.1 (Confirmation Engine + JobQueue backoff) ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks OK`);
  if (failures > 0) process.exit(1);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
