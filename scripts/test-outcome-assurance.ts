/**
 * TEST — OutcomeAssuranceService: garantia de ciclo fechado read-only (PRD 8 / ADR-165 F1).
 * DB-backed, det. Prova (§13, RN-OA-1..3):
 *   - ação inexistente → unknown;
 *   - escada de estados: planned → executed → effect_confirmed → impact_measured → assured;
 *   - RN-OA-1: done SEM outcome → gap done_without_outcome (nunca "assured");
 *   - RN-OA-2: outcome ausente é unknown/pending, não zero/falha;
 *   - business outcome fica resolver_pending (F3), nunca inferido de "done";
 *   - confirmação pending/timed_out viram gap;
 *   - assessCorrelation.overall = pior estado do fio;
 *   - RN-OA-3: nada é escrito (read-only) — a FSM não muda;
 *   - isolamento multi-tenant.
 *
 * Uso: npm run test:outcome-assurance
 */
import os from "os"; import path from "path"; import fs from "fs";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-oa-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-oa-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const dbMod = await import("../src/server/db.js");
  const db = dbMod.default as any;
  const { OutcomeAssuranceService: OA } = await import("../src/server/OutcomeAssuranceService.js");
  const ORG = "org-1", OTHER = "org-2";

  const mkAction = (id: string, status: string, cid: string | null, org = ORG, executedAt: string | null = null) =>
    db.prepare("INSERT INTO decision_actions (id, organization_id, domain, action_type, title, status, correlation_id, executed_at) VALUES (?,?,?,?,?,?,?,?)")
      .run(id, org, "collection", "send_reminder", "Cobrar", status, cid, executedAt);
  const mkExec = (id: string, actionId: string, status: string, org = ORG) =>
    db.prepare("INSERT INTO action_execution_log (id, organization_id, action_id, handler, status) VALUES (?,?,?,?,?)").run(id, org, actionId, "asaas", status);
  const mkConf = (id: string, actionId: string, status: string, org = ORG) =>
    db.prepare("INSERT INTO action_confirmations (id, organization_id, action_id, confirmation_method, status) VALUES (?,?,?,?,?)").run(id, org, actionId, "asaas_payment_webhook", status);
  const mkOut = (id: string, actionId: string, basis = "fact", org = ORG) =>
    db.prepare("INSERT INTO action_outcomes (id, organization_id, action_id, measurement_method, basis, realized_value) VALUES (?,?,?,?,?,?)").run(id, org, actionId, "derived", basis, 100);

  // ═══════════════ 1. inexistente → unknown ═══════════════
  check("1.1 ação inexistente → not found + unknown", OA.assessAction(ORG, "nope").found === false && OA.assessAction(ORG, "nope").assuranceState === "unknown");

  // ═══════════════ 2. planned (proposta, sem exec) ═══════════════
  mkAction("a-plan", "proposed", "c1");
  check("2.1 proposta → planned", OA.assessAction(ORG, "a-plan").assuranceState === "planned");

  // ═══════════════ 3. executed sem confirmação nem outcome (done) — RN-OA-1 ═══════════════
  mkAction("a-exec", "done", "c2");
  const rExec = OA.assessAction(ORG, "a-exec");
  check("3.1 done sem outcome → executed (NÃO assured)", rExec.assuranceState === "executed");
  check("3.2 RN-OA-1: gap done_without_outcome + isDoneWithoutOutcome", rExec.gaps.includes("done_without_outcome") && rExec.isDoneWithoutOutcome === true);
  check("3.3 gap done_without_confirmation_record", rExec.gaps.includes("done_without_confirmation_record"));
  check("3.4 business outcome fica resolver_pending (não inferido de done)", rExec.stages.businessOutcomeConfirmed.reached === "unknown" && rExec.stages.businessOutcomeConfirmed.reason === "resolver_pending");

  // ═══════════════ 4. effect_confirmed (confirmação confirmada, sem outcome) ═══════════════
  mkAction("a-conf", "done", "c3"); mkConf("cf-1", "a-conf", "confirmed");
  const rConf = OA.assessAction(ORG, "a-conf");
  check("4.1 confirmação confirmed + sem outcome → effect_confirmed", rConf.assuranceState === "effect_confirmed");
  check("4.2 ainda tem gap done_without_outcome (confirmou efeito, não mediu)", rConf.gaps.includes("done_without_outcome"));

  // ═══════════════ 5. impact_measured (outcome, sem confirmação) ═══════════════
  mkAction("a-meas", "done", "c4"); mkOut("o-1", "a-meas", "fact");
  const rMeas = OA.assessAction(ORG, "a-meas");
  check("5.1 outcome sem confirmação → impact_measured", rMeas.assuranceState === "impact_measured");
  check("5.2 sem gap done_without_outcome (foi medido)", !rMeas.gaps.includes("done_without_outcome"));

  // ═══════════════ 6. assured (confirmado E medido) ═══════════════
  mkAction("a-ok", "done", "c5"); mkConf("cf-2", "a-ok", "confirmed"); mkOut("o-2", "a-ok", "fact");
  const rOk = OA.assessAction(ORG, "a-ok");
  check("6.1 confirmado E medido → assured", rOk.assuranceState === "assured");
  check("6.2 assured não tem gaps de medição/confirmação", rOk.gaps.length === 0);

  // ═══════════════ 7. confirmação pending/timed_out → gap ═══════════════
  mkAction("a-pend", "approved", "c6"); mkConf("cf-3", "a-pend", "pending");
  check("7.1 confirmação pending → gap confirmation_pending", OA.assessAction(ORG, "a-pend").gaps.includes("confirmation_pending"));
  mkAction("a-to", "approved", "c7"); mkConf("cf-4", "a-to", "timed_out");
  check("7.2 confirmação timed_out → gap confirmation_timed_out", OA.assessAction(ORG, "a-to").gaps.includes("confirmation_timed_out"));

  // ═══════════════ 8. assessCorrelation.overall = pior estado do fio ═══════════════
  // c-multi: uma ação assured + uma só executed → overall executed (pior)
  mkAction("m-1", "done", "c-multi"); mkConf("cf-5", "m-1", "confirmed"); mkOut("o-3", "m-1", "fact");
  mkAction("m-2", "done", "c-multi"); // executed, sem confirmação/outcome
  const corr = OA.assessCorrelation(ORG, "c-multi");
  check("8.1 correlação com 2 ações", corr.actionCount === 2);
  check("8.2 overall = pior estado (executed, não assured)", corr.overall === "executed");
  check("8.3 hasDoneWithoutOutcome true (a m-2 tem o gap)", corr.hasDoneWithoutOutcome === true);

  // ═══════════════ 9. RN-OA-3: read-only (nada foi escrito) ═══════════════
  const before = db.prepare("SELECT COUNT(*) c FROM action_outcomes").get().c;
  OA.assessAction(ORG, "a-exec"); OA.assessCorrelation(ORG, "c-multi");
  const after = db.prepare("SELECT COUNT(*) c FROM action_outcomes").get().c;
  const statusUnchanged = db.prepare("SELECT status FROM decision_actions WHERE id='a-exec'").get().status;
  check("9.1 assess não escreve outcome (read-only)", before === after);
  check("9.2 assess não muda a FSM (status intacto)", statusUnchanged === "done");

  // ═══════════════ 10. isolamento multi-tenant ═══════════════
  check("10.1 outra org não vê a ação do org-1", OA.assessAction(OTHER, "a-ok").found === false);
  mkAction("b-ok", "done", "c5", OTHER); // ação da outra org, sem conf/outcome (conf/outcome do org-1 não vazam)
  check("10.2 ação isolada da outra org → executed (conf/outcome do org-1 não contam)", OA.assessAction(OTHER, "b-ok").assuranceState === "executed");

  // ═══════════════ 11. worstState puro ═══════════════
  check("11.1 worstState escolhe o menor da escada", OA.worstState(["assured", "planned", "impact_measured"]) === "planned");
  check("11.2 worstState vazio → unknown", OA.worstState([]) === "unknown");

  // ── relatório ──
  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} outcome-assurance: ${passed}/${results.length} checks`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
