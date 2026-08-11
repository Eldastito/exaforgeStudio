/**
 * TEST — Onboarding dos 3 pilotos §61 no SkillOS (Collection Intent Classifier,
 * Sales Recovery Message, Signal Investigation). DB-backed, isolado por tmpDir.
 * Determinístico. Prova:
 *
 *   - seedPilots registra 3 Capabilities + 3 Skills válidas (cada Skill referencia sua
 *     Capability existente) + 9 casos de eval (3 por skill);
 *   - é IDEMPOTENTE (2× não duplica);
 *   - o Resolver enxerga os pilotos (escolha determinística);
 *   - os evals (golden) PASSAM e não regridem — travam o contrato real de cada serviço
 *     (intent enum + fallback, source llm/template, aiUsed=false determinístico);
 *   - cada piloto começa em `shadow` → SEM efeito (isLiveForOrg não-live, mas mode shadow).
 *
 * Uso: npm run test:skillos-pilot-seed
 */
import os from "os";
import path from "path";
import fs from "fs";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-skillos-seed-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-skillos-seed-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  await import("../src/server/db.js");
  const { SkillOsPilotSeeder: SEED } = await import("../src/server/SkillOsPilotSeeder.js");
  const { SkillOsRegistryService: REG } = await import("../src/server/SkillOsRegistryService.js");
  const { SkillOsResolverService: RES } = await import("../src/server/SkillOsResolverService.js");
  const { SkillOsEvalService: EV } = await import("../src/server/SkillOsEvalService.js");
  const { SkillOsRolloutService: RO } = await import("../src/server/SkillOsRolloutService.js");

  // O boot do db.js já dispara o seed (async). Rodamos explicitamente pra garantir
  // determinismo (e provar idempotência).
  const s1 = SEED.seedPilots();

  // ═══════════════ 1. registro (capabilities + skills) ═══════════════
  check("1.1 seed reporta 3 caps + 3 skills", s1.capabilities === 3 && s1.skills === 3);
  const caps = ["collection.intent_classify", "sales.recovery_message", "signal.investigate"];
  check("1.2 as 3 capabilities existem e estão ativas", caps.every((c) => REG.getCapability(c)?.status === "active"));
  const skills = SEED.PILOT_SKILL_IDS;
  check("1.3 as 3 skills existem e apontam p/ suas capabilities", skills.every((id, i) => REG.getSkill(id)?.capabilityId === caps[i]));
  check("1.4 signal-investigation não exige modelo (determinístico)", REG.getSkill("signal-investigation-v1")?.modelRequirements == null && REG.getSkill("signal-investigation-v1")?.supportsFallback === false);
  check("1.5 collection classifier exige structured_output; degrada interno (não é fallback de skill)", (() => { const m = REG.getSkill("collection-intent-classifier-v1"); return !!m?.modelRequirements?.needs.includes("structured_output") && m?.supportsFallback === false; })());

  // ═══════════════ 2. idempotência ═══════════════
  const s2 = SEED.seedPilots();
  check("2.1 2ª rodada não duplica capabilities", REG.listCapabilities({}).filter((c: any) => caps.includes(c.capabilityId)).length === 3);
  check("2.2 2ª rodada não duplica skills", skills.every((id) => REG.listSkills({}).filter((m: any) => m.skillId === id).length === 1));
  check("2.3 evalCases estável entre rodadas", s1.evalCases === 9 && s2.evalCases === 9);

  // ═══════════════ 3. Resolver enxerga os pilotos ═══════════════
  const org = "org_pilot";
  const db = (await import("../src/server/db.js")).default;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES ('os1', ?, 'X', 'active')`).run(org);
  const r = RES.resolve(org, { userId: "u1", role: "owner" } as any, { capabilityId: "signal.investigate" });
  check("3.1 Resolver escolhe a skill do piloto", r.resolved === true && r.skill?.skillId === "signal-investigation-v1");

  // ═══════════════ 4. evals golden passam + não regridem ═══════════════
  for (const id of skills) {
    const res = await EV.run(id);
    check(`4.${id} eval passa (${res.passed}/${res.total}) sem regressão`, res.total === 3 && res.passed === 3 && res.regressed === false);
  }

  // ═══════════════ 5. estágio shadow → SEM efeito ═══════════════
  check("5.1 os 3 pilotos em shadow", skills.every((id) => RO.get(id).stage === "shadow"));
  const dec = RO.isLiveForOrg("signal-investigation-v1", org);
  check("5.2 shadow: live=true mas execução em modo shadow (sem efeito)", dec.live === true && dec.executionMode === "shadow");
  // (shadow expõe pra observar, mas o execution_mode 'shadow' não executa efeito — o
  // gate real segue no CommandExecutor; e nenhum piloto tem commandType próprio.)

  console.log("\n=== TEST: SkillOS Pilot Onboarding (§61) ===\n");
  for (const rr of results) console.log(`${rr.ok ? "✅" : "❌"} ${rr.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ SkillOS Pilot Onboarding OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
