/**
 * TEST — Promoção §68 dos 3 pilotos: `shadow` → `pilot` @10% + fix do clobber (RN-RO-5).
 * DB-backed, isolado por tmpDir. Determinístico. Prova:
 *
 *   - promotePilotsToPilot(10) sobe os 3 de `shadow` p/ `pilot` @ canário 10% e reporta
 *     promoted=3;
 *   - em `pilot` a decisão passa a ser cohort-gated em modo `assisted` (não mais shadow):
 *     org dentro do cohort de 10% fica live/assisted; fora do cohort não fica live;
 *   - one-time via marker: 2ª chamada é no-op (alreadyApplied, não muda nada);
 *   - NÃO briga com rollback (§69): operador rebaixa p/ shadow → nova chamada NÃO
 *     re-promove (marker de pé);
 *   - só avança de shadow: skill que o operador já subiu além de `pilot` é preservada
 *     (nunca rebaixa, nunca mexe no canário dela);
 *   - o seed (onboarding) NÃO clobbera o estágio corrente em re-runs (RN-RO-5);
 *   - subir o canário 10% → 25% → 50% → 100% (§68): amplia o cohort (só ADICIONA orgs —
 *     quem estava no balde menor continua; a 100% é universal), one-time por-percentual
 *     (marker), só sobe (preserva operador com canário maior), pula skill em `shadow`
 *     (percentual não se aplica); os degraus compõem em sequência com markers independentes.
 *   - avançar o estágio pilot → approved_execution → broader (§68): sobe o teto de
 *     execution_mode (ADR-159), preserva o canário, one-time por-estágio (marker), só
 *     avança (nunca rebaixa); `broader` é o topo da escada e AINDA mapeia pra
 *     approved_execution (humano no laço — `autonomous` nunca é semeado por rollout).
 *
 * Uso: npm run test:skillos-pilot-promote
 */
import os from "os";
import path from "path";
import fs from "fs";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-skillos-promote-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-skillos-promote-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

// Cohort estável (hashPercent puro): acha uma org DENTRO e uma FORA do cohort de 10%
// da skill de referência, sem depender de acaso.
async function findOrgs(inCohort: (org: string) => boolean): Promise<{ inside: string; outside: string }> {
  let inside = "", outside = "";
  for (let i = 0; i < 5000 && (!inside || !outside); i++) {
    const org = `org_${i}`;
    if (inCohort(org)) { if (!inside) inside = org; } else if (!outside) outside = org;
  }
  return { inside, outside };
}

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { SkillOsPilotSeeder: SEED } = await import("../src/server/SkillOsPilotSeeder.js");
  const { SkillOsRolloutService: RO } = await import("../src/server/SkillOsRolloutService.js");
  const { inCanaryCohort } = await import("../src/server/skillosModel.js");

  SEED.seedPilots();
  const skills = SEED.PILOT_SKILL_IDS;

  // Estado controlado: limpa o marker (o boot async pode tê-lo aplicado) e volta os 3
  // p/ shadow — pra provar a promoção do zero, de forma determinística.
  db.prepare(`DELETE FROM skillos_platform_markers`).run();
  for (const id of skills) RO.setStage(id, "shadow");

  // ═══════════════ 1. promoção shadow → pilot @10% ═══════════════
  const p1 = SEED.promotePilotsToPilot(10);
  check("1.1 promoveu os 3 pilotos", p1.promoted.length === 3 && p1.alreadyApplied === false && p1.percent === 10);
  check("1.2 os 3 estão em pilot @ canário 10%", skills.every((id) => { const s = RO.get(id); return s.stage === "pilot" && s.canaryPercent === 10; }));

  // ═══════════════ 2. em pilot: cohort-gated em modo assisted ═══════════════
  const ref = "signal-investigation-v1";
  const { inside, outside } = await findOrgs((org) => inCanaryCohort(ref, org, 10));
  const decIn = RO.isLiveForOrg(ref, inside);
  check("2.1 org DENTRO do cohort: live + execução assisted (não mais shadow)", decIn.live === true && decIn.executionMode === "assisted");
  const decOut = RO.isLiveForOrg(ref, outside);
  check("2.2 org FORA do cohort: não-live (mas modo assisted quando entrar)", decOut.live === false && decOut.executionMode === "assisted");

  // ═══════════════ 3. one-time (marker): 2ª chamada é no-op ═══════════════
  const p2 = SEED.promotePilotsToPilot(10);
  check("3.1 2ª chamada: alreadyApplied, nada promovido", p2.alreadyApplied === true && p2.promoted.length === 0);

  // ═══════════════ 4. NÃO briga com rollback (§69) ═══════════════
  RO.setStage(ref, "shadow"); // operador rebaixa
  const p3 = SEED.promotePilotsToPilot(10);
  check("4.1 rollback fica de pé (marker impede re-promoção)", p3.alreadyApplied === true && RO.get(ref).stage === "shadow");

  // ═══════════════ 5. só avança de shadow (não rebaixa quem subiu) ═══════════════
  db.prepare(`DELETE FROM skillos_platform_markers`).run();
  RO.setStage("collection-intent-classifier-v1", "shadow");
  RO.setStage("sales-recovery-message-v1", "approved_execution"); // operador já subiu bem além
  RO.setCanaryPercent("sales-recovery-message-v1", 100);
  RO.setStage(ref, "shadow");
  const p4 = SEED.promotePilotsToPilot(10);
  check("5.1 promoveu só os que estavam em shadow", p4.promoted.includes("collection-intent-classifier-v1") && p4.promoted.includes(ref) && p4.skipped.includes("sales-recovery-message-v1"));
  check("5.2 skill já avançada preservada (estágio + canário intactos)", (() => { const s = RO.get("sales-recovery-message-v1"); return s.stage === "approved_execution" && s.canaryPercent === 100; })());

  // ═══════════════ 6. onboarding NÃO clobbera o estágio corrente (RN-RO-5) ═══════════════
  SEED.seedPilots();
  check("6.1 re-seed não rebaixa pilot promovido p/ shadow", RO.get("collection-intent-classifier-v1").stage === "pilot");
  check("6.2 re-seed preserva estágio avançado do operador", RO.get("sales-recovery-message-v1").stage === "approved_execution");

  // ═══════════════ 7. subir o canário 10% → 25% (§68) ═══════════════
  // Estado controlado: os 3 em pilot@10; sem markers de canário.
  db.prepare(`DELETE FROM skillos_platform_markers WHERE marker LIKE 'pilots_canary_%'`).run();
  for (const id of skills) { RO.setStage(id, "pilot"); RO.setCanaryPercent(id, 10); }
  const c1 = SEED.raisePilotsCanary(25);
  check("7.1 subiu o canário dos 3 pra 25%", c1.raised.length === 3 && c1.alreadyApplied === false && c1.percent === 25);
  check("7.2 os 3 em pilot @ canário 25% (estágio intacto)", skills.every((id) => { const s = RO.get(id); return s.stage === "pilot" && s.canaryPercent === 25; }));

  // cohort é monotônico: quem estava no balde de 10% continua; e o de 25% ADICIONA orgs.
  const { inside: only25 } = await findOrgs((org) => inCanaryCohort(ref, org, 25) && !inCanaryCohort(ref, org, 10));
  check("7.3 org só no cohort de 25% (fora do de 10%) existe", !!only25);
  RO.setCanaryPercent(ref, 10);
  const wasLiveAt10 = RO.isLiveForOrg(ref, only25).live;
  RO.setCanaryPercent(ref, 25);
  const isLiveAt25 = RO.isLiveForOrg(ref, only25).live;
  check("7.4 subir 10→25 TORNA a org live (só adiciona, não remove)", wasLiveAt10 === false && isLiveAt25 === true);

  // one-time por-percentual: 2ª chamada em 25% é no-op.
  const c2 = SEED.raisePilotsCanary(25);
  check("7.5 2ª chamada @25%: alreadyApplied, nada mudou", c2.alreadyApplied === true && c2.raised.length === 0);

  // só SOBE + pula shadow: operador com canário maior é preservado; shadow intocado.
  db.prepare(`DELETE FROM skillos_platform_markers WHERE marker LIKE 'pilots_canary_%'`).run();
  RO.setStage("collection-intent-classifier-v1", "pilot"); RO.setCanaryPercent("collection-intent-classifier-v1", 50);
  RO.setStage("sales-recovery-message-v1", "shadow");
  RO.setStage(ref, "pilot"); RO.setCanaryPercent(ref, 10);
  const c3 = SEED.raisePilotsCanary(25);
  check("7.6 só sobe (skill @50% preservada), pula shadow, sobe a de 10%", c3.raised.length === 1 && c3.raised.includes(ref) && c3.skipped.includes("collection-intent-classifier-v1") && c3.skipped.includes("sales-recovery-message-v1"));
  check("7.7 canário @50% do operador intacto; shadow intocado", RO.get("collection-intent-classifier-v1").canaryPercent === 50 && RO.get("sales-recovery-message-v1").stage === "shadow");

  // ═══════════════ 8. degraus compõem: 10 → 25 → 50 → 100 (markers independentes) ═══════════════
  db.prepare(`DELETE FROM skillos_platform_markers`).run();
  for (const id of skills) RO.setStage(id, "shadow");
  const step10 = SEED.promotePilotsToPilot(10);
  const step25 = SEED.raisePilotsCanary(25);
  const step50 = SEED.raisePilotsCanary(50);
  const step100 = SEED.raisePilotsCanary(100);
  check("8.1 sequência 10→25→50→100 aplica cada degrau uma vez", step10.promoted.length === 3 && step25.raised.length === 3 && step50.raised.length === 3 && step100.raised.length === 3);
  check("8.2 estado final: os 3 em pilot @ 100%", skills.every((id) => { const s = RO.get(id); return s.stage === "pilot" && s.canaryPercent === 100; }));
  check("8.3 markers dos 4 degraus coexistem (independentes)", (() => {
    const has = (mk: string) => !!db.prepare(`SELECT 1 FROM skillos_platform_markers WHERE marker = ?`).get(mk);
    return has("pilots_pilot10_v1") && has("pilots_canary_25_v1") && has("pilots_canary_50_v1") && has("pilots_canary_100_v1");
  })());
  // @100% o cohort é UNIVERSAL: org que estava fora do balde de 50% agora é live.
  const { outside: out50 } = await findOrgs((org) => inCanaryCohort(ref, org, 50));
  check("8.4 @100% cohort universal (org fora do de 50% vira live)", !!out50 && RO.isLiveForOrg(ref, out50).live === true && RO.isLiveForOrg(ref, out50).executionMode === "assisted");
  // re-rodar qualquer degrau é no-op (cada marker já aplicado).
  const re50 = SEED.raisePilotsCanary(50);
  const re100 = SEED.raisePilotsCanary(100);
  check("8.5 re-rodar 50 e 100 é no-op (não estreita nem duplica)", re50.alreadyApplied === true && re100.alreadyApplied === true && skills.every((id) => RO.get(id).canaryPercent === 100));

  // ═══════════════ 9. avanço de estágio: pilot → approved_execution (§68) ═══════════════
  // Estado controlado: os 3 em pilot@100; sem marker de estágio approved_execution.
  db.prepare(`DELETE FROM skillos_platform_markers WHERE marker = 'pilots_stage_approved_execution_v1'`).run();
  for (const id of skills) { RO.setStage(id, "pilot"); RO.setCanaryPercent(id, 100); }
  const a1 = SEED.advancePilotsToStage("approved_execution");
  check("9.1 avançou os 3 pra approved_execution", a1.advanced.length === 3 && a1.alreadyApplied === false && a1.stage === "approved_execution");
  check("9.2 estágio approved_execution + canário 100% PRESERVADO", skills.every((id) => { const s = RO.get(id); return s.stage === "approved_execution" && s.canaryPercent === 100; }));
  // execution_mode sobe pro teto approved_execution (efeito só após aprovação).
  const decAE = RO.isLiveForOrg(ref, "org_qualquer");
  check("9.3 execução em modo approved_execution (teto ADR-159)", decAE.live === true && decAE.executionMode === "approved_execution");
  // one-time por-estágio: 2ª chamada é no-op.
  const a2 = SEED.advancePilotsToStage("approved_execution");
  check("9.4 2ª chamada: alreadyApplied, nada avançado", a2.alreadyApplied === true && a2.advanced.length === 0);
  // só AVANÇA (nunca rebaixa): skill já em broader é preservada; e não re-dispara após rollback.
  db.prepare(`DELETE FROM skillos_platform_markers WHERE marker = 'pilots_stage_approved_execution_v1'`).run();
  RO.setStage("collection-intent-classifier-v1", "broader"); // operador já subiu além do alvo
  RO.setStage(ref, "pilot");
  const a3 = SEED.advancePilotsToStage("approved_execution");
  check("9.5 skill em broader preservada (nunca rebaixa); a de pilot avança", a3.skipped.includes("collection-intent-classifier-v1") && a3.advanced.includes(ref) && RO.get("collection-intent-classifier-v1").stage === "broader");

  // ═══════════════ 10. último degrau: approved_execution → broader (§68) ═══════════════
  db.prepare(`DELETE FROM skillos_platform_markers WHERE marker = 'pilots_stage_broader_v1'`).run();
  for (const id of skills) { RO.setStage(id, "approved_execution"); RO.setCanaryPercent(id, 100); }
  const b1 = SEED.advancePilotsToStage("broader");
  check("10.1 avançou os 3 pra broader", b1.advanced.length === 3 && b1.alreadyApplied === false && b1.stage === "broader");
  check("10.2 estágio broader + canário 100% preservado", skills.every((id) => { const s = RO.get(id); return s.stage === "broader" && s.canaryPercent === 100; }));
  // broader é geral mas AINDA mapeia pra approved_execution (humano no laço — autonomous nunca).
  const decBr = RO.isLiveForOrg(ref, "org_qualquer");
  check("10.3 broader ainda executa em approved_execution (autonomous nunca)", decBr.live === true && decBr.executionMode === "approved_execution");
  // one-time + topo da escada: 2ª chamada no-op; não existe estágio acima de broader.
  const b2 = SEED.advancePilotsToStage("broader");
  check("10.4 2ª chamada broader: alreadyApplied, nada avançado", b2.alreadyApplied === true && b2.advanced.length === 0);

  console.log("\n=== TEST: SkillOS Pilot Promotion (§68 shadow→pilot@10%→canário→approved_execution→broader) ===\n");
  for (const rr of results) console.log(`${rr.ok ? "✅" : "❌"} ${rr.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ SkillOS Pilot Promotion OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
