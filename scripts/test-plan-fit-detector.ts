/**
 * TEST — Fatia 7.1 + 7.2 (ADR-153): PlanFitDetectorService + PlanFitSignalPublisher.
 *
 * F7.1 entregou near_limit (ai/contacts/channels/users) com severity determinística.
 * F7.2 ADICIONA:
 *   - Score 0-100 em 6 dimensões (PRD §14).
 *   - `impactAmount` em BRL/mês (3× diff de preço = payback conservador).
 *   - Threshold DURO: score < 60 → NÃO publica.
 *   - Novo detector `plan_module_gap` (org tem blueprint mas plano não cobre).
 *   - `evidence.scoreBreakdown` completo pra card explicar.
 *
 * Cobre F7.1 + F7.2:
 *   1. Detector: uso < 80% não gera candidato.
 *   2. Detector: uso ≥ 100 gera severity=critical.
 *   3. Detector: uso 95% gera severity=risk.
 *   4. Detector: 4 métricas near_limit detectadas independentemente.
 *   5. Detector: `targetPlanId` aponta pro tier superior.
 *   6. Detector: Enterprise (limit=0) NÃO dispara.
 *   7. Detector: plano 'cortesia' NÃO dispara.
 *   8. Detector: billing_status blocked/past_due NÃO dispara.
 *   9. Detector: org soft-deleted NÃO dispara.
 *  10. F7.2: candidato publicado tem score ≥ 60.
 *  11. F7.2: evidence.scoreBreakdown com todas 6 dimensões.
 *  12. F7.2: soma das 6 dimensões == total.
 *  13. F7.2: impactAmount em BRL populated pra upgrade viável.
 *  14. F7.2: score baixo (attention mas near threshold) NÃO publica.
 *  15. F7.2: plan_module_gap — blueprint required não coberto pelo plano → sinal.
 *  16. F7.2: plan_module_gap: severity=attention (required) ou info (optional).
 *  17. F7.2: plan_module_gap: dedupeKey inclui moduleKey.
 *  18. F7.2: plan_module_gap: evidence.moduleKey + upgradeTargetPlan populated.
 *  19. F7.2: plan_module_gap: cap 3 sinais de gap por org.
 *  20. F7.2: sem blueprint → 0 sinais de module_gap.
 *  21. Publisher: publica sinal em `business_signals` domain='plan'.
 *  22. Publisher: dedupe_key mensal.
 *  23. Publisher: sinal stale → resolved.
 *  24. Publisher: premises inclui scoreThreshold + scoreTotal.
 *  25. Publisher: plan_module_gap dedupe/resolve funciona.
 *  26. Publisher: runAll skipa cortesia + blocked.
 *  27. Isolamento cross-tenant.
 *  28. ImpactPrioritizationService: plan_module_gap → propose_upgrade.
 *  29. STRATEGIC['plan'] domain aparece em prioritize.
 *
 * Uso: npm run test:plan-fit-detector
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-planfit-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-secret-planfit-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; note?: string }[] = [];
function check(name: string, ok: boolean, note?: string) {
  results.push({ name, ok, note });
  if (!ok) failures++;
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  await new Promise((r) => setTimeout(r, 300)); // aguarda seed auto (blueprints)
  const { PlanFitDetectorService } = await import("../src/server/PlanFitDetectorService.js");
  const { PlanFitSignalPublisher } = await import("../src/server/PlanFitSignalPublisher.js");
  const { BusinessSignalService } = await import("../src/server/BusinessSignalService.js");
  const { ImpactPrioritizationService } = await import("../src/server/ImpactPrioritizationService.js");
  const { VerticalBlueprintService } = await import("../src/server/VerticalBlueprintService.js");
  const { applyPlanGrade } = await import("../src/server/plansGrade.js");

  applyPlanGrade(db);

  // ── Setup orgs ──
  // orgA: start, AI 95% → risk (score ~71)
  // orgB: start, AI 30% → nada
  // orgC: start, AI 95% + contacts 105% → 2 sinais (risk + critical)
  // orgD: start, saude+blueprint clinica → plan_module_gap
  // orgLowScore: start, AI ~82% → severity=attention mas score < 60 → NÃO publica
  // orgEnterprise: enterprise, uso alto (limit=0 = ilimitado) → nada
  // orgCortesia, orgBlocked, orgDel → skipa (política F7.1)
  const orgA = `org_${randomUUID().slice(0, 8)}`;
  const orgB = `org_${randomUUID().slice(0, 8)}`;
  const orgC = `org_${randomUUID().slice(0, 8)}`;
  const orgD = `org_${randomUUID().slice(0, 8)}`;
  const orgLowScore = `org_${randomUUID().slice(0, 8)}`;
  const orgEnterprise = `org_${randomUUID().slice(0, 8)}`;
  const orgCortesia = `org_${randomUUID().slice(0, 8)}`;
  const orgBlocked = `org_${randomUUID().slice(0, 8)}`;
  const orgDel = `org_${randomUUID().slice(0, 8)}`;

  const insertOrg = (id: string, plan: string, billing: string, deleted = false, vertical: string | null = null) => {
    db.prepare(
      `INSERT INTO organization_settings (id, organization_id, business_name, status, plan_id, billing_status, vertical, deleted_at)
       VALUES (?, ?, ?, 'active', ?, ?, ?, ${deleted ? "CURRENT_TIMESTAMP" : "NULL"})`,
    ).run(randomUUID(), id, `Org-${id.slice(0, 5)}`, plan, billing, vertical);
  };

  insertOrg(orgA, "start", "active");
  insertOrg(orgB, "start", "active");
  insertOrg(orgC, "start", "active");
  insertOrg(orgD, "start", "active", false, "saude");
  insertOrg(orgLowScore, "start", "active");
  insertOrg(orgEnterprise, "enterprise", "active");
  insertOrg(orgCortesia, "cortesia", "active");
  insertOrg(orgBlocked, "start", "blocked");
  insertOrg(orgDel, "start", "active", true);

  // Helpers de uso (start = ai 3000, contacts 3000, channels 1, users 2).
  const insertAi = (orgId: string, n: number) => {
    for (let i = 0; i < n; i++) {
      db.prepare(`INSERT INTO ai_interactions_log (id, organization_id, agent_used, created_at) VALUES (?, ?, 'test', CURRENT_TIMESTAMP)`).run(randomUUID(), orgId);
    }
  };
  const insertContacts = (orgId: string, n: number) => {
    // 1 canal DESABILITADO só pra satisfazer FK — não conta em getUsage.channels.
    const chId = randomUUID();
    db.prepare(`INSERT INTO channels (id, organization_id, provider, name, identifier, status) VALUES (?, ?, 'whatsapp', 'x', ?, 'disabled')`).run(chId, orgId, `ch_test_${orgId.slice(0, 6)}`);
    for (let i = 0; i < n; i++) {
      db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, identifier) VALUES (?, ?, ?, ?)`).run(randomUUID(), orgId, chId, `55119${i}${orgId.slice(0, 3)}`);
    }
  };

  insertAi(orgA, 2850);               // 95% → risk, score ~71
  insertAi(orgB, 900);                // 30% → 0
  insertAi(orgC, 2850);               // 95% → risk, score ~71
  insertContacts(orgC, 3150);         // 105% → critical, score ~84
  insertAi(orgD, 900);                // 30% → 0 near_limit (para isolar module_gap)
  insertAi(orgLowScore, 2460);        // 82% → attention MAS score < 60 (rec=5, nec=1, uso=2)
  insertAi(orgEnterprise, 100000);    // qualquer coisa — limit=0

  // Assinala blueprint 'clinica_multiespecialidades' a orgD (auto-seedado).
  const clinicaBp = VerticalBlueprintService.getLatestPublished("clinica_multiespecialidades");
  check("blueprint clinica_multiespecialidades foi seedado", !!clinicaBp);
  if (clinicaBp) {
    VerticalBlueprintService.assignToOrganization(orgD, clinicaBp.id, null);
  }

  // ===== 1-4. Detector regras F7.1 =====
  const candA = PlanFitDetectorService.detect(orgA);
  check("orgA: detecta 1 candidato AI (95%)", candA.length === 1);
  check("orgA: severity=risk (95%)", candA[0]?.severity === "risk");
  check("orgA: signalType=plan_near_limit_ai", candA[0]?.signalType === "plan_near_limit_ai");

  const candB = PlanFitDetectorService.detect(orgB);
  check("orgB: uso 30% → 0 candidatos", candB.length === 0);

  const candC = PlanFitDetectorService.detect(orgC);
  check("orgC: 2 candidatos (AI risk + contacts critical)", candC.length === 2);
  const aiC = candC.find((c) => c.metric === "ai");
  const ctC = candC.find((c) => c.metric === "contacts");
  check("orgC: AI severity=risk (95%)", aiC?.severity === "risk");
  check("orgC: contacts severity=critical (>=100%)", ctC?.severity === "critical");

  // ===== 5. targetPlanId =====
  check("orgA (start): targetPlanId aponta pra tier superior (growth+)",
    candA[0]?.targetPlanId != null && ["growth", "scale", "enterprise"].includes(candA[0].targetPlanId));

  // ===== 6. Enterprise limit=0 → 0 candidatos near_limit =====
  const candEnt = PlanFitDetectorService.detect(orgEnterprise);
  check("enterprise: 100k uso mas limit=0 → 0 candidatos near_limit",
    candEnt.filter((c) => c.signalType.startsWith("plan_near_limit_")).length === 0);

  // ===== 7. cortesia NÃO dispara =====
  const candCort = PlanFitDetectorService.detect(orgCortesia);
  check("cortesia: 0 candidatos (regra política)", candCort.length === 0);

  // ===== 8. billing blocked NÃO dispara =====
  const candBlocked = PlanFitDetectorService.detect(orgBlocked);
  check("blocked: 0 candidatos (LGPD §15)", candBlocked.length === 0);
  db.prepare(`UPDATE organization_settings SET billing_status='past_due' WHERE organization_id = ?`).run(orgA);
  const candAPastDue = PlanFitDetectorService.detect(orgA);
  check("past_due: 0 candidatos (mesma regra)", candAPastDue.length === 0);
  db.prepare(`UPDATE organization_settings SET billing_status='active' WHERE organization_id = ?`).run(orgA);

  // ===== 9. soft-deleted NÃO dispara =====
  const candDel = PlanFitDetectorService.detect(orgDel);
  check("soft-deleted: 0 candidatos", candDel.length === 0);

  // ===== 10. F7.2 — score ≥ 60 em todos os publicados =====
  check("orgA candidato score >= 60 (threshold PRD §14)", (candA[0]?.score ?? 0) >= 60);
  const allScoresAboveThreshold = candC.every((c) => c.score >= 60);
  check("orgC todos candidatos score >= 60", allScoresAboveThreshold);

  // ===== 11. F7.2 — scoreBreakdown com 6 dimensões =====
  const bd = candA[0]?.evidence.scoreBreakdown;
  check("evidence.scoreBreakdown existe", !!bd);
  const dims = ["necessidade_operacional", "uso_proximo_limite", "ganho_financeiro_provavel", "recorrencia_necessidade", "adequacao_vertical", "confianca_dados", "total"] as const;
  const allDims = bd && dims.every((k) => typeof (bd as any)[k] === "number");
  check("scoreBreakdown tem todas 6 dimensões + total", !!allDims);

  // ===== 12. F7.2 — soma das dimensões == total (dentro de arredondamento) =====
  if (bd) {
    const soma = bd.necessidade_operacional + bd.uso_proximo_limite + bd.ganho_financeiro_provavel
      + bd.recorrencia_necessidade + bd.adequacao_vertical + bd.confianca_dados;
    // permite ±1 pra arredondamento (Math.round por dimensão vs total)
    check("scoreBreakdown soma consistente com total (±2)", Math.abs(soma - bd.total) <= 2);
  }

  // ===== 13. F7.2 — impactAmount em BRL populated =====
  check("orgA: impactAmount > 0 (uplift BRL)", (candA[0]?.impactAmount ?? 0) > 0);
  check("orgA: impactUnit = 'BRL'", candA[0]?.impactUnit === "BRL");
  // start→growth = (1797-597)*3 = 3600
  check("orgA: impactAmount = 3600 (start→growth × 3)", candA[0]?.impactAmount === 3600);

  // ===== 14. F7.2 — score baixo (attention perto de 80%) NÃO publica =====
  const candLow = PlanFitDetectorService.detect(orgLowScore);
  check("orgLowScore (82%, sem blueprint): score baixo → 0 candidatos publicados",
    candLow.length === 0,
    `esperado 0 (threshold 60); recebi ${candLow.length}${candLow[0] ? " score=" + candLow[0].score : ""}`);

  // ===== 15-19. F7.2 — plan_module_gap =====
  const candD = PlanFitDetectorService.detect(orgD);
  const gaps = candD.filter((c) => c.signalType === "plan_module_gap");
  check("orgD (start + blueprint clinica): tem plan_module_gap sinais",
    gaps.length >= 1,
    `recebi ${gaps.length} gaps`);
  check("orgD: plan_module_gap cap ≤ 3 sinais por org (RN-153-F7.2-002)",
    gaps.length <= 3);
  // required modules do clinica_multiespecialidades que NÃO estão em start:
  //   assinaturas (growth), cadencias (growth), rie (scale), clinica (enterprise)
  // → 4 gaps required, mas cap 3.
  check("orgD: gaps ordenados por score (top primeiro)",
    gaps.length < 2 || gaps[0].score >= gaps[gaps.length - 1].score);

  // severity: required=attention, optional=info
  const gap0 = gaps[0];
  check("orgD: gap[0] severity ∈ {attention, info}",
    !!gap0 && (gap0.severity === "attention" || gap0.severity === "info"));
  check("orgD: gap[0] evidence.moduleKey populated",
    typeof gap0?.evidence.moduleKey === "string" && gap0.evidence.moduleKey.length > 0);
  check("orgD: gap[0] evidence.upgradeTargetPlan populated",
    typeof gap0?.evidence.upgradeTargetPlan === "string");
  check("orgD: gap[0] dedupeKey inclui moduleKey",
    gap0?.dedupeKey.includes(`module_gap:${gap0?.evidence.moduleKey}`) === true);
  check("orgD: gap[0] evidence.blueprintKey = clinica_multiespecialidades",
    gap0?.evidence.blueprintKey === "clinica_multiespecialidades");
  check("orgD: gap[0] impactAmount populated (BRL)",
    (gap0?.impactAmount ?? 0) > 0 && gap0?.impactUnit === "BRL");

  // ===== 20. F7.2 — org SEM blueprint → 0 sinais de module_gap =====
  const gapsA = candA.filter((c) => c.signalType === "plan_module_gap");
  check("orgA (sem blueprint): 0 plan_module_gap", gapsA.length === 0);

  // ===== 21. Publisher publica em business_signals =====
  const pubA = PlanFitSignalPublisher.run(orgA);
  check("publisher orgA: published=1, deduped=0", pubA.published === 1 && pubA.deduped === 0);
  const signalsA = BusinessSignalService.list(orgA, { domain: "plan", status: "open" });
  check("orgA tem sinal aberto em business_signals", signalsA.length === 1);
  check("sinal orgA: signal_type=plan_near_limit_ai", signalsA[0].signal_type === "plan_near_limit_ai");
  check("sinal orgA: severity=risk", signalsA[0].severity === "risk");
  check("sinal orgA: basis=fact", signalsA[0].basis === "fact");
  check("sinal orgA: source_service=PlanFitSignalPublisher", signalsA[0].source_service === "PlanFitSignalPublisher");
  check("sinal orgA: evidence.pctInt = 95", signalsA[0].evidence?.pctInt === 95);
  check("sinal orgA: evidence.scoreBreakdown existe (F7.2)", !!signalsA[0].evidence?.scoreBreakdown);
  check("sinal orgA: impact_amount em BRL populated (F7.2)",
    Number(signalsA[0].impact_amount) > 0 && signalsA[0].impact_unit === "BRL");
  check("sinal orgA: premises.scoreThreshold = 60 (F7.2)",
    signalsA[0].premises?.scoreThreshold === 60);
  check("sinal orgA: premises.scoreTotal presente (F7.2)",
    typeof signalsA[0].premises?.scoreTotal === "number");

  // ===== 22. dedupe mensal =====
  const pubA2 = PlanFitSignalPublisher.run(orgA);
  check("publisher orgA 2ª rodada: deduped=1 (mesmo mês)", pubA2.deduped === 1 && pubA2.published === 0);
  const signalsA2 = BusinessSignalService.list(orgA, { domain: "plan", status: "open" });
  check("orgA ainda tem 1 sinal (não duplicou)", signalsA2.length === 1);

  // ===== 23. sinal stale → resolved =====
  // orgC: publica AI+contacts, depois remove uso AI → AI resolves.
  const pubCBefore = PlanFitSignalPublisher.run(orgC);
  check("orgC 1ª rodada: publica 2 sinais AI+contacts",
    pubCBefore.published + pubCBefore.deduped === 2);
  // Deleta AI abaixo de 80% (deixa 350 rows = ~11.6%)
  db.prepare(`DELETE FROM ai_interactions_log WHERE organization_id = ? AND id IN (SELECT id FROM ai_interactions_log WHERE organization_id = ? LIMIT 2500)`).run(orgC, orgC);
  const pubCAfter = PlanFitSignalPublisher.run(orgC);
  check("orgC 2ª rodada (uso AI caiu): AI é resolved", pubCAfter.resolved >= 1);
  const signalsCOpen = BusinessSignalService.list(orgC, { domain: "plan", status: "open" });
  check("orgC: só contacts continua aberto",
    signalsCOpen.length === 1 && signalsCOpen[0].signal_type === "plan_near_limit_contacts");

  // ===== 24. premises threshold + scoreTotal (já testado acima, redundante para clareza) =====
  // OK

  // ===== 25. Publisher — plan_module_gap: publica, dedupe, resolve =====
  const pubD = PlanFitSignalPublisher.run(orgD);
  check("publisher orgD: publica ≥1 plan_module_gap", pubD.published >= 1);
  const signalsD = BusinessSignalService.list(orgD, { domain: "plan", status: "open" });
  const gapSignals = signalsD.filter((s: any) => s.signal_type === "plan_module_gap");
  check("orgD tem ≥1 sinal plan_module_gap aberto", gapSignals.length >= 1);
  check("orgD gap sinal: evidence.moduleKey populated",
    typeof gapSignals[0]?.evidence?.moduleKey === "string");
  check("orgD gap sinal: impact_amount em BRL",
    Number(gapSignals[0]?.impact_amount) > 0 && gapSignals[0]?.impact_unit === "BRL");
  const pubD2 = PlanFitSignalPublisher.run(orgD);
  check("publisher orgD 2ª rodada: gap deduped (mesmo mês)", pubD2.deduped >= 1);

  // Resolve: se removermos o blueprint, os gaps caem do set válido → resolved.
  db.prepare(`DELETE FROM organization_blueprints WHERE organization_id = ?`).run(orgD);
  const pubDNoBp = PlanFitSignalPublisher.run(orgD);
  check("orgD sem blueprint: gap signals são resolved", pubDNoBp.resolved >= 1);
  const signalsDAfter = BusinessSignalService.list(orgD, { domain: "plan", status: "open" });
  const gapsDAfter = signalsDAfter.filter((s: any) => s.signal_type === "plan_module_gap");
  check("orgD após remover blueprint: 0 plan_module_gap abertos", gapsDAfter.length === 0);

  // ===== 26. runAll skipa cortesia + blocked =====
  const runAll = PlanFitSignalPublisher.runAll();
  check("runAll: orgsSeen inclui só actives non-cortesia/blocked",
    runAll.orgsSeen >= 4 && runAll.orgsSeen <= 6);
  const cortSignals = BusinessSignalService.list(orgCortesia, { domain: "plan", status: "open" });
  check("cortesia: 0 sinais (skipada)", cortSignals.length === 0);
  const blockedSignals = BusinessSignalService.list(orgBlocked, { domain: "plan", status: "open" });
  check("blocked: 0 sinais (skipada)", blockedSignals.length === 0);

  // ===== 27. Cross-tenant =====
  const signalsB = BusinessSignalService.list(orgB, { domain: "plan", status: "open" });
  check("orgB (uso baixo): 0 sinais", signalsB.length === 0);
  const signalsAFinal = BusinessSignalService.list(orgA, { domain: "plan", status: "open" });
  check("orgA intocado após ações em orgC/orgD", signalsAFinal.length === 1);

  // ===== 28. ImpactPrioritizationService — action mapping =====
  const actionAi = ImpactPrioritizationService.actionFor("plan_near_limit_ai");
  check("actionFor(plan_near_limit_ai).actionType = propose_upgrade",
    actionAi.actionType === "propose_upgrade");
  const actionGap = ImpactPrioritizationService.actionFor("plan_module_gap");
  check("actionFor(plan_module_gap).actionType = propose_upgrade (F7.2)",
    actionGap.actionType === "propose_upgrade");
  check("actionFor(plan_module_gap) tem label", actionGap.label.length > 0);

  // ===== 29. STRATEGIC['plan'] — prioritize inclui domain=plan =====
  const prio = ImpactPrioritizationService.prioritize(orgA, {});
  const hasPlan = prio.global.some((p: any) => p.domain === "plan");
  check("prioritize inclui sinal domain='plan' no top-N global", hasPlan);

  // ===== Resultado =====
  console.log("\n=== PlanFitDetector + Publisher (F7.1 + F7.2) ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.note ? "  (" + r.note + ")" : ""}`);
  console.log(`\n${results.length - failures}/${results.length} checks OK`);
  if (failures > 0) process.exit(1);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
