/**
 * TEST — LearningMetricsService (PRD 9 / ADR-166 F13). DB-backed, determinístico.
 *
 * Prova (§9, RN-004, RN-EL-5):
 *   - inventário por status + procedência (manual×assured) derivados por query;
 *   - cobertura assegurada = validated com prova / validated;
 *   - estados de aprendizado (unproven/reinforced/weakened/contested);
 *   - percentuais null sem denominador (não inventa 0%);
 *   - drift (dormência) reportado; isolamento multi-tenant.
 *
 * Uso: npm run test:learning-metrics
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-lm-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-lm-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const dbMod = await import("../src/server/db.js");
  const db = dbMod.default as any;
  const { PatternMemoryService: PM } = await import("../src/server/PatternMemoryService.js");
  const { LearningMetricsService: LM } = await import("../src/server/LearningMetricsService.js");
  const ORG = "org-1", OTHER = "org-2";

  const mkPattern = (org: string, id: string, type: string, status = "validated") =>
    db.prepare("INSERT INTO business_patterns (id, organization_id, domain, pattern_type, pattern_key, description, confidence, status, occurrences) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(id, org, "procurement", type, id + "-k", "p", 0.6, status, 3);
  const asr = (org: string, pid: string, outcome: string, key: string) => PM.recordOutcome(org, pid, { outcome, eventKey: key, source: "assured" });

  // ═══════════════ 1. org vazio → percentuais null (RN-EL-5) ═══════════════
  const m0 = LM.metrics(ORG);
  check("1.1 sem padrões → patterns 0", m0.patterns === 0);
  check("1.2 cobertura assegurada null sem validated", m0.learning.assuredCoveragePct === null && m0.learning.avgAssuredEffectiveness === null);

  // ═══════════════ 2. inventário + procedência ═══════════════
  mkPattern(ORG, "p-reinf", "t_reinf");            // vai ser reinforced (2 worked assured)
  asr(ORG, "p-reinf", "worked", "r1"); asr(ORG, "p-reinf", "worked", "r2");
  mkPattern(ORG, "p-weak", "t_weak");              // weakened (2 backfired assured)
  asr(ORG, "p-weak", "backfired", "w1"); asr(ORG, "p-weak", "backfired", "w2");
  mkPattern(ORG, "p-unpr", "t_unpr");              // unproven (só manual)
  PM.recordOutcome(ORG, "p-unpr", { outcome: "worked" });
  mkPattern(ORG, "p-dorm", "t_dorm", "dormant");   // dormante (drift)

  const m = LM.metrics(ORG);
  check("2.1 inventário: 3 validated + 1 dormant", m.byStatus.validated === 3 && m.byStatus.dormant === 1 && m.patterns === 4);
  check("2.2 procedência: assured=4, manual=1", m.outcomes.assured === 4 && m.outcomes.manual === 1 && m.outcomes.total === 5);
  check("2.3 assuredSharePct = 80", m.outcomes.assuredSharePct === 80);

  // ═══════════════ 3. cobertura assegurada + estados ═══════════════
  // validated: reinf, weak, unpr = 3; com prova assegurada: reinf, weak = 2 → 66.7%
  check("3.1 cobertura assegurada 2/3 = 66.7", m.learning.validatedTypes === 3 && m.learning.withAssuredEvidence === 2 && m.learning.assuredCoveragePct === 66.7);
  check("3.2 estados: 1 reinforced, 1 weakened, 1 unproven", m.learning.states.reinforced === 1 && m.learning.states.weakened === 1 && m.learning.states.unproven === 1);
  check("3.3 avgAssuredEffectiveness (1.0 e 0.0 → 0.5)", m.learning.avgAssuredEffectiveness === 0.5);
  check("3.4 refutação sugerida contada (weak backfired domina)", m.learning.suggestedRefutations === 1);

  // ═══════════════ 4. drift ═══════════════
  check("4.1 dormant reportado + pct", m.drift.dormant === 1 && m.drift.dormantPct === 25);

  // ═══════════════ 5. isolamento multi-tenant ═══════════════
  mkPattern(OTHER, "p-o", "t_reinf"); asr(OTHER, "p-o", "worked", "o1");
  check("5.1 OTHER isolado", LM.metrics(OTHER).patterns === 1 && LM.metrics(ORG).patterns === 4);

  // ── relatório ──
  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} learning-metrics: ${passed}/${results.length} checks`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
