/**
 * TEST — PRD 4 F11 (Evals + Shadow): harness de eval DETERMINÍSTICO + gate de
 * regressão + shadow (candidata×atual, sem efeito). DB-backed, isolado por tmpDir.
 * Determinístico (roda sem chave de IA). Prova:
 *
 *   - scorers puros (exact/json_subset/field_equals/grounded/non_empty/predicate) +
 *     isJsonSubset/readPath/aggregateEval/detectRegression;
 *   - registerCase valida (scorer/expected/fieldPath) e é upsert idempotente;
 *   - run() pontua casos com recordedOutput (replay), persiste, seta regressed vs
 *     baseline; segunda rodada com caso quebrado → regressed=true;
 *   - shadow() difa candidata×atual via invoke, SEM efeito, sem virar baseline;
 *   - runAll() só roda skills com caso determinístico (recordedOutput).
 *
 * Uso: npm run test:skillos-evals
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-skillos-ev-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-skillos-ev-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }
const approx = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps;
const throws = (fn: () => any) => { try { fn(); return false; } catch { return true; } };

async function main() {
  await import("../src/server/db.js");
  const M = await import("../src/server/skillosModel.js");
  const { SkillOsEvalService: EV } = await import("../src/server/SkillOsEvalService.js");

  // ═══════════════ 1. scorers puros (skillosModel) ═══════════════
  const mk = (scorer: any, extra: any = {}) => ({ caseId: "c", skillId: "s", name: "n", scorer, ...extra });
  check("1.1 exact pass", M.scoreEvalCase(mk("exact", { expected: { a: 1 } }), { a: 1 }).passed);
  check("1.2 exact fail", !M.scoreEvalCase(mk("exact", { expected: { a: 1 } }), { a: 2 }).passed);
  check("1.3 json_subset pass (extra no candidato)", M.scoreEvalCase(mk("json_subset", { expected: { a: 1 } }), { a: 1, b: 2 }).passed);
  check("1.4 json_subset fail", !M.scoreEvalCase(mk("json_subset", { expected: { a: 1 } }), { a: 9 }).passed);
  check("1.5 field_equals pass", M.scoreEvalCase(mk("field_equals", { fieldPath: "x.y", expected: 7 }), { x: { y: 7 } }).passed);
  check("1.6 field_equals fail c/ detail", (() => { const s = M.scoreEvalCase(mk("field_equals", { fieldPath: "x.y", expected: 7 }), { x: { y: 8 } }); return !s.passed && !!s.detail; })());
  check("1.7 grounded pass (grounding_status)", M.scoreEvalCase(mk("grounded"), { grounding_status: "grounded" }).passed);
  check("1.8 grounded fail (unsupported)", !M.scoreEvalCase(mk("grounded"), { grounding_status: "unsupported" }).passed);
  check("1.9 non_empty: [] falha, [x] passa", !M.scoreEvalCase(mk("non_empty"), []).passed && M.scoreEvalCase(mk("non_empty"), [1]).passed);
  check("1.10 predicate usa a função", M.scoreEvalCase(mk("predicate"), { x: 10 }, (cand: any) => cand.x > 5).passed && !M.scoreEvalCase(mk("predicate"), { x: 1 }, (cand: any) => cand.x > 5).passed);
  check("1.11 sem candidato → falha", !M.scoreEvalCase(mk("exact", { expected: 1 }), undefined).passed);
  check("1.12 isJsonSubset arrays por índice", M.isJsonSubset([1, 2], [1, 2]) && !M.isJsonSubset([1, 2], [1, 3]) && !M.isJsonSubset([1], [1, 2]));
  check("1.13 readPath", M.readPath({ a: { b: 5 } }, "a.b") === 5 && M.readPath({ a: 1 }, "a.z.y") === undefined);

  // aggregate + regressão puras
  const scores = [
    { caseId: "a", scorer: "exact", passed: true, score: 1, weight: 1, detail: null },
    { caseId: "b", scorer: "exact", passed: false, score: 0, weight: 3, detail: "x" },
  ] as any[];
  const agg = M.aggregateEval("s", "v1", scores);
  check("1.14 aggregate ponderado (1/(1+3)=0.25)", agg.total === 2 && agg.passed === 1 && approx(agg.passRate, 0.25));
  check("1.15 detectRegression: sem baseline → false", M.detectRegression(agg, null) === false);
  check("1.16 regressão por passRate cair", M.detectRegression({ ...agg, passRate: 0.5 } as any, { passRate: 0.9, passedCaseIds: [] }) === true);
  check("1.17 regressão por caso que passava falhar (passRate igual)", M.detectRegression(
    { passRate: 0.5, scores: [{ caseId: "a", passed: false }, { caseId: "b", passed: true }] } as any,
    { passRate: 0.5, passedCaseIds: ["a"] }) === true);

  // ═══════════════ 2. registerCase validação + upsert ═══════════════
  check("2.1 scorer inválido lança", throws(() => EV.registerCase({ skillId: "s", name: "n", scorer: "nope" as any })));
  check("2.2 field_equals sem fieldPath lança", throws(() => EV.registerCase({ skillId: "s", name: "n", scorer: "field_equals", expected: 1 })));
  check("2.3 exact sem expected lança", throws(() => EV.registerCase({ skillId: "s", name: "n", scorer: "exact" })));

  const skill = "sk-classify";
  const c1 = EV.registerCase({ caseId: "c1", skillId: skill, name: "intent cobranca", scorer: "field_equals", fieldPath: "intent", expected: "cobranca", input: { text: "me manda o boleto" }, recordedOutput: { intent: "cobranca", confidence: 0.9 } });
  const c2 = EV.registerCase({ caseId: "c2", skillId: skill, name: "intent venda", scorer: "json_subset", expected: { intent: "venda" }, recordedOutput: { intent: "venda", extra: 1 } });
  const c3 = EV.registerCase({ caseId: "c3", skillId: skill, name: "grounded", scorer: "grounded", recordedOutput: { grounding_status: "grounded" } });
  check("2.4 registrou 3 casos ativos", EV.listCases(skill).length === 3 && c1.caseId === "c1");
  EV.registerCase({ caseId: "c1", skillId: skill, name: "intent cobranca v2", scorer: "field_equals", fieldPath: "intent", expected: "cobranca", input: { text: "x" }, recordedOutput: { intent: "cobranca" } });
  check("2.5 upsert idempotente (ainda 3 casos)", EV.listCases(skill).length === 3);

  // ═══════════════ 3. run() determinístico + baseline + regressão ═══════════════
  const r1 = await EV.run(skill);
  check("3.1 primeiro run: passRate 1.0, regressed false", r1.total === 3 && r1.passed === 3 && approx(r1.passRate, 1) && r1.regressed === false);
  // quebra c1 (recordedOutput não bate mais o expected).
  EV.registerCase({ caseId: "c1", skillId: skill, name: "intent cobranca", scorer: "field_equals", fieldPath: "intent", expected: "cobranca", input: { text: "x" }, recordedOutput: { intent: "outro" } });
  const r2 = await EV.run(skill);
  check("3.2 segundo run: passRate 2/3", r2.passed === 2 && approx(r2.passRate, 2 / 3));
  check("3.3 regressed=true (passRate caiu e c1 passava)", r2.regressed === true);
  check("3.4 lastRun reflete o run persistido", (() => { const l = EV.lastRun(skill); return l && l.pass_rate && Math.abs(l.pass_rate - 2 / 3) < 1e-9 && l.regressed === 1; })());

  // predicate via run com invoke ausente mas recordedOutput presente
  const skP = "sk-pred";
  EV.registerCase({ caseId: "p1", skillId: skP, name: "x>5", scorer: "predicate", recordedOutput: { x: 10 } });
  const rp = await EV.run(skP, { predicate: (cand: any) => cand.x > 5 });
  check("3.5 predicate no run passa", rp.passed === 1 && rp.regressed === false);

  // ═══════════════ 4. shadow (invoke, sem efeito, sem virar baseline) ═══════════════
  const skS = "sk-shadow";
  EV.registerCase({ caseId: "s1", skillId: skS, name: "n1", scorer: "field_equals", fieldPath: "ok", expected: true, input: { n: 1 } });
  EV.registerCase({ caseId: "s2", skillId: skS, name: "n2", scorer: "field_equals", fieldPath: "ok", expected: true, input: { n: 2 } });
  const current = async (_i: any) => ({ ok: true });
  const candidate = async (i: any) => (i.n === 2 ? { ok: false } : { ok: true });
  const sh = await EV.shadow(skS, current, candidate);
  check("4.1 atual passa tudo", approx(sh.current.passRate, 1));
  check("4.2 candidata regride s2", sh.candidate.passed === 1 && approx(sh.candidate.passRate, 0.5));
  check("4.3 diff aponta o caso regredido + delta", sh.diff.regressedCaseIds.includes("s2") && sh.diff.improvedCaseIds.length === 0 && approx(sh.diff.passRateDelta, -0.5));
  check("4.4 shadow NÃO cria baseline de eval (baselineFor null)", EV.baselineFor(skS) === null);
  check("4.5 shadow persistiu run mode='shadow'", (() => { const l = EV.lastRun(skS, "shadow"); return !!l && l.mode === "shadow"; })());

  // ═══════════════ 5. runAll só pega skills com recordedOutput ═══════════════
  const all = await EV.runAll();
  // sk-classify + sk-pred têm recordedOutput; sk-shadow NÃO (usa invoke).
  check("5.1 runAll ignora skill sem recordedOutput (sk-shadow fora)", all.skills === 2 && all.runs === 2);
  check("5.2 runAll conta a regressão de sk-classify", all.regressions >= 1);

  // ═══════════════ 6. setCaseStatus ═══════════════
  EV.setCaseStatus("c3", "disabled");
  check("6.1 caso desabilitado sai da suíte ativa", EV.listCases(skill).length === 2 && EV.listCases(skill, { includeDisabled: true }).length === 3);

  console.log("\n=== TEST: SkillOS Evals + Shadow (PRD 4 F11) ===\n");
  for (const rr of results) console.log(`${rr.ok ? "✅" : "❌"} ${rr.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ SkillOS Evals + Shadow (F11) OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
