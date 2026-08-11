/**
 * TEST — PRD 4 F12 (Canary + Production Readiness): esteira de rollout §68 +
 * canário (cohort estável) + kill switch (por-skill e de plataforma) + rollback +
 * readiness. DB-backed, isolado por tmpDir. Determinístico. Prova:
 *
 *   - escada §68 ordenada + estágio→execution_mode (ADR-159, nunca autonomous);
 *   - hashPercent puro/estável + inCanaryCohort monotônico (subir % só adiciona);
 *   - evaluateRollout: kill global > kill skill > development > cohort > live;
 *   - serviço: get/setStage/setCanaryPercent/stepDown/kill/revive/killAll/reviveAll;
 *   - isLiveForOrg compõe tudo; readiness deriva kill/regressão(F11)/provider aberto(F5);
 *   - ProductionReadinessService ganhou o check `skillos` (aditivo).
 *
 * Uso: npm run test:skillos-rollout
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-skillos-ro-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-skillos-ro-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }
const throws = (fn: () => any) => { try { fn(); return false; } catch { return true; } };

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const M = await import("../src/server/skillosModel.js");
  const { SkillOsRolloutService: RO } = await import("../src/server/SkillOsRolloutService.js");
  const { ProductionReadinessService: PR } = await import("../src/server/ProductionReadinessService.js");

  // ═══════════════ 1. escada + estágio→execution_mode (puro) ═══════════════
  check("1.1 escada §68 ordenada", JSON.stringify(M.ROLLOUT_STAGES) === JSON.stringify(["development", "shadow", "pilot", "assisted", "approved_execution", "broader"]));
  check("1.2 rank monotônico", M.rolloutStageRank("development") === 0 && M.rolloutStageRank("broader") === 5 && M.rolloutStageRank("pilot") === 2);
  check("1.3 development não expõe (mode null)", M.executionModeForStage("development") === null);
  check("1.4 shadow→shadow", M.executionModeForStage("shadow") === "shadow");
  check("1.5 pilot/assisted→assisted", M.executionModeForStage("pilot") === "assisted" && M.executionModeForStage("assisted") === "assisted");
  check("1.6 approved_execution/broader→approved_execution (NUNCA autonomous)", M.executionModeForStage("approved_execution") === "approved_execution" && M.executionModeForStage("broader") === "approved_execution");
  check("1.7 nenhum estágio mapeia p/ autonomous", M.ROLLOUT_STAGES.every((s: any) => String(M.executionModeForStage(s)) !== "autonomous"));

  // ═══════════════ 2. hashPercent + cohort estável/monotônico (puro) ═══════════════
  check("2.1 hashPercent estável + 0..99", M.hashPercent("a:b") === M.hashPercent("a:b") && M.hashPercent("a:b") >= 0 && M.hashPercent("a:b") < 100);
  check("2.2 cohort 0 = ninguém, 100 = todos", !M.inCanaryCohort("sk", "org1", 0) && M.inCanaryCohort("sk", "org1", 100));
  // monotônico: quem está em 25% está em 50% (mesmo hash, threshold maior).
  const orgs = Array.from({ length: 300 }, (_, i) => `org_${i}`);
  const in25 = new Set(orgs.filter((o) => M.inCanaryCohort("skX", o, 25)));
  const in50 = orgs.filter((o) => M.inCanaryCohort("skX", o, 50));
  check("2.3 cohort monotônico (25% ⊆ 50%)", [...in25].every((o) => in50.includes(o)) && in50.length >= in25.size);
  check("2.4 proporção ~25% (tolerância)", Math.abs(in25.size / orgs.length - 0.25) < 0.08);

  // ═══════════════ 3. evaluateRollout (puro) — precedência ═══════════════
  const st = (patch: any = {}) => ({ skillId: "sk", stage: "broader", canaryPercent: 100, killed: false, ...patch });
  check("3.1 kill global vence tudo", M.evaluateRollout(st(), "o1", true).live === false && M.evaluateRollout(st(), "o1", true).reason.includes("global"));
  check("3.2 kill de skill barra", M.evaluateRollout(st({ killed: true }), "o1", false).live === false);
  check("3.3 development não expõe", M.evaluateRollout(st({ stage: "development" }), "o1", false).live === false);
  check("3.4 broader 100% → live + approved_execution", (() => { const d = M.evaluateRollout(st(), "o1", false); return d.live && d.executionMode === "approved_execution"; })());
  check("3.5 pilot fora do cohort (0%) → not live, mas mode assisted", (() => { const d = M.evaluateRollout(st({ stage: "pilot", canaryPercent: 0 }), "o1", false); return !d.live && d.executionMode === "assisted" && d.reason.includes("cohort"); })());
  check("3.6 shadow ignora percentual (universal)", M.evaluateRollout(st({ stage: "shadow", canaryPercent: 0 }), "o1", false).live === true);

  // ═══════════════ 4. serviço: estado, transições, kill ═══════════════
  check("4.1 defaults (development/0/vivo)", (() => { const s = RO.get("sk-a"); return s.stage === "development" && s.canaryPercent === 0 && s.killed === false; })());
  check("4.2 setStage inválido lança", throws(() => RO.setStage("sk-a", "nope" as any)));
  RO.setStage("sk-a", "pilot"); RO.setCanaryPercent("sk-a", 150);
  check("4.3 setStage + canary clampado a 100", (() => { const s = RO.get("sk-a"); return s.stage === "pilot" && s.canaryPercent === 100; })());
  check("4.4 stepDown desce um degrau (pilot→shadow)", RO.stepDown("sk-a").stage === "shadow");
  check("4.5 stepDown piso = development", (() => { RO.setStage("sk-a", "development"); return RO.stepDown("sk-a").stage === "development"; })());
  check("4.6 kill/revive por-skill", RO.kill("sk-a").killed === true && RO.revive("sk-a").killed === false);

  // kill switch de plataforma
  check("4.7 killAll liga o global", (() => { RO.killAll(); return RO.isGloballyKilled() === true; })());
  RO.setStage("sk-b", "broader");
  check("4.8 com global kill, isLiveForOrg = not live", RO.isLiveForOrg("sk-b", "o1").live === false);
  check("4.9 reviveAll desliga o global", (() => { RO.reviveAll(); return RO.isGloballyKilled() === false && RO.isLiveForOrg("sk-b", "o1").live === true; })());

  // ═══════════════ 5. readiness (derivado: kill + regressão F11 + provider aberto F5) ═══════════════
  check("5.1 readiness limpa quando tudo ok", (() => { const r = RO.readiness(); return r.ok === true && r.issues.length === 0; })());
  // (a) skill em kill
  RO.kill("sk-killed");
  // (b) skill com último eval regredido (F11)
  db.prepare(`INSERT INTO skillos_eval_runs (id, skill_id, total, passed, failed, pass_rate, regressed, mode) VALUES (?, 'sk-reg', 3, 1, 2, 0.33, 1, 'eval')`).run(randomUUID());
  // (c) provider com breaker aberto (F5): profile + 4 runs falhas na janela
  db.prepare(`INSERT INTO skillos_model_profiles (model, provider, capabilities_json, status) VALUES ('m-x', 'provdown', '[]', 'active')`).run();
  for (let i = 0; i < 4; i++) db.prepare(`INSERT INTO ai_usage_log (id, organization_id, model, kind, run_id, provider, run_status) VALUES (?, 'o1', 'm-x', 'k', ?, 'provdown', 'failed')`).run(randomUUID(), randomUUID());
  const r2 = RO.readiness();
  check("5.2 readiness detecta skill em kill", r2.killedSkills.includes("sk-killed"));
  check("5.3 readiness detecta skill regredida (F11)", r2.regressedSkills.includes("sk-reg"));
  check("5.4 readiness detecta provider aberto (F5)", r2.openProviders.includes("provdown"));
  check("5.5 readiness ok=false com issues", r2.ok === false && r2.issues.length >= 3);
  // regressão que foi CORRIGIDA no run seguinte não conta (último run manda)
  db.prepare(`INSERT INTO skillos_eval_runs (id, skill_id, total, passed, failed, pass_rate, regressed, mode) VALUES (?, 'sk-reg', 3, 3, 0, 1.0, 0, 'eval')`).run(randomUUID());
  check("5.6 regressão corrigida no último run sai do readiness", !RO.readiness().regressedSkills.includes("sk-reg"));

  // ═══════════════ 6. ProductionReadinessService ganhou o check skillos ═══════════════
  const rep = PR.report();
  const skillosCheck = rep.checks.find((c: any) => c.key === "skillos");
  check("6.1 report inclui o check 'skillos' (aditivo, optional)", !!skillosCheck && skillosCheck.level === "optional");
  check("6.2 checks antigos preservados (0 regressão)", rep.checks.some((c: any) => c.key === "openai") && rep.checks.some((c: any) => c.key === "jwt_secret"));

  console.log("\n=== TEST: SkillOS Rollout + Readiness (PRD 4 F12) ===\n");
  for (const rr of results) console.log(`${rr.ok ? "✅" : "❌"} ${rr.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ SkillOS Rollout + Readiness (F12) OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
