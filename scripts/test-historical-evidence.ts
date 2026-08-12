/**
 * TEST — historicalEvidence no Evidence Package (PRD 9 / ADR-166 F4). DB-backed, det.
 *
 * Prova (§11/§12, D6, RN-EL-1/2/5/7):
 *   - historicalEvidence deixa de ser [] e traz o aprendizado com prova ASSEGURADA;
 *   - só episódios com prova assegurada entram (padrão só-manual NÃO aparece);
 *   - cada item carrega assuredEffectiveness/learningState/suggestedRefutation;
 *   - refutação sugerida vem primeiro;
 *   - sem aprendizado assegurado → [] (0-regressão);
 *   - isolamento multi-tenant.
 *
 * Uso: npm run test:historical-evidence
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-hev-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-hev-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const dbMod = await import("../src/server/db.js");
  const db = dbMod.default as any;
  const { PatternMemoryService: PM } = await import("../src/server/PatternMemoryService.js");
  const { EvidencePackageService: EP } = await import("../src/server/EvidencePackageService.js");

  const mkOrg = () => { const id = `org_${randomUUID().slice(0, 8)}`; db.prepare("INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')").run(randomUUID(), id); return id; };
  const mkPattern = (org: string, id: string, type: string) =>
    db.prepare("INSERT INTO business_patterns (id, organization_id, domain, pattern_type, pattern_key, description, confidence, status, occurrences) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(id, org, "procurement", type, id + "-k", "aprendi " + type, 0.6, "validated", 3);
  const asr = (org: string, pid: string, outcome: string, key: string, impact = 0) =>
    PM.recordOutcome(org, pid, { outcome, realizedImpact: impact, eventKey: key, source: "assured" });
  const hev = (org: string) => EP.build(org, { subject: "s:test" }).historicalEvidence;

  // ═══════════════ 1. sem aprendizado assegurado → [] ═══════════════
  const orgA = mkOrg();
  mkPattern(orgA, "p-manual", "t_manual");
  PM.recordOutcome(orgA, "p-manual", { outcome: "worked" }); // manual, não assured
  check("1.1 sem assured → historicalEvidence vazio (0-regressão)", Array.isArray(hev(orgA)) && hev(orgA).length === 0);

  // ═══════════════ 2. aprendizado assegurado entra ═══════════════
  mkPattern(orgA, "p-good", "t_good");
  asr(orgA, "p-good", "worked", "g-1", 100); asr(orgA, "p-good", "worked", "g-2", 200);
  const h2 = hev(orgA);
  const good = h2.find((e: any) => e.patternType === "t_good");
  check("2.1 aprendizado assured aparece", !!good && good.source === "learning" && good.assuredActed === 2);
  check("2.2 carrega assuredEffectiveness + learningState reinforced", good.assuredEffectiveness === 1 && good.learningState === "reinforced");
  check("2.3 padrão só-manual continua fora", !h2.some((e: any) => e.patternType === "t_manual"));

  // ═══════════════ 3. refutação sugerida vem primeiro ═══════════════
  mkPattern(orgA, "p-bad", "t_bad");
  asr(orgA, "p-bad", "backfired", "b-1", -10); asr(orgA, "p-bad", "backfired", "b-2", -20);
  const h3 = hev(orgA);
  check("3.1 refutação sugerida primeiro", h3[0].patternType === "t_bad" && h3[0].suggestedRefutation === true);
  check("3.2 ainda inclui o reforçado", h3.some((e: any) => e.patternType === "t_good"));

  // ═══════════════ 4. isolamento multi-tenant ═══════════════
  const orgB = mkOrg();
  mkPattern(orgB, "p-b", "t_good"); asr(orgB, "p-b", "worked", "ob-1", 5);
  const hB = hev(orgB);
  check("4.1 orgB só vê o seu (1 item)", hB.length === 1 && hB[0].patternId === "p-b");
  check("4.2 orgA inalterado (não vaza p-b)", !hev(orgA).some((e: any) => e.patternId === "p-b"));

  // ── relatório ──
  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} historical-evidence: ${passed}/${results.length} checks`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
