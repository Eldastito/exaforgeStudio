/**
 * TEST — LearningEpisodeService (PRD 9 / ADR-166 F3). DB-backed, determinístico.
 *
 * Prova (§9, D5, RN-EL-1/2/3/5/7):
 *   - episode amarra padrão + prova (misto × assured) + desfechos + estado derivado;
 *   - sem prova assegurada → learningState 'unproven' (DONE ≠ exemplo, null ≠ zero);
 *   - assured alto → 'reinforced'; assured baixo → 'weakened';
 *   - backfired domina os assured → suggestedRefutation (evidência, não escreve status);
 *   - read-only: não altera business_patterns.status;
 *   - episodes lista + onlyAssured filtra; isolamento multi-tenant.
 *
 * Uso: npm run test:learning-episode
 */
import os from "os"; import path from "path"; import fs from "fs";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-lep-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-lep-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const dbMod = await import("../src/server/db.js");
  const db = dbMod.default as any;
  const { PatternMemoryService: PM } = await import("../src/server/PatternMemoryService.js");
  const { LearningEpisodeService: LEP } = await import("../src/server/LearningEpisodeService.js");
  const ORG = "org-1", OTHER = "org-2";

  const mkPattern = (id: string, type: string, org = ORG, status = "validated") =>
    db.prepare("INSERT INTO business_patterns (id, organization_id, domain, pattern_type, pattern_key, description, confidence, status, occurrences) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(id, org, "procurement", type, id + "-k", "padrão " + id, 0.5, status, 3);
  const asr = (org: string, pid: string, outcome: string, key: string, impact = 0) =>
    PM.recordOutcome(org, pid, { outcome, realizedImpact: impact, eventKey: key, source: "assured" });

  // ═══════════════ 1. sem prova assegurada → unproven ═══════════════
  mkPattern("p-un", "t_un");
  PM.recordOutcome(ORG, "p-un", { outcome: "worked", eventKey: "man-1" }); // manual, não assured
  const eUn = LEP.episode(ORG, "p-un");
  check("1.1 found + pattern", eUn.found === true && eUn.pattern.id === "p-un");
  check("1.2 sem assured → unproven", eUn.derived.learningState === "unproven" && eUn.learning.hasAssuredEvidence === false);
  check("1.3 assuredEffectiveness null (não 0)", eUn.learning.assured.assuredEffectiveness === null);
  check("1.4 misto ainda visível (1 worked)", eUn.learning.mixed.acted === 1 && eUn.learning.mixed.effectiveness === 1);

  // ═══════════════ 2. assured alto → reinforced ═══════════════
  mkPattern("p-re", "t_re");
  asr(ORG, "p-re", "worked", "re-1", 100); asr(ORG, "p-re", "worked", "re-2", 200);
  const eRe = LEP.episode(ORG, "p-re");
  check("2.1 assured worked → reinforced", eRe.derived.learningState === "reinforced" && eRe.derived.suggestedRefutation === false);
  check("2.2 assuredEffectiveness 1.0", eRe.learning.assured.assuredEffectiveness === 1);
  check("2.3 outcomes listados (2, source assured)", eRe.outcomes.length === 2 && eRe.outcomes.every((o: any) => o.source === "assured"));

  // ═══════════════ 3. assured baixo + backfired domina → weakened + suggestedRefutation ═══════════════
  mkPattern("p-wk", "t_wk");
  asr(ORG, "p-wk", "backfired", "wk-1", -50); asr(ORG, "p-wk", "backfired", "wk-2", -30); asr(ORG, "p-wk", "worked", "wk-3", 10);
  const eWk = LEP.episode(ORG, "p-wk");
  // assured: worked=1, backfired=2 → (1)/3 = 0.33 → weakened
  check("3.1 assured baixo → weakened", eWk.derived.learningState === "weakened");
  check("3.2 backfired domina → suggestedRefutation true", eWk.derived.suggestedRefutation === true);
  check("3.3 rationale menciona contradição", /contradiz|refuta/i.test(eWk.derived.rationale));

  // ═══════════════ 4. read-only: não muda o status do padrão ═══════════════
  const stAfter = (db.prepare("SELECT status FROM business_patterns WHERE id='p-wk'").get() as any).status;
  check("4.1 status do padrão intacto (validated, não refuted)", stAfter === "validated");

  // ═══════════════ 5. episodes lista + onlyAssured ═══════════════
  const all = LEP.episodes(ORG, {});
  check("5.1 lista inclui todos (>=3)", all.count >= 3);
  const onlyA = LEP.episodes(ORG, { onlyAssured: true });
  check("5.2 onlyAssured exclui o unproven", onlyA.episodes.every((e: any) => e.assuredActed > 0) && !onlyA.episodes.some((e: any) => e.patternId === "p-un"));
  check("5.3 ordena suggestedRefutation primeiro", onlyA.episodes[0].patternId === "p-wk");

  // ═══════════════ 6. isolamento multi-tenant ═══════════════
  mkPattern("p-o", "t_re", OTHER);
  asr(OTHER, "p-o", "worked", "o-1", 5);
  check("6.1 org-1 não enxerga episódio da outra org", LEP.episode(ORG, "p-o").found === false);
  check("6.2 OTHER isolado", LEP.episode(OTHER, "p-o").found === true && LEP.episodes(OTHER, {}).count === 1);

  // ═══════════════ 7. padrão inexistente ═══════════════
  check("7.1 padrão ausente → found false", LEP.episode(ORG, "ghost").found === false);

  // ── relatório ──
  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} learning-episode: ${passed}/${results.length} checks`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
