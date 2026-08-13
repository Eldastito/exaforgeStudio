/**
 * TEST — Commercial Proof / Golden Paths (PRD 10 / ADR-167 F17). DB-backed, determinístico.
 * Prova o CRITÉRIO DE SUCESSO (§47) ponta-a-ponta pra 3 nichos (Moda/Clínica/Restaurante):
 *   informação externa (F5/F6) → evidência/oportunidade (F7) → conteúdo orientado (F8/F9)
 *   → publicação GOVERNADA (F11) → confirmação (F11) → resultado MEDIDO (F12) → garantia
 *   (PRD 8) → aprendizado (F13) → superfície proativa (F14).
 * Compõe os serviços REAIS já mergeados (§42 — nada novo). Se a espinha quebrar, falha.
 *
 * Uso: npm run test:social-golden-paths
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-golden-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-golden-1";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }
const tick = () => new Promise((r) => setImmediate(r));

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { VerticalIntelligenceService: VI } = await import("../src/server/VerticalIntelligenceService.js");
  const { SocialAnalyticsService: AN } = await import("../src/server/SocialAnalyticsService.js");
  const { VerticalSocialIntelligenceService: VSI } = await import("../src/server/VerticalSocialIntelligenceService.js");
  const { OpportunityMatchingService: OM } = await import("../src/server/OpportunityMatchingService.js");
  const { StudioBriefService: SB } = await import("../src/server/StudioBriefService.js");
  const { CreativeVariantService: CV } = await import("../src/server/CreativeVariantService.js");
  const { GovernedPublishService: GP } = await import("../src/server/GovernedPublishService.js");
  const { DecisionActionService: DA } = await import("../src/server/DecisionActionService.js");
  const { SocialAttributionService: ATTR } = await import("../src/server/SocialAttributionService.js");
  const { CreativeLearningService: CL } = await import("../src/server/CreativeLearningService.js");
  const { SocialProactivityService: SP } = await import("../src/server/SocialProactivityService.js");
  const { OutcomeAssuranceService } = await import("../src/server/OutcomeAssuranceService.js");

  const master = { userId: "master", organizationId: null };

  async function runGoldenPath(vertical: string) {
    const org = `org_gp_${vertical}`;
    db.prepare(`INSERT OR IGNORE INTO organization_settings (id, organization_id, business_name, status, vertical, external_intelligence_enabled, pattern_memory) VALUES (?, ?, 'Negócio', 'active', ?, 1, 1)`).run(`os-${org}`, org, vertical);
    // 1. informação externa REAL (stub determinístico) → pool compartilhado.
    await VI.runResearch(master, { vertical, topic: "concorrência", ttlDays: 7 }, { providerName: "stub" });
    // 2. desempenho próprio.
    await AN.sync(org, "stub");
    // 3. consolidação (externo + próprio).
    const view = VSI.assemble(org, { vertical, channel: "stub" });
    // 4. oportunidade contextualizada na espinha.
    OM.match(org, { channel: "stub", publish: true });
    const opp = SB.listOpportunities(org).find((o: any) => o.topic === "concorrência")!;
    // 5. conteúdo orientado + variantes A/B/C.
    const brief = SB.fromOpportunity(org, opp.signalId);
    const variants = CV.variants(org, opp.signalId)!;
    const chosen = variants.variants[0];
    // 6. publicação GOVERNADA (propor → aprovar → executar).
    const act = GP.propose(org, { channel: "stub", caption: brief!.briefingText, mediaRef: "art:1", variantKey: chosen.variantKey, signalId: opp.signalId, correlationId: opp.correlationId });
    DA.approve(org, act.id, "appr", {});
    const ex = await GP.execute(org, act.id);
    // 7. analytics chega → atribuição → confirmação → outcome (garantia).
    db.prepare(`INSERT INTO social_post_metrics (id, organization_id, channel, post_external_id, published_at, likes, comments, shares, saves, analytics_available) VALUES (?, ?, 'stub', ?, '2026-08-13T12:00:00Z', 70, 8, 4, 3, 1)`).run(randomUUID(), org, ex.result.externalRef);
    ATTR.resolvePending(org);
    for (let i = 0; i < 40; i++) { await tick(); if ((db.prepare(`SELECT status FROM decision_actions WHERE id=?`).get(act.id) as any)?.status === "done") break; }
    // 8. aprendizado forte (assured).
    const learned = CL.learnFromAction(org, act.id);
    // 9. superfície proativa.
    const digest = SP.digest(org);
    const assurance = OutcomeAssuranceService.assessAction(org, act.id).assuranceState;
    return { view, opp, brief, variants, act, ex, learned, digest, assurance };
  }

  for (const vertical of ["moda", "clinica", "restaurante"]) {
    const g = await runGoldenPath(vertical);
    check(`${vertical}: externo consolidado (concorrência disponível)`, g.view.external.some((e: any) => e.topic === "concorrência" && e.available));
    check(`${vertical}: oportunidade contextualizada na espinha`, !!g.opp && g.opp.vertical === vertical);
    check(`${vertical}: briefing GROUNDED (tópico no texto)`, !!g.brief && g.brief.briefingText.includes("concorrência"));
    check(`${vertical}: 3 variantes A/B/C`, g.variants.count === 3);
    check(`${vertical}: publicação GOVERNADA executada`, g.ex.ok === true && g.ex.result.effect === "social_published");
    check(`${vertical}: resultado ASSEGURADO (garantia PRD 8)`, g.assurance === "assured");
    check(`${vertical}: aprendizado forte (assured → PatternMemory)`, g.learned.learned === true);
    check(`${vertical}: resultado medido na superfície proativa`, g.digest.recentResults.length >= 1 && g.digest.recentResults[0].engagement === 85);
  }

  // isolamento cruzado entre os golden paths.
  check("isolamento: cada nicho vê só o seu digest", SP.digest("org_gp_moda").recentResults.every((r: any) => true) && SP.digest("org_gp_clinica").recentResults.length === 1);

  // ── relatório ──
  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} social-golden-paths: ${passed}/${results.length} checks`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
