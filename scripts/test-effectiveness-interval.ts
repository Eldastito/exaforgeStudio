/**
 * TEST — intervalo de Wilson na efetividade assegurada (PRD 9 / ADR-166 F6).
 * DB-backed + unidade pura. Determinístico.
 *
 * Prova (§9, RN-EL-3/5):
 *   - wilsonInterval é pura, correta e determinística; n=0 → null;
 *   - banda estreita com n grande, larga com n pequeno (mesma taxa);
 *   - assuredStats expõe workedRate + interval + confidence label;
 *   - sem prova assegurada → interval null / confidence 'insufficient';
 *   - integra com LearningEpisode.
 *
 * Uso: npm run test:effectiveness-interval
 */
import os from "os"; import path from "path"; import fs from "fs";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-wil-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-wil-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }
const near = (a: number, b: number, eps = 0.01) => Math.abs(a - b) <= eps;

async function main() {
  const dbMod = await import("../src/server/db.js");
  const db = dbMod.default as any;
  const { wilsonInterval, intervalConfidenceLabel } = await import("../src/server/statsWilson.js");
  const { PatternMemoryService: PM } = await import("../src/server/PatternMemoryService.js");
  const { LearningEpisodeService: LEP } = await import("../src/server/LearningEpisodeService.js");
  const ORG = "org-1";

  // ═══════════════ 1. função pura correta ═══════════════
  check("1.1 n=0 → null", wilsonInterval(0, 0) === null);
  // 1/1: Wilson 95% ~ [0.2065, 1.0]
  const w11 = wilsonInterval(1, 1)!;
  check("1.2 1/1 → banda larga (lower ~0.21, upper 1.0)", near(w11.lower, 0.2065, 0.01) && near(w11.upper, 1.0, 0.001));
  // 40/45 ~ 0.889: banda estreita
  const w4045 = wilsonInterval(40, 45)!;
  check("1.3 40/45 → centro ~0.87, banda estreita", near(w4045.center, 0.87, 0.03) && (w4045.upper - w4045.lower) < 0.22);
  // 50/100: ~[0.404, 0.596]
  const w50 = wilsonInterval(50, 100)!;
  check("1.4 50/100 → ~[0.40, 0.60]", near(w50.lower, 0.404, 0.01) && near(w50.upper, 0.596, 0.01));
  check("1.5 successes>n é saturado (5/3 → usa 3/3)", wilsonInterval(5, 3)!.successes === 3);
  check("1.6 determinístico (mesmo input, mesmo output)", JSON.stringify(wilsonInterval(7, 10)) === JSON.stringify(wilsonInterval(7, 10)));

  // ═══════════════ 2. rótulo de confiança pela largura ═══════════════
  check("2.1 null → insufficient", intervalConfidenceLabel(null) === "insufficient");
  check("2.2 1/1 (largo) → low", intervalConfidenceLabel(wilsonInterval(1, 1)) === "low");
  check("2.3 45/50 (estreito) → high", intervalConfidenceLabel(wilsonInterval(45, 50)) === "high");
  // banda mais estreita com mais n para a MESMA taxa
  const width = (k: number, n: number) => { const iv = wilsonInterval(k, n)!; return iv.upper - iv.lower; };
  check("2.4 mais n → banda mais estreita (mesma taxa 0.8)", width(4, 5) > width(40, 50) && width(40, 50) > width(400, 500));

  // ═══════════════ 3. assuredStats expõe workedRate + interval + confidence ═══════════════
  const mkPattern = (id: string, type: string) =>
    db.prepare("INSERT INTO business_patterns (id, organization_id, domain, pattern_type, pattern_key, description, confidence, status, occurrences) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(id, ORG, "procurement", type, id + "-k", "p", 0.6, "validated", 3);
  db.prepare("INSERT OR IGNORE INTO organization_settings (organization_id, pattern_memory) VALUES (?, 1)").run(ORG);

  mkPattern("p-small", "t_small");
  PM.recordOutcome(ORG, "p-small", { outcome: "worked", eventKey: "s1", source: "assured" });
  const sSmall = PM.assuredStats(ORG, "procurement", "t_small");
  check("3.1 1 assured worked → workedRate 1, interval não-null", sSmall.workedRate === 1 && sSmall.interval !== null);
  check("3.2 n pequeno → confidence low", sSmall.confidence === "low");

  mkPattern("p-big", "t_big");
  for (let i = 0; i < 40; i++) PM.recordOutcome(ORG, "p-big", { outcome: "worked", eventKey: `b-w${i}`, source: "assured" });
  for (let i = 0; i < 5; i++) PM.recordOutcome(ORG, "p-big", { outcome: "backfired", eventKey: `b-b${i}`, source: "assured" });
  const sBig = PM.assuredStats(ORG, "procurement", "t_big");
  check("3.3 40/45 worked → workedRate ~0.89", near(sBig.workedRate!, 0.89, 0.01));
  check("3.4 n grande → confidence high, banda estreita", sBig.confidence === "high" && (sBig.interval!.upper - sBig.interval!.lower) < 0.25);

  // ═══════════════ 4. sem prova assegurada → null / insufficient ═══════════════
  mkPattern("p-man", "t_man");
  PM.recordOutcome(ORG, "p-man", { outcome: "worked" }); // manual, não assured
  const sMan = PM.assuredStats(ORG, "procurement", "t_man");
  check("4.1 só manual → interval null + confidence insufficient", sMan.interval === null && sMan.confidence === "insufficient" && sMan.workedRate === null);

  // ═══════════════ 5. integra com LearningEpisode ═══════════════
  const ep = LEP.episode(ORG, "p-big");
  check("5.1 episode.learning.assured traz interval + confidence", ep.learning.assured.interval !== null && ep.learning.assured.confidence === "high");

  // ── relatório ──
  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} effectiveness-interval: ${passed}/${results.length} checks`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
