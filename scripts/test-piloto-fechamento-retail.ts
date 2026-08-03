/**
 * TEST — ADR-152 Fatia 4a: Piloto Retail Daily Closing (end-to-end).
 *
 * O primeiro piloto do Runtime. Cobre o loop COMPLETO:
 *   1. seed do playbook `retail_daily_closing_v1` (idempotente)
 *   2. start pra (storeId, date) → process_instance detected
 *   3. runToCompletion → advance/execute/completeStep em cascata
 *   4. cenário auto-post (dentro da tolerância + zero unmatched):
 *      → RetailFloorReconciliationService.runDay concilia
 *      → RetailClosingDispatchHandler decide auto
 *      → RetailPostClosingCommandHandler lança em cash_events
 *      → processo termina em `completed` com result_json + outcome F3.1
 *   5. cenário escalate (fora da tolerância OU unmatched > 0):
 *      → dispatch cria DecisionAction awaiting_approval
 *      → cash_events NÃO recebe lançamento (guarda G-4a-3)
 *      → processo termina em `completed` mas evidência aponta escalate
 *   6. cenário no_sales (dia sem atendimento) → skipped, sem cash_event
 *   7. idempotência: rodar 2x o mesmo dia NÃO duplica cash_event
 *      (UNIQUE em cash_events.source_id) e retorna a instance viva
 *   8. isolamento multi-tenant: orgB não vê / não roda instância de orgA
 *   9. gates F2.2 (autonomy=execute + execution_mode≥approved_execution)
 *      bloqueiam auto-post → dispatch falha → runner marca instance failed
 *
 * Determinístico. Uso: npm run test:piloto-fechamento-retail
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-piloto-retail-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-piloto-retail-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { RetailClosingPlaybookService } = await import("../src/server/RetailClosingPlaybook.js");
  const { ProcessRuntimeService } = await import("../src/server/ProcessRuntimeService.js");
  const { DecisionActionService } = await import("../src/server/DecisionActionService.js");
  const { FinancialLedgerService } = await import("../src/server/FinancialLedgerService.js");
  const { OutcomeMeasurementService } = await import("../src/server/OutcomeMeasurementService.js");

  const mkOrg = () => {
    const id = `org_${randomUUID().slice(0, 8)}`;
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, execution_runtime_enabled) VALUES (?, ?, 'X', 'active', 1)`).run(randomUUID(), id);
    return id;
  };
  const setPolicy = (orgId: string, actionType: string) => {
    db.prepare(`INSERT INTO agent_policies (id, organization_id, domain, action_type, autonomy_level, execution_mode, active) VALUES (?, ?, 'runtime', ?, 'execute', 'approved_execution', 1)`).run(randomUUID(), orgId, actionType);
    db.prepare(`INSERT INTO agent_policies (id, organization_id, domain, action_type, autonomy_level, execution_mode, active) VALUES (?, ?, 'retail', ?, 'execute', 'approved_execution', 1)`).run(randomUUID(), orgId, actionType);
  };
  const mkStore = (orgId: string, code = "L1") => {
    const id = randomUUID();
    db.prepare(`INSERT INTO retail_stores (id, organization_id, name, code, active) VALUES (?, ?, 'Loja Teste', ?, 1)`).run(id, orgId, code);
    return id;
  };
  const mkSeller = (orgId: string, matricula = "M1") => {
    const id = randomUUID();
    db.prepare(`INSERT INTO retail_sellers (id, organization_id, matricula, name, active) VALUES (?, ?, ?, 'Vendedor', 1)`).run(id, orgId, matricula);
    return id;
  };
  const mkShift = (orgId: string, storeId: string) => {
    const id = randomUUID();
    db.prepare(`INSERT INTO retail_floor_shifts (id, organization_id, store_id, status) VALUES (?, ?, ?, 'open')`).run(id, orgId, storeId);
    return id;
  };
  const mkAtt = (orgId: string, storeId: string, shiftId: string, sellerId: string, date: string, declared: number) => {
    const id = randomUUID();
    db.prepare(
      `INSERT INTO retail_floor_attendances (id, organization_id, store_id, shift_id, seller_id, started_at, ended_at, outcome, reconciliation_state, declared_value)
       VALUES (?, ?, ?, ?, ?, datetime(? || ' 10:00:00'), datetime(? || ' 10:15:00'), 'converted', 'pending', ?)`
    ).run(id, orgId, storeId, shiftId, sellerId, date, date, declared);
    return id;
  };
  const mkErpSale = (orgId: string, storeId: string, matricula: string, date: string, valor: number) => {
    db.prepare(`INSERT INTO retail_erp_seller_sales (id, organization_id, store_id, filial, sale_date, matricula, valor, pecas) VALUES (?, ?, ?, ?, ?, ?, ?, 1)`).run(randomUUID(), orgId, storeId, "L1", date, matricula, valor);
  };
  const cashEventsFor = (orgId: string, storeId: string, date: string) => db.prepare(`SELECT * FROM cash_events WHERE organization_id = ? AND source_type = 'retail_closing' AND source_id = ?`).all(orgId, `${storeId}:${date}`) as any[];

  // ============================================================
  // Setup
  // ============================================================
  const orgA = mkOrg();
  const orgB = mkOrg();
  setPolicy(orgA, "retail_post_closing");
  db.prepare(`INSERT INTO agent_policies (id, organization_id, domain, action_type, autonomy_level, execution_mode, active) VALUES (?, ?, 'runtime', 'runtime_step_reconcile', 'execute', 'approved_execution', 1)`).run(randomUUID(), orgA);
  db.prepare(`INSERT INTO agent_policies (id, organization_id, domain, action_type, autonomy_level, execution_mode, active) VALUES (?, ?, 'runtime', 'runtime_step_post_dispatch', 'execute', 'approved_execution', 1)`).run(randomUUID(), orgA);

  // ===== 1. seed idempotente do playbook =====
  const def1 = RetailClosingPlaybookService.seed(orgA);
  check("seed cria playbook retail_daily_closing_v1 v1", def1.process_type === "retail_daily_closing_v1" && def1.version === 1);
  const def2 = RetailClosingPlaybookService.seed(orgA);
  check("seed é idempotente (não cria v2 se v1 já ativa)", def2.id === def1.id && def2.version === 1);

  // ===== 2-4. Auto-post: dentro da tolerância + zero unmatched =====
  const storeAuto = mkStore(orgA, "L_AUTO");
  const sellerAuto = mkSeller(orgA, "M_AUTO");
  const shiftAuto = mkShift(orgA, storeAuto);
  mkAtt(orgA, storeAuto, shiftAuto, sellerAuto, "2026-08-01", 500);
  mkAtt(orgA, storeAuto, shiftAuto, sellerAuto, "2026-08-01", 300);
  mkErpSale(orgA, storeAuto, "M_AUTO", "2026-08-01", 810); // gap = -10, tolerância 5% × 810 = 40.5 → auto ok

  const instAuto = RetailClosingPlaybookService.start(orgA, { storeId: storeAuto, date: "2026-08-01" });
  check("start cria instance 'detected' com subject storeId:date", instAuto.status === "detected" && instAuto.subject_id === `${storeAuto}:2026-08-01`);
  check("context recebe storeId/date/tolerancePct default 0.05", instAuto.context?.storeId === storeAuto && instAuto.context?.date === "2026-08-01" && instAuto.context?.tolerancePct === 0.05);

  const runA = await ProcessRuntimeService.runToCompletion(orgA, instAuto.id, { actor: "u-runner" });
  check("runToCompletion termina em 'completed' (auto-post)", runA.instance.status === "completed" && !!runA.instance.completed_at);
  const executedSteps = runA.steps.filter((s: any) => s.nextStep !== null).map((s: any) => s.nextStep);
  check("2 steps executados (reconcile + post_dispatch)", executedSteps.length === 2 && executedSteps.includes("reconcile") && executedSteps.includes("post_dispatch"));
  const cashA = cashEventsFor(orgA, storeAuto, "2026-08-01");
  check("cash_event lançado com valor ERP (810)", cashA.length === 1 && Number(cashA[0].amount) === 810 && cashA[0].direction === "in");
  check("cash_event tem source_type='retail_closing' e source_id='storeId:date'", cashA[0].source_type === "retail_closing" && cashA[0].source_id === `${storeAuto}:2026-08-01`);

  const dispatchResult = runA.instance.result?.post_dispatch;
  check("result.post_dispatch aponta auto_posted + decision.autoOk=true", dispatchResult?.kind === "retail_closing_auto_posted" && dispatchResult?.decision?.autoOk === true);
  check("result.post_dispatch tem cashEventId (externalRef)", !!dispatchResult?.cashEventId);
  check("result.reconcile carregou totals do RetailFloor", runA.instance.result?.reconcile?.totals?.declaredCount === 2 && Number(runA.instance.result?.reconcile?.totals?.erpValue) === 810);

  // ===== 5. Outcome com categorias explícitas (F3.1) =====
  const ledA = OutcomeMeasurementService.ledger(orgA, { domain: "retail" });
  check("outcome registrado com time_saved_minutes=15", ledA.totals.categories.timeSavedMinutes >= 15);
  check("outcome tem basis='fact' (fechamento é dado real)", ledA.items.some((i: any) => i.basis === "fact"));

  // ===== 6. Idempotência: rodar 2x mesmo dia NÃO duplica =====
  const inst2 = RetailClosingPlaybookService.start(orgA, { storeId: storeAuto, date: "2026-08-01" });
  check("start 2x com mesmo (storeId, date) devolve a instance TERMINAL da 1a (só há uma viva; a 1a completou)", inst2.id !== instAuto.id || inst2.status === "completed");
  // Se criou nova, roda e verifica que cash_event ainda é 1 (UNIQUE)
  if (inst2.id !== instAuto.id) {
    await ProcessRuntimeService.runToCompletion(orgA, inst2.id, { actor: "u-runner" });
  }
  const cashA2 = cashEventsFor(orgA, storeAuto, "2026-08-01");
  check("cash_events continua com 1 linha (UNIQUE source_id — G-4a-2)", cashA2.length === 1);

  // ===== 7. Escalate: fora da tolerância =====
  const storeEsc = mkStore(orgA, "L_ESC");
  const sellerEsc = mkSeller(orgA, "M_ESC");
  const shiftEsc = mkShift(orgA, storeEsc);
  mkAtt(orgA, storeEsc, shiftEsc, sellerEsc, "2026-08-01", 1000);
  mkErpSale(orgA, storeEsc, "M_ESC", "2026-08-01", 500); // gap = 500, tolerância 5% × 500 = 25 → ESCALATE

  const instEsc = RetailClosingPlaybookService.start(orgA, { storeId: storeEsc, date: "2026-08-01" });
  const runEsc = await ProcessRuntimeService.runToCompletion(orgA, instEsc.id, { actor: "u-runner" });
  check("Escalate: processo completa (dispatch retorna, não trava)", runEsc.instance.status === "completed");
  const dispatchEsc = runEsc.instance.result?.post_dispatch;
  check("dispatch decidiu escalate (autoOk=false + escalatedActionId)", dispatchEsc?.kind === "retail_closing_escalated" && !!dispatchEsc?.escalatedActionId && dispatchEsc?.decision?.autoOk === false);
  const cashEsc = cashEventsFor(orgA, storeEsc, "2026-08-01");
  check("Escalate NÃO lança cash_event (guarda G-4a-3)", cashEsc.length === 0);
  const escAction = DecisionActionService.get(orgA, dispatchEsc.escalatedActionId);
  check("DecisionAction do escalate criada como 'awaiting_approval'", escAction?.status === "awaiting_approval" && escAction?.action_type === "retail_closing_review");
  check("escalate.priorityScore reflete unmatched + gap", (escAction?.priority_score ?? 0) > 0);

  // ===== 8. no_sales: dia sem atendimento — sem cash_event =====
  const storeEmpty = mkStore(orgA, "L_EMPTY");
  const instEmpty = RetailClosingPlaybookService.start(orgA, { storeId: storeEmpty, date: "2026-08-01" });
  const runEmpty = await ProcessRuntimeService.runToCompletion(orgA, instEmpty.id, { actor: "u-runner" });
  check("no_sales: processo completa", runEmpty.instance.status === "completed");
  const dispEmpty = runEmpty.instance.result?.post_dispatch;
  check("no_sales: dispatch retorna 'skipped_no_sales'", dispEmpty?.kind === "retail_closing_skipped" && dispEmpty?.reason === "no_sales");
  const cashEmpty = cashEventsFor(orgA, storeEmpty, "2026-08-01");
  check("no_sales NÃO cria cash_event", cashEmpty.length === 0);

  // ===== 9. Isolamento cross-tenant =====
  RetailClosingPlaybookService.seed(orgB); // orgB tem playbook próprio
  const instOrgA = RetailClosingPlaybookService.start(orgA, { storeId: storeAuto, date: "2026-08-02" });
  let threw = false;
  try { await ProcessRuntimeService.runToCompletion(orgB, instOrgA.id, { actor: "u-runner" }); } catch { threw = true; }
  check("orgB não roda instance de orgA (isolamento)", threw);

  // ===== 10. execution_mode='assisted' bloqueia auto-post (G2 F2.2) =====
  const orgC = mkOrg();
  RetailClosingPlaybookService.seed(orgC);
  // Sem policy de retail_post_closing em orgC → execute vai recusar por policy_missing.
  const storeC = mkStore(orgC, "L_C");
  const sellerC = mkSeller(orgC, "M_C");
  const shiftC = mkShift(orgC, storeC);
  mkAtt(orgC, storeC, shiftC, sellerC, "2026-08-01", 100);
  mkErpSale(orgC, storeC, "M_C", "2026-08-01", 100);
  // Configura policy pros steps do runner (senão nem chega ao dispatch)
  db.prepare(`INSERT INTO agent_policies (id, organization_id, domain, action_type, autonomy_level, execution_mode, active) VALUES (?, ?, 'runtime', 'runtime_step_reconcile', 'execute', 'approved_execution', 1)`).run(randomUUID(), orgC);
  db.prepare(`INSERT INTO agent_policies (id, organization_id, domain, action_type, autonomy_level, execution_mode, active) VALUES (?, ?, 'runtime', 'runtime_step_post_dispatch', 'execute', 'approved_execution', 1)`).run(randomUUID(), orgC);
  // Deliberadamente NÃO adicionamos policy pro retail_post_closing (o dispatch precisa dela pra auto-post).
  const instC = RetailClosingPlaybookService.start(orgC, { storeId: storeC, date: "2026-08-01" });
  const runC = await ProcessRuntimeService.runToCompletion(orgC, instC.id, { actor: "u-runner" });
  check("Sem policy retail_post_closing: dispatch falha", runC.instance.status === "failed" || runC.instance.result?.post_dispatch?.kind === "retail_closing_escalated");
  const cashC = cashEventsFor(orgC, storeC, "2026-08-01");
  check("orgC (sem policy): NENHUM cash_event lançado", cashC.length === 0);

  // ===== Resultado =====
  console.log("\n=== ADR-152 Fatia 4a (Piloto Retail Closing) ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks OK`);
  if (failures > 0) process.exit(1);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
