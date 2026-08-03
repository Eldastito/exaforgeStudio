/**
 * TEST — ADR-152 Fatia 3.1: Outcomes estendidos + RuntimeExceptionsService.
 *
 * Cobre: campos aditivos (time_saved_minutes, cost_avoided,
 * revenue_recovered, loss_prevented) em record()/get()/ledger() SEM somar
 * categorias diferentes num número enganoso (ADR-085 D4);
 * RuntimeExceptionsService.list() com as 4 fontes (process escalated/failed,
 * action com deadline vencido, background_jobs failed com classificação,
 * confirmação timed_out); ordenação por severidade
 * (credential_missing → sla_at_risk → integration_failed); count() por
 * categoria; overview() com "running / concluído hoje / exceções / SLA";
 * indicators() com todos os contadores; isolamento multi-tenant em toda
 * query. Regressão do ledger original (fact ≠ estimate).
 *
 * Determinístico. Uso: npm run test:runtime-operations
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-runtime-ops-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-runtime-ops-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { DecisionActionService } = await import("../src/server/DecisionActionService.js");
  const { OutcomeMeasurementService } = await import("../src/server/OutcomeMeasurementService.js");
  const { RuntimeExceptionsService } = await import("../src/server/RuntimeExceptionsService.js");
  const { ConfirmationEngine } = await import("../src/server/ConfirmationEngine.js");
  const { ProcessRuntimeService } = await import("../src/server/ProcessRuntimeService.js");
  const { JobQueueService, JobQueueError } = await import("../src/server/JobQueueService.js");

  const mkOrg = () => { const id = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), id); return id; };
  const orgA = mkOrg();
  const orgB = mkOrg();

  // ===== 1. record() aceita as 4 categorias e get() devolve =====
  const a1 = DecisionActionService.propose(orgA, { domain: "finance", actionType: "collection", title: "Cobrar", expectedImpact: 1000 });
  DecisionActionService.approve(orgA, a1.id, "u-1");
  const o1 = OutcomeMeasurementService.record(orgA, a1.id, {
    expectedValue: 1000, realizedValue: 950, basis: "fact", measurementMethod: "attributed",
    timeSavedMinutes: 45, revenueRecovered: 950, costAvoided: 0, lossPrevented: 0,
  });
  check("record aceita campos aditivos e persiste", o1.time_saved_minutes === 45 && Number(o1.revenue_recovered) === 950);

  // ===== 2. record antigo (sem campos novos) continua correto =====
  const a2 = DecisionActionService.propose(orgA, { domain: "finance", actionType: "collection", title: "Antigo", expectedImpact: 500 });
  DecisionActionService.approve(orgA, a2.id, "u-1");
  const o2 = OutcomeMeasurementService.record(orgA, a2.id, { expectedValue: 500, realizedValue: 500, basis: "fact", measurementMethod: "manual" });
  check("record antigo (sem categorias) grava null nos aditivos", o2.time_saved_minutes === null && o2.revenue_recovered === null);

  // ===== 3. ledger agrega por CATEGORIA sem misturar =====
  const a3 = DecisionActionService.propose(orgA, { domain: "ops", actionType: "create_task", title: "Automação" });
  // create_task nasce 'approved' na matriz padrão (não exige approval); só registra o outcome.
  OutcomeMeasurementService.record(orgA, a3.id, { basis: "estimate", measurementMethod: "derived", timeSavedMinutes: 30, costAvoided: 120 });

  const led = OutcomeMeasurementService.ledger(orgA);
  check("ledger separa fact × estimate (regressão ADR-085 D4)", led.totals.fact.realized === 1450 && led.totals.estimate.realized === 0);
  check("ledger.totals.categories.timeSavedMinutes = 45 + 30", led.totals.categories.timeSavedMinutes === 75);
  check("ledger.totals.categories.revenueRecovered = 950 (só do a1)", led.totals.categories.revenueRecovered === 950);
  check("ledger.totals.categories.costAvoided = 120 (só do a3)", led.totals.categories.costAvoided === 120);
  check("ledger.totals.categories.lossPrevented = 0 (nenhum registro)", led.totals.categories.lossPrevented === 0);

  // ===== 4. Exceção: process 'escalated' =====
  const def = ProcessRuntimeService.defineProcess(orgA, {
    processType: "retail_closing", name: "Fechamento",
    steps: { steps: [{ id: "s1", commandType: "collection", next: "$end" }] } as any,
  });
  const inst = ProcessRuntimeService.startForSubject(orgA, { processType: "retail_closing", subjectType: "loja", subjectId: "l1" });
  ProcessRuntimeService.transition(orgA, inst.id, "planned");
  ProcessRuntimeService.transition(orgA, inst.id, "awaiting_approval");
  ProcessRuntimeService.transition(orgA, inst.id, "escalated");
  void def;

  // ===== 5. Exceção: action com deadline vencido (SLA) =====
  const overdue = DecisionActionService.propose(orgA, { domain: "finance", actionType: "collection", title: "SLA vencido", expectedImpact: 200 });
  DecisionActionService.approve(orgA, overdue.id, "u-1");
  db.prepare(`UPDATE decision_actions SET deadline_at = ? WHERE id = ?`).run(new Date(Date.now() - 3600_000).toISOString(), overdue.id);

  // ===== 6. Exceção: job dead-letter com error_class='permission' =====
  JobQueueService.registerHandler("test_permission_ops", async () => { throw new JobQueueError("sem credencial", "permission"); });
  JobQueueService.enqueue("test_permission_ops", { actionId: "act-fantasma" }, { organizationId: orgA });
  await new Promise((r) => setTimeout(r, 50));

  // ===== 7. Exceção: confirmation timed_out =====
  const timedAction = DecisionActionService.propose(orgA, { domain: "finance", actionType: "collection", title: "Aguarda webhook", expectedImpact: 300 });
  DecisionActionService.approve(orgA, timedAction.id, "u-1");
  ConfirmationEngine.expect(orgA, { actionId: timedAction.id, method: "asaas_payment_webhook", deadlineAt: new Date(Date.now() - 60_000).toISOString(), externalRef: "pay-timed" });
  const swept = ConfirmationEngine.sweepTimeouts(orgA);
  check("setup: sweepTimeouts fechou 1 confirmação", swept === 1);

  // ===== 8. list() devolve as 4 fontes, categorizadas =====
  const exc = RuntimeExceptionsService.list(orgA);
  const cats = exc.map(e => e.category);
  check("exceções incluem 'decision_needed' (process escalated)", cats.includes("decision_needed"));
  check("exceções incluem 'sla_at_risk' (action deadline vencido)", cats.includes("sla_at_risk"));
  check("exceções incluem 'credential_missing' (job permission)", cats.includes("credential_missing"));
  check("exceções incluem 'integration_failed' (confirmation timed_out)", cats.includes("integration_failed"));

  // ===== 9. Ordem por severidade — credential_missing vem primeiro =====
  check("ordem: credential_missing vem antes de sla_at_risk", exc.findIndex(e => e.category === "credential_missing") < exc.findIndex(e => e.category === "sla_at_risk"));
  check("ordem: sla_at_risk vem antes de integration_failed", exc.findIndex(e => e.category === "sla_at_risk") < exc.findIndex(e => e.category === "integration_failed"));

  // ===== 10. Cada exceção tem evidence + recommendedAction =====
  check("toda exceção tem 'evidence' + 'recommendedAction'", exc.every(e => !!e.recommendedAction && e.evidence != null));

  // ===== 11. count() agrega por categoria =====
  const cnt = RuntimeExceptionsService.count(orgA);
  check("count.total = 4", cnt.total === 4);
  check("count.byCategory tem credential_missing=1", cnt.byCategory.credential_missing === 1);
  check("count.byCategory tem sla_at_risk=1", cnt.byCategory.sla_at_risk === 1);

  // ===== 12. overview() agrega running/completed hoje/exceções =====
  const ov = RuntimeExceptionsService.overview(orgA);
  check("overview.running.processes > 0 (temos 1 escalated) — mas escalado NÃO conta em running", ov.running.processes === 0);
  // Cria 1 processo em execução pra verificar
  const inst2 = ProcessRuntimeService.startForSubject(orgA, { processType: "retail_closing", subjectType: "loja", subjectId: "l2" });
  const ov2 = RuntimeExceptionsService.overview(orgA);
  check("overview.running.processes agora tem 1 (novo instance 'detected')", ov2.running.processes === 1);
  void inst2;
  // Completa uma ação HOJE (o outcome do a1 já foi criado; forço completed_at pra hoje)
  db.prepare(`UPDATE decision_actions SET status = 'done', completed_at = CURRENT_TIMESTAMP WHERE id = ?`).run(a1.id);
  const ov3 = RuntimeExceptionsService.overview(orgA);
  check("overview.completedToday.actions >= 1", ov3.completedToday.actions >= 1);
  check("overview.completedToday.outcomes.timeSavedMinutes = 75", ov3.completedToday.outcomes.timeSavedMinutes === 75);
  check("overview.completedToday.outcomes.revenueRecovered = 950", ov3.completedToday.outcomes.revenueRecovered === 950);
  check("overview.exceptionsCount = 4", ov3.exceptionsCount === 4);
  check("overview.slaBreached = 1 (só o overdue)", ov3.slaBreached === 1);

  // ===== 13. indicators() com contadores por status =====
  const ind = RuntimeExceptionsService.indicators(orgA);
  check("indicators tem processesEscalated = 1", ind.processesEscalated === 1);
  check("indicators tem confirmationsTimedOut = 1", ind.confirmationsTimedOut === 1);
  check("indicators tem jobsFailed = 1", ind.jobsFailed === 1);

  // ===== 14. Isolamento multi-tenant — orgB não vê exceções da orgA =====
  const excB = RuntimeExceptionsService.list(orgB);
  check("orgB não vê exceções de orgA", excB.length === 0);
  const ovB = RuntimeExceptionsService.overview(orgB);
  check("overview de orgB é zerado", ovB.running.processes === 0 && ovB.exceptionsCount === 0);

  // ===== 15. Ledger isolado por org =====
  const ledB = OutcomeMeasurementService.ledger(orgB);
  check("ledger de orgB é zerado", ledB.items.length === 0 && ledB.totals.count === 0);

  // ===== Resultado =====
  console.log("\n=== ADR-152 Fatia 3.1 (Outcomes estendidos + RuntimeExceptionsService) ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks OK`);
  if (failures > 0) process.exit(1);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
