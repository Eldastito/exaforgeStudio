/**
 * TESTE — Module gating by plan + Radar auto-fill confidence 1.00 + Plan usage alerts
 * -----------------------------------------------------------------------
 * Cobre:
 *   1. PlanFeatures.modules: planos com lista de módulos restringem acesso
 *   2. ModuleService.isEnabled respeita restrição de plano (vertical liga, plano não → bloqueado)
 *   3. RadarService.autoFillFromMeasuredData: preenche respostas com dados medidos, confidence 1.00
 *   4. Auto-fill não sobrescreve respostas existentes
 *   5. PlanService.getUsageAlerts: retorna alertas quando uso >= 80/90/100% do limite
 *   6. Alertas vazios quando dentro dos limites
 *
 * Roda num banco TEMPORÁRIO. Uso: npm run test:plan-gating-autofill
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-plan-gating-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-plan-gating-1234567890abcdef";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { ModuleService } = await import("../src/server/ModuleService.js");
  const { PlanService } = await import("../src/server/PlanService.js");
  const { RadarService } = await import("../src/server/RadarService.js");

  function seedOrg(tag: string, planId?: string) {
    const orgId = `org_${tag}_${randomUUID().slice(0, 6)}`;
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, plan_id) VALUES (?, ?, ?, 'active', ?)`)
      .run(randomUUID(), orgId, `Empresa ${tag}`, planId || null);
    ModuleService.applyVertical(orgId, "outro");
    const mods = JSON.parse((db.prepare(`SELECT enabled_modules FROM organization_settings WHERE organization_id = ?`).get(orgId) as any).enabled_modules);
    ModuleService.setModules(orgId, [...mods, "radar"]);
    return orgId;
  }

  // ==== PART 1: Module gating by plan ====
  console.log('\n=== PART 1: Module gating by plan ===');

  const orgStarter = seedOrg("starter", "starter");
  const orgBusiness = seedOrg("business", "business");
  const orgNoPlan = seedOrg("noplan");

  const starterPlan = PlanService.getCurrentPlan(orgStarter);
  check("1.1 Starter plan has modules list", Array.isArray(starterPlan?.features?.modules), JSON.stringify(starterPlan?.features?.modules));

  const businessPlan = PlanService.getCurrentPlan(orgBusiness);
  check("1.2 Business plan has modules list", Array.isArray(businessPlan?.features?.modules), JSON.stringify(businessPlan?.features?.modules));

  check("1.3 Starter plan has fewer modules than Business",
    (starterPlan?.features?.modules?.length || 0) < (businessPlan?.features?.modules?.length || 0));

  check("1.4 Starter does NOT include radar",
    !(starterPlan?.features?.modules || []).includes("radar"));

  check("1.5 Business includes radar",
    (businessPlan?.features?.modules || []).includes("radar"));

  check("1.6 Business org can access radar (vertical + plan both allow)",
    ModuleService.isEnabled(orgBusiness, "radar"));

  check("1.7 Starter org CANNOT access radar (vertical allows, plan does NOT)",
    !ModuleService.isEnabled(orgStarter, "radar"));

  check("1.8 Starter org CAN access catalogo (in both vertical and plan)",
    ModuleService.isEnabled(orgStarter, "catalogo"));

  const noPlanModules = PlanService.modulesForPlan(orgNoPlan);
  check("1.9 Org without plan: modulesForPlan returns null (no restriction)",
    noPlanModules === null);

  check("1.10 Org without plan can access radar (enabled in vertical, no plan restriction)",
    ModuleService.isEnabled(orgNoPlan, "radar"));

  check("1.11 Core modules always accessible regardless of plan",
    ModuleService.isEnabled(orgStarter, "atendimento") && ModuleService.isEnabled(orgStarter, "contatos"));

  // Cortesia plan: no modules key = no restriction
  const orgCortesia = seedOrg("cortesia", "cortesia");
  const cortesiaPlan = PlanService.getCurrentPlan(orgCortesia);
  check("1.12 Cortesia plan has NO modules restriction",
    cortesiaPlan?.features?.modules === undefined || cortesiaPlan?.features?.modules === null);

  check("1.13 Cortesia org can access radar (no plan restriction)",
    ModuleService.isEnabled(orgCortesia, "radar"));

  // ==== PART 2: Radar auto-fill from measured data ====
  console.log('\n=== PART 2: Radar auto-fill from measured data ===');

  const orgWithData = seedOrg("withdata", "business");

  // Create a ConversionVelocity snapshot for the org
  db.prepare(`INSERT INTO radar_velocity_snapshots (id, organization_id, period_start, period_end, ivc_score, ivc_band,
    first_response_p50_seconds, first_response_p90_seconds, first_response_p95_seconds,
    sla_compliance_rate, out_of_hours_coverage_rate, followup_compliance_rate,
    conversion_traceability_rate, scoring_version, tickets_analyzed)
    VALUES (?, ?, datetime('now','-30 days'), datetime('now'), 72, 'controlada', 45, 120, 180, 0.85, 0.6, 0.72, 0.68, 1, 100)`)
    .run(randomUUID(), orgWithData);

  // Create RIE daily snapshots
  db.prepare(`INSERT INTO ric_daily_snapshots (id, organization_id, snapshot_date, iqr_score)
    VALUES (?, ?, date('now'), 65)`)
    .run(randomUUID(), orgWithData);

  for (let i = 1; i <= 10; i++) {
    db.prepare(`INSERT OR IGNORE INTO ric_daily_snapshots (id, organization_id, snapshot_date, iqr_score)
      VALUES (?, ?, date('now', '-' || ? || ' days'), ?)`)
      .run(randomUUID(), orgWithData, i, 60 + i);
  }

  // Add a channel
  db.prepare(`INSERT INTO channels (id, organization_id, provider, name, status) VALUES (?, ?, 'whatsapp', 'Canal teste', 'active')`)
    .run(randomUUID(), orgWithData);

  const template = (RadarService.listTemplates(orgWithData) as any[])[0];
  const session = RadarService.createSession(orgWithData, "actor", { templateId: template.id, companyName: "Empresa com dados" });

  const result = RadarService.autoFillFromMeasuredData(orgWithData, session.id, "actor");
  check("2.1 Auto-fill returns filled list", Array.isArray(result.filled) && result.filled.length > 0, JSON.stringify(result.filled));

  check("2.2 Auto-filled q_receita_tempo_resposta", result.filled.includes("q_receita_tempo_resposta"));
  check("2.3 Auto-filled q_receita_followup", result.filled.includes("q_receita_followup"));
  check("2.4 Auto-filled q_receita_conversao", result.filled.includes("q_receita_conversao"));
  check("2.5 Auto-filled q_receita_conversas_centralizadas", result.filled.includes("q_receita_conversas_centralizadas"));
  check("2.6 Auto-filled q_metricas_baseline", result.filled.includes("q_metricas_baseline"));
  check("2.7 Auto-filled q_metricas_acompanhamento", result.filled.includes("q_metricas_acompanhamento"));

  // Verify confidence = 1.00 on auto-filled answers
  const freshSession = RadarService.getSession(orgWithData, session.id);
  const autoAnswers = (freshSession.answers || []).filter((a: any) => a.source === 'measured');
  check("2.8 All auto-filled answers have confidence_multiplier = 1.00",
    autoAnswers.length > 0 && autoAnswers.every((a: any) => a.confidence_multiplier === 1.0),
    `count=${autoAnswers.length}, confidences=${autoAnswers.map((a: any) => a.confidence_multiplier).join(',')}`);

  // Test that auto-fill does NOT overwrite existing answers
  const full = RadarService.getTemplateWithQuestions(orgWithData, template.id) as any;
  const q1 = full.questions[0]; // q_estrategia_responsavel
  RadarService.saveAnswer(orgWithData, session.id, "actor", {
    questionId: q1.id, value: "3", isNotKnown: false, comment: "Manual answer"
  });

  // Try auto-fill again — should not overwrite
  const result2 = RadarService.autoFillFromMeasuredData(orgWithData, session.id, "actor");
  check("2.9 Second auto-fill returns empty (already filled)", result2.filled.length === 0);

  // Verify the manual answer was NOT overwritten
  const freshSession2 = RadarService.getSession(orgWithData, session.id);
  const q1Answer = (freshSession2.answers || []).find((a: any) => a.question_id === q1.id);
  check("2.10 Manual answer not overwritten by auto-fill",
    q1Answer && q1Answer.confidence_multiplier !== 1.0,
    `confidence=${q1Answer?.confidence_multiplier}`);

  // Test auto-fill on org without measured data
  const orgNoData = seedOrg("nodata", "business");
  const session2 = RadarService.createSession(orgNoData, "actor", { templateId: template.id, companyName: "Sem dados" });
  const result3 = RadarService.autoFillFromMeasuredData(orgNoData, session2.id, "actor");
  check("2.11 Auto-fill on org without measured data returns empty", result3.filled.length === 0);

  // ==== PART 3: Plan usage alerts ====
  console.log('\n=== PART 3: Plan usage alerts ===');

  const orgAlerts = seedOrg("alerts", "starter");
  const starterFeatures = PlanService.getCurrentPlan(orgAlerts)?.features;
  const aiLimit = starterFeatures?.ai_monthly_limit || 500;

  // Initially no alerts
  const alerts0 = PlanService.getUsageAlerts(orgAlerts);
  check("3.1 No alerts when usage is low", alerts0.length === 0);

  // Insert AI interactions to reach 85% of limit
  const target85 = Math.ceil(aiLimit * 0.85);
  for (let i = 0; i < target85; i++) {
    db.prepare(`INSERT INTO ai_interactions_log (id, organization_id, created_at) VALUES (?, ?, datetime('now'))`)
      .run(randomUUID(), orgAlerts);
  }
  const alerts85 = PlanService.getUsageAlerts(orgAlerts);
  const aiAlert85 = alerts85.find(a => a.key === 'ai');
  check("3.2 Warning alert at 85% AI usage", aiAlert85?.level === 'warning', `level=${aiAlert85?.level}, pct=${aiAlert85?.pct}`);

  // Add more to reach 95%
  const target95 = Math.ceil(aiLimit * 0.95) - target85;
  for (let i = 0; i < target95; i++) {
    db.prepare(`INSERT INTO ai_interactions_log (id, organization_id, created_at) VALUES (?, ?, datetime('now'))`)
      .run(randomUUID(), orgAlerts);
  }
  const alerts95 = PlanService.getUsageAlerts(orgAlerts);
  const aiAlert95 = alerts95.find(a => a.key === 'ai');
  check("3.3 Critical alert at 95% AI usage", aiAlert95?.level === 'critical', `level=${aiAlert95?.level}, pct=${aiAlert95?.pct}`);

  // Add more to reach 100%+
  const remaining = aiLimit - Math.ceil(aiLimit * 0.95);
  for (let i = 0; i < remaining + 5; i++) {
    db.prepare(`INSERT INTO ai_interactions_log (id, organization_id, created_at) VALUES (?, ?, datetime('now'))`)
      .run(randomUUID(), orgAlerts);
  }
  const alerts100 = PlanService.getUsageAlerts(orgAlerts);
  const aiAlert100 = alerts100.find(a => a.key === 'ai');
  check("3.4 Exceeded alert at 100%+ AI usage", aiAlert100?.level === 'exceeded', `level=${aiAlert100?.level}, pct=${aiAlert100?.pct}`);

  // Test alerts for org without plan (should be empty)
  const alertsNoPlan = PlanService.getUsageAlerts(orgNoPlan);
  check("3.5 No alerts for org without plan", alertsNoPlan.length === 0);

  // ---- Summary ----
  console.log("\n──── Resultados ────");
  for (const r of results) {
    console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.detail ? ` [${r.detail}]` : ""}`);
  }
  console.log(`\n${results.length} verificações, ${failures} falha(s).`);
  process.exit(failures > 0 ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
