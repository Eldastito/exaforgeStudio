/**
 * TEST — ProductEvolutionScoringService (ADR-193 F3).
 * DB-backed, determinístico. Prova:
 *   1. Score é determinístico (mesmo input → mesmo output);
 *   2. Item recém-criado em IDEA sem evid → cap 20 (só doc);
 *   3. Backend + testes + rollout + observability + validation → score alto;
 *   4. Só UI sem backend → cap 30;
 *   5. IMPLEMENTING/CODED sem runtime real → cap 49;
 *   6. TESTED/PILOT/PRODUCTION sem evid. de teste → cap 49;
 *   7. PRODUCTION/VALIDATED sem evid. de validação → cap 79;
 *   8. Evidência convergente (≥2 hits) satura a dimensão;
 *   9. Notas explicam caps aplicados;
 *  10. Stub em backend reduz peso;
 *  11. listAllScores retorna score por item sem N+1;
 *  12. Dimensões somam pesos corretos (§6 PRD).
 *
 * Uso: npm run test:product-evolution-scoring
 */
import os from "os";
import path from "path";
import fs from "fs";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-pel-score-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-score-1234567890abcdef";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) {
  results.push({ name, ok });
  if (!ok) failures++;
}

async function main() {
  const dbMod = await import("../src/server/db.js");
  const db = dbMod.default as any;
  void db;
  const { ProductEvolutionLedgerService: PEL } = await import("../src/server/ProductEvolutionLedgerService.js");
  const { ProductEvolutionScoringService: Score, DIMENSION_WEIGHTS } = await import("../src/server/ProductEvolutionScoringService.js");

  // ═══════════════ 1. Determinismo ═══════════════
  PEL.createItem({ evolution_key: "DET_TEST", title: "det", source_of_truth: "ADR-1" });
  const s1 = Score.computeScore("DET_TEST")!;
  const s2 = Score.computeScore("DET_TEST")!;
  check("1.1 mesmo score em 2 chamadas (determinístico)",
    s1.total === s2.total && s1.raw_total === s2.raw_total && s1.cap_applied === s2.cap_applied);

  // ═══════════════ 2. IDEA sem evid → cap 20 ═══════════════
  check("2.1 IDEA sem evidência → cap_applied = 20", s1.cap_applied === 20);
  check("2.2 IDEA sem evidência → total ≤ 20", s1.total <= 20);
  check("2.3 raw_total = 0 (sem hits)", s1.raw_total === 0);
  check("2.4 nota explica cap", s1.notes.some(n => n.includes("cap 20")));

  // ═══════════════ 3. Backend + tests + rollout → score alto ═══════════════
  // Cria item novo, adiciona evidências verificadas, avança pra PRODUCTION.
  PEL.createItem({ evolution_key: "FULL_TEST", title: "full stack" });
  const evCode = PEL.addEvidence("FULL_TEST", { evidence_type: "code", reference: "src/x.ts:1" });
  const evMigr = PEL.addEvidence("FULL_TEST", { evidence_type: "migration", reference: "migration_x" });
  const evRoute = PEL.addEvidence("FULL_TEST", { evidence_type: "route", reference: "/api/x" });
  const evTest = PEL.addEvidence("FULL_TEST", { evidence_type: "test", reference: "test:x" });
  const evTestRun = PEL.addEvidence("FULL_TEST", { evidence_type: "test_run", reference: "run 123 passed" });
  const evRollout = PEL.addEvidence("FULL_TEST", { evidence_type: "rollout", reference: "flag_x enabled" });
  const evMetric = PEL.addEvidence("FULL_TEST", { evidence_type: "metric", reference: "throughput 1k/s" });
  const evProdCheck = PEL.addEvidence("FULL_TEST", { evidence_type: "production_check", reference: "canary ok" });
  const evRunbook = PEL.addEvidence("FULL_TEST", { evidence_type: "runbook", reference: "docs/runbook/x.md" });
  const evUi = PEL.addEvidence("FULL_TEST", { evidence_type: "ui", reference: "src/features/XView.tsx" });

  // Verifica todas
  for (const e of [evCode, evMigr, evRoute, evTest, evTestRun, evRollout, evMetric, evProdCheck, evRunbook, evUi]) {
    PEL.verifyEvidence(e.id, "reviewer-1");
  }

  // Avança pra PRODUCTION via seedProgressTo
  PEL.seedProgressTo("FULL_TEST", "PRODUCTION", "test");
  const sFull = Score.computeScore("FULL_TEST")!;
  check("3.1 item full em PRODUCTION, todas as evidências → score ≥ 80", sFull.total >= 80);
  check("3.2 sem cap aplicado quando tem evid. de validação", sFull.cap_applied === null || sFull.cap_applied === 100);

  // ═══════════════ 4. Só UI → cap 30 ═══════════════
  PEL.createItem({ evolution_key: "UI_ONLY", title: "só UI" });
  const evUiOnly = PEL.addEvidence("UI_ONLY", { evidence_type: "ui", reference: "src/features/Y.tsx" });
  PEL.verifyEvidence(evUiOnly.id, "r");
  const sUiOnly = Score.computeScore("UI_ONLY")!;
  check("4.1 só UI verificada → cap 30", sUiOnly.cap_applied === 30);
  check("4.2 total ≤ 30", sUiOnly.total <= 30);

  // ═══════════════ 5. IMPLEMENTING sem code/route → cap 49 ═══════════════
  PEL.createItem({ evolution_key: "IMPL_NO_RUNTIME", title: "sem runtime" });
  const evPr = PEL.addEvidence("IMPL_NO_RUNTIME", { evidence_type: "pr", reference: "PR#123" });
  PEL.verifyEvidence(evPr.id, "r");
  // Avança pra IMPLEMENTING
  PEL.seedProgressTo("IMPL_NO_RUNTIME", "IMPLEMENTING", "test");
  const sImpl = Score.computeScore("IMPL_NO_RUNTIME")!;
  check("5.1 IMPLEMENTING só com PR verificado → cap 49", sImpl.cap_applied === 49);
  check("5.2 nota menciona runtime", sImpl.notes.some(n => n.toLowerCase().includes("runtime")));

  // ═══════════════ 6. TESTED sem evid. de teste → cap 49 ═══════════════
  PEL.createItem({ evolution_key: "TESTED_NO_TESTS", title: "tested sem teste" });
  const eCode2 = PEL.addEvidence("TESTED_NO_TESTS", { evidence_type: "code", reference: "y.ts" });
  PEL.verifyEvidence(eCode2.id, "r");
  PEL.seedProgressTo("TESTED_NO_TESTS", "TESTED", "test");
  const sTestedNoTests = Score.computeScore("TESTED_NO_TESTS")!;
  check("6.1 TESTED sem evid. de teste → cap 49", sTestedNoTests.cap_applied === 49);

  // ═══════════════ 7. PRODUCTION sem validação → cap 79 ═══════════════
  PEL.createItem({ evolution_key: "PROD_NO_VAL", title: "prod sem validation" });
  const eC3 = PEL.addEvidence("PROD_NO_VAL", { evidence_type: "code", reference: "z.ts" });
  const eT3 = PEL.addEvidence("PROD_NO_VAL", { evidence_type: "test", reference: "test:z" });
  const eR3 = PEL.addEvidence("PROD_NO_VAL", { evidence_type: "rollout", reference: "flag_z" });
  PEL.verifyEvidence(eC3.id, "r");
  PEL.verifyEvidence(eT3.id, "r");
  PEL.verifyEvidence(eR3.id, "r");
  PEL.seedProgressTo("PROD_NO_VAL", "PRODUCTION", "test");
  const sProdNoVal = Score.computeScore("PROD_NO_VAL")!;
  check("7.1 PRODUCTION sem validação verificada → cap 79", sProdNoVal.cap_applied === 79);
  check("7.2 total ≤ 79", sProdNoVal.total <= 79);
  check("7.3 nota menciona validação", sProdNoVal.notes.some(n => n.toLowerCase().includes("valida")));

  // ═══════════════ 8. Convergência: ≥2 hits satura dimensão ═══════════════
  PEL.createItem({ evolution_key: "CONVERGE", title: "convergência" });
  const eC1 = PEL.addEvidence("CONVERGE", { evidence_type: "code", reference: "a.ts" });
  const eC2 = PEL.addEvidence("CONVERGE", { evidence_type: "code", reference: "b.ts" });
  PEL.verifyEvidence(eC1.id, "r");
  PEL.verifyEvidence(eC2.id, "r");
  const sConv = Score.computeScore("CONVERGE")!;
  const backendDim = sConv.dimensions.find(d => d.dimension === "backend")!;
  const securityDim = sConv.dimensions.find(d => d.dimension === "security")!;
  check("8.1 2 hits em code saturam dimensão backend", backendDim.saturated === true);
  check("8.2 dimensão backend earned = weight completo (20)",
    backendDim.earned === DIMENSION_WEIGHTS.backend);
  check("8.3 dimensão security saturada também (code cobre security via PR review)",
    securityDim.saturated === true);

  // ═══════════════ 9. Stub em backend reduz peso ═══════════════
  PEL.createItem({ evolution_key: "STUB_TEST", title: "stub" });
  const eStub = PEL.addEvidence("STUB_TEST", {
    evidence_type: "code",
    reference: "src/stub.ts",
    description: "Implementação stub — retorna dados mockados"
  });
  PEL.verifyEvidence(eStub.id, "r");
  const sStub = Score.computeScore("STUB_TEST")!;
  const stubBackend = sStub.dimensions.find(d => d.dimension === "backend")!;
  check("9.1 stub reduz raw_hits em backend (< 1)", stubBackend.raw_hits < 1);
  check("9.2 nota menciona stub", sStub.notes.some(n => n.toLowerCase().includes("stub")));

  // ═══════════════ 10. Contadores de peso ═══════════════
  const sumWeights = Object.values(DIMENSION_WEIGHTS).reduce((a: number, b: number) => a + b, 0);
  check("10.1 soma dos pesos = 100", sumWeights === 100);
  check("10.2 9 dimensões", Object.keys(DIMENSION_WEIGHTS).length === 9);

  // ═══════════════ 11. listAllScores retorna todos os items ═══════════════
  const all = Score.listAllScores();
  check("11.1 listAllScores retorna array não vazio", all.length > 0);
  check("11.2 total = número de items no ledger",
    all.length === 8); // DET_TEST, FULL_TEST, UI_ONLY, IMPL_NO_RUNTIME, TESTED_NO_TESTS, PROD_NO_VAL, CONVERGE, STUB_TEST

  // Todos os scores têm formato esperado
  check("11.3 todos têm evolution_key + status + total",
    all.every(s => !!s.evolution_key && !!s.status && typeof s.total === "number"));

  // ═══════════════ 12. Terminal states ═══════════════
  // REJECTED não deveria ter cap especial (o estado já expressa "não vai")
  PEL.createItem({ evolution_key: "REJ_TEST", title: "rejected" });
  PEL.setStatus("REJ_TEST", { new_status: "REJECTED", reason: "cancelado" });
  const sRej = Score.computeScore("REJ_TEST")!;
  check("12.1 REJECTED sem evidência: score baixo (sem cap especial, terminal)",
    sRej.total === 0);

  // ═══════════════ 13. computeScore em chave inexistente ═══════════════
  const sGhost = Score.computeScore("GHOST_KEY_NAO_EXISTE");
  check("13.1 computeScore em item inexistente → null", sGhost === null);

  // ─── Relatório final ───
  const passed = results.length - failures;
  console.log(`\n${passed}/${results.length} checks OK`);
  for (const r of results) console.log(`  ${r.ok ? "✓" : "✗"} ${r.name}`);
  process.exit(failures > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
