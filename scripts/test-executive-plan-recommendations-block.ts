/**
 * TESTE — Fatia 7.5 (ADR-153): `ExecutiveAdvisorService.planRecommendationsBlock`.
 *
 * Verifica que o Diretor Executivo IA ganha contexto real de plano +
 * recomendações + cooldowns no PANORAMA (síncrono, sem LLM). Blob composto
 * pela IA no `.ask()`, mas o teste cobre só o bloco (LLM está fora do
 * escopo — determinístico só até esse ponto).
 *
 * Cobre:
 *   1. Sem org: bloco vazio (best-effort, não throw).
 *   2. Org sem recomendações: bloco mínimo com plano atual.
 *   3. Recomendação pending: aparece na seção "Pendentes".
 *   4. Recomendação com uplift em BRL: cita `ganho ≈R$ X/mês`.
 *   5. Recomendação com score: cita `score X/100`.
 *   6. Recomendação plan_module_gap: cita `módulo "X" (via plano Y)`.
 *   7. Recomendação dismissed COM cooldown ativo: aparece em "Pausadas por rejeição".
 *   8. Recomendação dismissed com cooldown EXPIRADO: NÃO aparece.
 *   9. Recomendação accepted: aparece em "Aceitas aguardando checkout".
 *  10. Framing G-153-3 no cabeçalho ("sugerir clicar em Cobrança").
 *  11. Framing LGPD §14 na seção pausadas ("NÃO sugerir").
 *  12. Framing G-153-6 no cabeçalho ("NUNCA invente score").
 *  13. Isolamento cross-tenant.
 *  14. `buildPanorama` inclui o bloco.
 *
 * Uso: npm run test:executive-plan-recommendations-block
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-exec-planrec-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-secret-exec-planrec-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  await new Promise((r) => setTimeout(r, 300)); // aguarda seed auto
  const { ExecutiveAdvisorService } = await import("../src/server/ExecutiveAdvisorService.js");
  const { UpgradeRecommendationService } = await import("../src/server/UpgradeRecommendationService.js");
  const { applyPlanGrade } = await import("../src/server/plansGrade.js");
  applyPlanGrade(db);

  // ===== 1. Org inexistente: bloco vazio =====
  const bogusOrg = "org_bogus_" + randomUUID().slice(0, 6);
  const bogus = ExecutiveAdvisorService.planRecommendationsBlock(bogusOrg);
  check("org inexistente: bloco vazio (best-effort)", bogus === "" || !bogus.includes("Pendentes"));

  // ===== 2. Org sem recomendações =====
  const orgA = "org_A_" + randomUUID().slice(0, 6);
  db.prepare(
    `INSERT INTO organization_settings (id, organization_id, business_name, status, plan_id, billing_status)
     VALUES (?, ?, 'A', 'active', 'start', 'active')`,
  ).run(randomUUID(), orgA);

  const blockA = ExecutiveAdvisorService.planRecommendationsBlock(orgA);
  check("org sem recomendações: bloco tem cabeçalho de plano",
    blockA.includes("PLANO E RECOMENDAÇÕES") || blockA.includes("nenhuma recomendação ativa"));
  check("org sem recomendações: bloco cita plano atual (Start)",
    blockA.includes("Start") && blockA.includes("start"),
    blockA.slice(0, 300));
  check("org sem recomendações: bloco NÃO tem seção Pendentes",
    !blockA.includes("Pendentes (dono"));

  // ===== 3. Recomendação pending =====
  UpgradeRecommendationService.record(orgA, {
    signalId: randomUUID(),
    signalType: "plan_near_limit_ai",
    targetPlanId: "growth",
    score: 71,
    impactAmount: 3600,
    impactUnit: "BRL",
    evidence: { pctInt: 95 },
  });
  const blockA2 = ExecutiveAdvisorService.planRecommendationsBlock(orgA);
  check("pending: aparece seção 'Pendentes'", blockA2.includes("Pendentes"));
  check("pending: cita target plan 'growth'", blockA2.includes("plano growth"));
  // ===== 4. Uplift em BRL =====
  check("pending: cita `ganho ≈R$ 3600/mês`", blockA2.includes("ganho ≈R$ 3600"), blockA2);
  // ===== 5. Score =====
  check("pending: cita `score 71/100`", blockA2.includes("score 71/100"), blockA2);

  // ===== 6. plan_module_gap =====
  UpgradeRecommendationService.record(orgA, {
    signalId: randomUUID(),
    signalType: "plan_module_gap",
    targetPlanId: "enterprise",
    targetModuleKey: "clinica",
    score: 65,
    impactAmount: 22000,
    impactUnit: "BRL",
  });
  const blockA3 = ExecutiveAdvisorService.planRecommendationsBlock(orgA);
  check("module_gap: cita `módulo \"clinica\" (via plano enterprise)`",
    blockA3.includes('módulo "clinica"') && blockA3.includes("via plano enterprise"),
    blockA3);

  // ===== 7. Dismissed com cooldown ATIVO =====
  const recToDismiss = UpgradeRecommendationService.record(orgA, {
    signalId: randomUUID(),
    signalType: "plan_near_limit_contacts",
    targetPlanId: "scale",
    score: 80,
    impactAmount: 9000,
    impactUnit: "BRL",
  });
  UpgradeRecommendationService.dismiss(orgA, recToDismiss.id, "user_test");
  const blockA4 = ExecutiveAdvisorService.planRecommendationsBlock(orgA);
  check("dismissed cooldown ativo: aparece em 'Pausadas por rejeição'",
    blockA4.includes("Pausadas por rejeição"),
    blockA4);
  check("dismissed: cita plano `scale`",
    blockA4.includes("plano scale"),
    blockA4);
  check("dismissed: cita `pausada por mais Xd`",
    /pausada por mais \d+d/.test(blockA4),
    blockA4);
  check("dismissed: cita `1ª rejeição`",
    blockA4.includes("1ª rejeição"),
    blockA4);

  // ===== 8. Dismissed com cooldown EXPIRADO =====
  const recExpired = UpgradeRecommendationService.record(orgA, {
    signalId: randomUUID(),
    signalType: "plan_near_limit_users",
    targetPlanId: "growth",
    score: 65,
    // targetModuleKey diferente pra não colidir com o pending pré-existente
    targetModuleKey: "test_expired_channel",
  });
  UpgradeRecommendationService.dismiss(orgA, recExpired.id);
  db.prepare(
    `UPDATE upgrade_recommendations SET cooldown_until = datetime('now', '-2 days') WHERE id = ?`,
  ).run(recExpired.id);
  const blockA5 = ExecutiveAdvisorService.planRecommendationsBlock(orgA);
  check("dismissed com cooldown EXPIRADO: NÃO aparece nas pausadas",
    !blockA5.includes("test_expired_channel"),
    blockA5);

  // ===== 9. Accepted aguardando checkout =====
  const recAcc = UpgradeRecommendationService.record(orgA, {
    signalId: randomUUID(),
    signalType: "plan_module_gap",
    targetPlanId: "scale",
    targetModuleKey: "rie",
    score: 70,
    impactAmount: 4500,
    impactUnit: "BRL",
  });
  UpgradeRecommendationService.accept(orgA, recAcc.id, "user_test");
  const blockA6 = ExecutiveAdvisorService.planRecommendationsBlock(orgA);
  check("accepted: aparece em 'Aceitas aguardando checkout'",
    blockA6.includes("Aceitas aguardando checkout"),
    blockA6);
  check("accepted: cita módulo `rie`",
    blockA6.includes('módulo "rie"'),
    blockA6);

  // ===== 10. Framing G-153-3 =====
  check("G-153-3 no cabeçalho: `sugerir clicar em \"Cobrança\"`",
    blockA6.includes('sugerir clicar em "Cobrança"'),
    blockA6.slice(0, 300));
  check("G-153-3 no cabeçalho: `NUNCA executar upgrade`",
    blockA6.includes("NUNCA executar upgrade"),
    blockA6.slice(0, 300));

  // ===== 11. Framing LGPD §14 =====
  check("LGPD §14 na seção pausadas: `NÃO sugerir`",
    blockA6.includes("NÃO sugerir"),
    blockA6);

  // ===== 12. Framing G-153-6 =====
  check("G-153-6 no cabeçalho: `NUNCA invente score`",
    /NUNCA invente/i.test(blockA6));

  // ===== 13. Isolamento cross-tenant =====
  const orgB = "org_B_" + randomUUID().slice(0, 6);
  db.prepare(
    `INSERT INTO organization_settings (id, organization_id, business_name, status, plan_id, billing_status)
     VALUES (?, ?, 'B', 'active', 'growth', 'active')`,
  ).run(randomUUID(), orgB);
  const blockB = ExecutiveAdvisorService.planRecommendationsBlock(orgB);
  check("cross-tenant: orgB NÃO cita nada de orgA",
    !blockB.includes("clinica") && !blockB.includes("scale") && !blockB.includes("rie"),
    blockB);
  check("cross-tenant: orgB cita seu próprio plano (Growth)",
    blockB.includes("Growth"),
    blockB);

  // ===== 14. buildPanorama inclui o bloco =====
  const panorama = ExecutiveAdvisorService.buildPanorama(orgA);
  check("buildPanorama inclui a seção 'PLANO E RECOMENDAÇÕES DE UPGRADE'",
    panorama.includes("PLANO E RECOMENDAÇÕES DE UPGRADE"));

  // ===== Resultado =====
  console.log("\n=== ExecutiveAdvisor.planRecommendationsBlock (F7.5) ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? "  (" + r.detail.slice(0, 200) + ")" : ""}`);
  console.log(`\n${results.length - failures}/${results.length} checks OK`);
  if (failures > 0) process.exit(1);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
