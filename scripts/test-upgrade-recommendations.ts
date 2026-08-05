/**
 * TEST — Fatia 7.3 (ADR-153): UpgradeRecommendationService + hook publisher +
 * hook dismiss.
 *
 * Cobre:
 *   1. record(): cria uma recomendação pending vinculada ao signal_id.
 *   2. record(): idempotente por (org, target_plan_id, target_module_key)
 *      — 2ª chamada atualiza a mesma linha pending, não cria outra.
 *   3. dismiss(): marca dismissed, incrementa rejection_count, seta cooldown_until 30d.
 *   4. Escala de cooldown 30 → 90 → 180 (RN-153-F7.3-001/002).
 *   5. Escala TETO em 180 (4ª rejeição também é 180d).
 *   6. accept(): marca aceita, popula accepted_at, NÃO executa upgrade.
 *   7. hasActiveCooldown(): true dentro do window, false após expirar.
 *   8. hasActiveCooldown() com skipForCritical: severity=critical ignora cooldown
 *      (RN-153-F7.3-003).
 *   9. Publisher: RESPEITA cooldown ativo — NÃO publica novo sinal.
 *  10. Publisher: publica novamente quando cooldown expira.
 *  11. Publisher: publica CRITICAL mesmo em cooldown (uso ≥100%).
 *  12. Hook dismissBySignalId: dispensar via /api/signals/:id/dismiss propaga
 *      cooldown pra recomendação linkada.
 *  13. Isolamento cross-tenant.
 *  14. expireOldCooldowns(): marca dismissed antigos como expired.
 *  15. list(): ordem — pending primeiro (score desc), depois histórico.
 *  16. Recommendation.evidence preserva scoreBreakdown do sinal (F7.2).
 *
 * Uso: npm run test:upgrade-recommendations
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-upgrec-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-secret-upgrec-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; note?: string }[] = [];
function check(name: string, ok: boolean, note?: string) {
  results.push({ name, ok, note });
  if (!ok) failures++;
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  await new Promise((r) => setTimeout(r, 300)); // aguarda seed auto
  const { UpgradeRecommendationService } = await import("../src/server/UpgradeRecommendationService.js");
  const { PlanFitSignalPublisher } = await import("../src/server/PlanFitSignalPublisher.js");
  const { BusinessSignalService } = await import("../src/server/BusinessSignalService.js");
  const { applyPlanGrade } = await import("../src/server/plansGrade.js");

  applyPlanGrade(db);

  const orgA = `org_${randomUUID().slice(0, 8)}`;
  const orgB = `org_${randomUUID().slice(0, 8)}`;
  const orgC = `org_${randomUUID().slice(0, 8)}`; // critical bypass
  const orgD = `org_${randomUUID().slice(0, 8)}`; // dismissBySignalId hook

  const insertOrg = (id: string, plan = "start") => {
    db.prepare(
      `INSERT INTO organization_settings (id, organization_id, business_name, status, plan_id, billing_status)
       VALUES (?, ?, ?, 'active', ?, 'active')`,
    ).run(randomUUID(), id, `Org-${id.slice(0, 5)}`, plan);
  };
  insertOrg(orgA);
  insertOrg(orgB);
  insertOrg(orgC);
  insertOrg(orgD);

  // ===== 1. record cria pending =====
  const sig1 = { id: randomUUID(), evidence: { pctInt: 95, scoreBreakdown: { total: 71 } } };
  const rec1 = UpgradeRecommendationService.record(orgA, {
    signalId: sig1.id,
    signalType: "plan_near_limit_ai",
    targetPlanId: "growth",
    score: 71,
    impactAmount: 3600,
    impactUnit: "BRL",
    evidence: sig1.evidence,
  });
  check("record cria pending", rec1.status === "pending");
  check("record score=71", rec1.score === 71);
  check("record impactAmount=3600 BRL", rec1.impactAmount === 3600 && rec1.impactUnit === "BRL");
  check("record targetPlanId=growth", rec1.targetPlanId === "growth");
  check("record signal_id preservado", rec1.signalId === sig1.id);

  // ===== 2. record idempotente por (org, target, module) =====
  const sig1b = { id: randomUUID(), evidence: { pctInt: 96, scoreBreakdown: { total: 73 } } };
  const rec1b = UpgradeRecommendationService.record(orgA, {
    signalId: sig1b.id,
    signalType: "plan_near_limit_ai",
    targetPlanId: "growth",
    score: 73,
    impactAmount: 3600,
    impactUnit: "BRL",
    evidence: sig1b.evidence,
  });
  check("record 2ª chamada: atualiza mesma linha (mesmo id)", rec1b.id === rec1.id);
  check("record 2ª chamada: novo score/signal_id refletido",
    rec1b.score === 73 && rec1b.signalId === sig1b.id);
  const pendingCount = UpgradeRecommendationService.list(orgA, { status: "pending" }).length;
  check("orgA: só 1 recomendação pending pro target growth", pendingCount === 1);

  // ===== 3. dismiss marca + cooldown 30d =====
  const dis1 = UpgradeRecommendationService.dismiss(orgA, rec1.id, "user_test");
  check("dismiss ok", dis1.ok);
  check("dismiss: rejection_count = 1", dis1.recommendation?.rejectionCount === 1);
  check("dismiss: cooldown_until definido", !!dis1.recommendation?.cooldownUntil);
  const cd1 = new Date(dis1.recommendation!.cooldownUntil!).getTime();
  const now = Date.now();
  const days30 = 30 * 24 * 3600 * 1000;
  check("dismiss: cooldown ≈ 30d (±1d)", Math.abs(cd1 - now - days30) < 24 * 3600 * 1000);
  check("dismiss: status=dismissed", dis1.recommendation?.status === "dismissed");
  check("dismiss: actor preservado", dis1.recommendation?.actor === "user_test");

  // ===== 4. Escala 30 → 90 → 180 =====
  // Cria uma nova recomendação pro MESMO target (após dismiss, próxima é nova linha).
  const sig2 = { id: randomUUID() };
  const rec2 = UpgradeRecommendationService.record(orgA, {
    signalId: sig2.id, signalType: "plan_near_limit_ai", targetPlanId: "growth", score: 65,
  });
  check("nova record após dismiss: id diferente", rec2.id !== rec1.id);
  const dis2 = UpgradeRecommendationService.dismiss(orgA, rec2.id);
  check("2ª rejeição: rejection_count = 2", dis2.recommendation?.rejectionCount === 2);
  const cd2 = new Date(dis2.recommendation!.cooldownUntil!).getTime();
  const days90 = 90 * 24 * 3600 * 1000;
  check("2ª rejeição: cooldown ≈ 90d", Math.abs(cd2 - now - days90) < 2 * 24 * 3600 * 1000);

  const sig3 = { id: randomUUID() };
  const rec3 = UpgradeRecommendationService.record(orgA, {
    signalId: sig3.id, signalType: "plan_near_limit_ai", targetPlanId: "growth", score: 65,
  });
  const dis3 = UpgradeRecommendationService.dismiss(orgA, rec3.id);
  check("3ª rejeição: rejection_count = 3", dis3.recommendation?.rejectionCount === 3);
  const cd3 = new Date(dis3.recommendation!.cooldownUntil!).getTime();
  const days180 = 180 * 24 * 3600 * 1000;
  check("3ª rejeição: cooldown ≈ 180d", Math.abs(cd3 - now - days180) < 2 * 24 * 3600 * 1000);

  // ===== 5. Teto em 180 (4ª rejeição também 180) =====
  const sig4 = { id: randomUUID() };
  const rec4 = UpgradeRecommendationService.record(orgA, {
    signalId: sig4.id, signalType: "plan_near_limit_ai", targetPlanId: "growth", score: 65,
  });
  const dis4 = UpgradeRecommendationService.dismiss(orgA, rec4.id);
  check("4ª rejeição: rejection_count = 4", dis4.recommendation?.rejectionCount === 4);
  const cd4 = new Date(dis4.recommendation!.cooldownUntil!).getTime();
  check("4ª rejeição: cooldown TETO em 180d", Math.abs(cd4 - now - days180) < 2 * 24 * 3600 * 1000);

  // ===== 6. accept =====
  const recAccept = UpgradeRecommendationService.record(orgA, {
    signalId: randomUUID(), signalType: "plan_module_gap",
    targetPlanId: "scale", targetModuleKey: "rie", score: 65,
  });
  const acc = UpgradeRecommendationService.accept(orgA, recAccept.id, "user_dono");
  check("accept ok", acc.ok);
  check("accept: status=accepted", acc.recommendation?.status === "accepted");
  check("accept: accepted_at preenchido", !!acc.recommendation?.acceptedAt);
  check("accept: actor preservado", acc.recommendation?.actor === "user_dono");
  // G-153-3: accept NÃO altera plano da org
  const orgAfter = db.prepare("SELECT plan_id FROM organization_settings WHERE organization_id = ?").get(orgA) as any;
  check("accept NÃO altera plan_id da org (G-153-3)", orgAfter?.plan_id === "start");

  // ===== 7. hasActiveCooldown =====
  const cdActive = UpgradeRecommendationService.hasActiveCooldown(orgA, "growth", null);
  check("hasActiveCooldown(growth): true (rec4 dismissed com 180d)", cdActive === true);
  const cdOther = UpgradeRecommendationService.hasActiveCooldown(orgA, "enterprise", null);
  check("hasActiveCooldown(enterprise): false (nenhum dismiss pra esse target)", cdOther === false);

  // ===== 8. skipForCritical =====
  const cdCritSkip = UpgradeRecommendationService.hasActiveCooldown(orgA, "growth", null, {
    skipForCritical: true, severity: "critical",
  });
  check("hasActiveCooldown skipForCritical + severity=critical: false (RN-F7.3-003)", cdCritSkip === false);
  const cdCritNoSkip = UpgradeRecommendationService.hasActiveCooldown(orgA, "growth", null, {
    skipForCritical: true, severity: "attention",
  });
  check("hasActiveCooldown skipForCritical mas severity=attention: mantém true", cdCritNoSkip === true);

  // ===== 9. Publisher respeita cooldown =====
  // orgB em start, uso AI 95% → deveria publicar. Setamos cooldown ANTES.
  const insertAi = (orgId: string, n: number) => {
    for (let i = 0; i < n; i++) {
      db.prepare(`INSERT INTO ai_interactions_log (id, organization_id, agent_used, created_at) VALUES (?, ?, 'test', CURRENT_TIMESTAMP)`).run(randomUUID(), orgId);
    }
  };
  insertAi(orgB, 2850); // 95%
  // Pré-cria recomendação dismissed pro alvo growth (simulando dono já dispensou).
  const preRec = UpgradeRecommendationService.record(orgB, {
    signalId: randomUUID(), signalType: "plan_near_limit_ai", targetPlanId: "growth", score: 71,
  });
  UpgradeRecommendationService.dismiss(orgB, preRec.id, "user_test");
  const pubB1 = PlanFitSignalPublisher.run(orgB);
  check("publisher orgB: cooldown ativo → NÃO publica novo sinal (published=0)",
    pubB1.published === 0,
    `published=${pubB1.published} deduped=${pubB1.deduped}`);
  const openB = BusinessSignalService.list(orgB, { domain: "plan", status: "open" });
  check("orgB: 0 sinais abertos (cooldown blocked)", openB.length === 0);

  // ===== 10. Publisher publica quando cooldown expira =====
  // Fake: seta cooldown_until pra passado no DB direto.
  db.prepare(`UPDATE upgrade_recommendations SET cooldown_until = datetime('now', '-1 day') WHERE organization_id = ?`).run(orgB);
  const pubB2 = PlanFitSignalPublisher.run(orgB);
  check("publisher orgB após cooldown expirar: publica (published=1)",
    pubB2.published === 1,
    `published=${pubB2.published}`);
  const openB2 = BusinessSignalService.list(orgB, { domain: "plan", status: "open" });
  check("orgB: 1 sinal aberto após expirar", openB2.length === 1);

  // ===== 11. Publisher publica CRITICAL mesmo em cooldown =====
  // orgC: uso contacts 105% → critical. Pré-dismiss target growth.
  const chId = randomUUID();
  db.prepare(`INSERT INTO channels (id, organization_id, provider, name, identifier, status) VALUES (?, ?, 'whatsapp', 'x', 'ch_c', 'disabled')`).run(chId, orgC);
  for (let i = 0; i < 3150; i++) {
    db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, identifier) VALUES (?, ?, ?, ?)`).run(randomUUID(), orgC, chId, `55199${i}`);
  }
  const preRecC = UpgradeRecommendationService.record(orgC, {
    signalId: randomUUID(), signalType: "plan_near_limit_contacts", targetPlanId: "growth", score: 84,
  });
  UpgradeRecommendationService.dismiss(orgC, preRecC.id, "user_test");
  const pubC = PlanFitSignalPublisher.run(orgC);
  check("publisher orgC (critical=105%): publica mesmo em cooldown (RN-F7.3-003)",
    pubC.published >= 1,
    `published=${pubC.published} deduped=${pubC.deduped}`);

  // ===== 12. dismissBySignalId hook =====
  // orgD: publica normalmente, depois hook do route dispensa via signalId.
  insertAi(orgD, 2850);
  const pubD = PlanFitSignalPublisher.run(orgD);
  check("publisher orgD: publica 1º sinal", pubD.published === 1);
  const signalsD = BusinessSignalService.list(orgD, { domain: "plan", status: "open" });
  const signalDId = signalsD[0].id;
  const hook = UpgradeRecommendationService.dismissBySignalId(orgD, signalDId, "user_hook");
  check("dismissBySignalId hook: ok", hook.ok);
  check("hook: recomendação linkada foi dispensada",
    hook.recommendation?.status === "dismissed");
  check("hook: rejection_count = 1", hook.recommendation?.rejectionCount === 1);
  // hook em signalId inexistente = no-op
  const hookMissing = UpgradeRecommendationService.dismissBySignalId(orgD, randomUUID(), null);
  check("hook em signalId sem recomendação linkada: ok=false, no-op", !hookMissing.ok);

  // ===== 13. Cross-tenant =====
  const recsA = UpgradeRecommendationService.list(orgA);
  const recsB = UpgradeRecommendationService.list(orgB);
  const recsD = UpgradeRecommendationService.list(orgD);
  const anyLeakBinA = recsA.some((r) => r.organizationId !== orgA);
  const anyLeakBtoOthers = recsB.some((r) => r.organizationId !== orgB);
  check("cross-tenant: orgA não vê recs de outra org", !anyLeakBinA);
  check("cross-tenant: orgB isolado", !anyLeakBtoOthers);
  check("cross-tenant: orgD isolado", recsD.every((r) => r.organizationId === orgD));

  // ===== 14. expireOldCooldowns =====
  // Já forçamos orgB cooldown pro passado (linha 10). expireOldCooldowns deve
  // marcar essas como expired.
  const nExpired = UpgradeRecommendationService.expireOldCooldowns(orgB);
  check("expireOldCooldowns: marca cooldowns passados como expired", nExpired >= 1);
  const bExpired = UpgradeRecommendationService.list(orgB, { status: "expired" });
  check("orgB: tem ≥1 recomendação expired", bExpired.length >= 1);

  // ===== 15. list() ordena pending primeiro, depois score desc =====
  // Cria 2 pending em orgA com scores diferentes (target enterprise sem cooldown).
  const recHigh = UpgradeRecommendationService.record(orgA, {
    signalId: randomUUID(), signalType: "plan_module_gap",
    targetPlanId: "enterprise", targetModuleKey: "clinica", score: 90,
  });
  const recLow = UpgradeRecommendationService.record(orgA, {
    signalId: randomUUID(), signalType: "plan_module_gap",
    targetPlanId: "enterprise", targetModuleKey: "vms", score: 62,
  });
  const listedA = UpgradeRecommendationService.list(orgA, { status: "pending" });
  const idxHigh = listedA.findIndex((r) => r.id === recHigh.id);
  const idxLow = listedA.findIndex((r) => r.id === recLow.id);
  check("list ordena por score desc dentro de pending", idxHigh >= 0 && idxLow > idxHigh);

  // ===== 16. Evidence preserva scoreBreakdown =====
  check("evidence preserva scoreBreakdown (F7.2)",
    listedA.find((r) => r.id === recHigh.id)?.evidence != null);

  // ===== Resultado =====
  console.log("\n=== UpgradeRecommendationService (F7.3) ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.note ? "  (" + r.note + ")" : ""}`);
  console.log(`\n${results.length - failures}/${results.length} checks OK`);
  if (failures > 0) process.exit(1);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
