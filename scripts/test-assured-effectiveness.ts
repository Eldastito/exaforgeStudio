/**
 * TEST — assuredEffectiveness (PRD 9 / ADR-166 F2). DB-backed, determinístico.
 *
 * Prova (§9/CA2, RN-EL-5/6):
 *   - assuredStats deriva do ledger só source='assured' (não mistura com manual);
 *   - sem desfecho assured → assuredEffectiveness NULL (não inventa 0 — DONE ≠ exemplo);
 *   - assuredEffectiveness = (worked + no_effect*0.5)/acted só sobre os assured;
 *   - effectiveness (typeStats) segue MISTO (manual+assured), separado do assured;
 *   - allEffectiveness anexa o recorte sem quebrar os campos originais;
 *   - isolamento multi-tenant.
 *
 * Uso: npm run test:assured-effectiveness
 */
import os from "os"; import path from "path"; import fs from "fs";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-aeff-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-aeff-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const dbMod = await import("../src/server/db.js");
  const db = dbMod.default as any;
  const { PatternMemoryService: PM } = await import("../src/server/PatternMemoryService.js");
  const ORG = "org-1", OTHER = "org-2";

  const mkPattern = (id: string, type: string, org = ORG) =>
    db.prepare("INSERT INTO business_patterns (id, organization_id, domain, pattern_type, pattern_key, description, confidence, status, occurrences) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(id, org, "procurement", type, id + "-k", "p " + id, 0.5, "validated", 3);

  // ═══════════════ 1. só manual → assuredEffectiveness NULL (RN-EL-5) ═══════════════
  mkPattern("p1", "t_manual");
  PM.recordOutcome(ORG, "p1", { outcome: "worked" });                       // manual
  PM.recordOutcome(ORG, "p1", { outcome: "worked", eventKey: "m2" });        // manual
  const s1 = PM.assuredStats(ORG, "procurement", "t_manual");
  check("1.1 sem assured → assuredEffectiveness null", s1.assuredEffectiveness === null && s1.assuredActed === 0);
  const mixed1 = PM.typeStats(ORG, "procurement", "t_manual");
  check("1.2 effectiveness misto conta os manuais (2 worked → 1.0)", mixed1!.effectiveness === 1 && mixed1!.acted === 2);

  // ═══════════════ 2. assured recortado do misto ═══════════════
  mkPattern("p2", "t_mix");
  PM.recordOutcome(ORG, "p2", { outcome: "backfired", eventKey: "man-b", source: "manual" });     // manual backfired
  PM.recordOutcome(ORG, "p2", { outcome: "worked", eventKey: "asr-w", source: "assured" });        // assured worked
  PM.recordOutcome(ORG, "p2", { outcome: "no_effect", eventKey: "asr-n", source: "assured" });      // assured no_effect
  const s2 = PM.assuredStats(ORG, "procurement", "t_mix");
  // assured: worked=1, no_effect=1 → (1 + 0.5)/2 = 0.75
  check("2.1 assuredEffectiveness só sobre os assured (0.75)", s2.assuredEffectiveness === 0.75 && s2.assuredActed === 2);
  check("2.2 assured não conta o backfired manual", s2.backfired === 0 && s2.worked === 1 && s2.no_effect === 1);
  const mixed2 = PM.typeStats(ORG, "procurement", "t_mix");
  // misto: worked=1, no_effect=1, backfired=1 → (1 + 0.5 + 0)/3 = 0.5
  check("2.3 effectiveness misto inclui o backfired manual (0.5)", mixed2!.effectiveness === 0.5 && mixed2!.acted === 3);
  check("2.4 assured ≠ misto (recorte separado, RN-EL-6)", s2.assuredEffectiveness !== mixed2!.effectiveness);

  // ═══════════════ 3. net impact assured só dos assured ═══════════════
  mkPattern("p3", "t_imp");
  PM.recordOutcome(ORG, "p3", { outcome: "worked", realizedImpact: 500, eventKey: "man-i", source: "manual" });
  PM.recordOutcome(ORG, "p3", { outcome: "worked", realizedImpact: 200, eventKey: "asr-i", source: "assured" });
  const s3 = PM.assuredStats(ORG, "procurement", "t_imp");
  check("3.1 netImpact assured só do assured (200)", s3.netImpact === 200);

  // ═══════════════ 4. allEffectiveness anexa sem quebrar campos originais ═══════════════
  const all = PM.allEffectiveness(ORG);
  const row = all.find((r: any) => r.pattern_type === "t_mix");
  check("4.1 mantém campos originais (effectiveness/acted)", row.effectiveness === 0.5 && row.acted === 3);
  check("4.2 anexa assuredEffectiveness + assuredActed", row.assuredEffectiveness === 0.75 && row.assuredActed === 2);
  const rowManual = all.find((r: any) => r.pattern_type === "t_manual");
  check("4.3 tipo sem assured expõe null (não 0)", rowManual.assuredEffectiveness === null && rowManual.assuredActed === 0);

  // ═══════════════ 5. isolamento multi-tenant (RN-EL-7) ═══════════════
  mkPattern("po", "t_mix", OTHER);
  PM.recordOutcome(OTHER, "po", { outcome: "backfired", eventKey: "o-b", source: "assured" });
  const sOther = PM.assuredStats(OTHER, "procurement", "t_mix");
  const sMine = PM.assuredStats(ORG, "procurement", "t_mix");
  check("5.1 OTHER isolado (backfired → 0.0)", sOther.assuredEffectiveness === 0 && sOther.assuredActed === 1);
  check("5.2 org-1 inalterado (segue 0.75)", sMine.assuredEffectiveness === 0.75);

  // ── relatório ──
  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} assured-effectiveness: ${passed}/${results.length} checks`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
