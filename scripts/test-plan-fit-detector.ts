/**
 * TEST — Fatia 7.1 (ADR-153): PlanFitDetectorService + PlanFitSignalPublisher.
 *
 * Cobre o motor de detecção do "plano perto do teto" + publisher (sweep +
 * resolve). Aditivo puro — nenhum ação executada, só sinal.
 *
 * Cobre:
 *   1. Detector: uso < 80% não gera candidato.
 *   2. Detector: uso ∈ [80, 90) gera severity=attention.
 *   3. Detector: uso ∈ [90, 100) gera severity=risk.
 *   4. Detector: uso ≥ 100 gera severity=critical.
 *   5. Detector: 4 métricas (ai, contacts, channels, users) detectadas
 *      independentemente.
 *   6. Detector: `targetPlanId` aponta pro tier superior que aumenta o limite.
 *   7. Detector: Enterprise (limit=0) NÃO dispara (ilimitado).
 *   8. Detector: plano 'cortesia' NÃO dispara.
 *   9. Detector: billing_status blocked/cancelled/past_due NÃO dispara.
 *  10. Detector: org soft-deleted NÃO dispara.
 *  11. Publisher: publica sinal em `business_signals` domain='plan'.
 *  12. Publisher: dedupe_key mensal (2× no mesmo mês não duplica).
 *  13. Publisher: sinal stale (uso caiu) é resolved.
 *  14. Publisher: evidence + premises preenchidos.
 *  15. Publisher: runAll skipa cortesia + blocked/etc.
 *  16. Isolamento cross-tenant.
 *  17. ImpactPrioritizationService.actionFor mapeia pra 'propose_upgrade'.
 *  18. STRATEGIC['plan'] > STRATEGIC_DEFAULT (peso adequado).
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
  await new Promise((r) => setTimeout(r, 200)); // aguarda seed auto
  const { PlanFitDetectorService } = await import("../src/server/PlanFitDetectorService.js");
  const { PlanFitSignalPublisher } = await import("../src/server/PlanFitSignalPublisher.js");
  const { BusinessSignalService } = await import("../src/server/BusinessSignalService.js");
  const { ImpactPrioritizationService } = await import("../src/server/ImpactPrioritizationService.js");
  const { applyPlanGrade } = await import("../src/server/plansGrade.js");

  applyPlanGrade(db);

  // ── Setup 6 orgs ──
  // Ativas em vários planos com diferentes níveis de uso.
  const orgA = `org_${randomUUID().slice(0, 8)}`;  // start, alto uso AI (95%) — risk
  const orgB = `org_${randomUUID().slice(0, 8)}`;  // start, uso baixo (30%) — nada
  const orgC = `org_${randomUUID().slice(0, 8)}`;  // start, uso 85% AI + 105% contacts — attention + critical
  const orgEnterprise = `org_${randomUUID().slice(0, 8)}`; // enterprise, uso alto — mas limit=0 → nada
  const orgCortesia = `org_${randomUUID().slice(0, 8)}`;   // cortesia — skip
  const orgBlocked = `org_${randomUUID().slice(0, 8)}`;    // blocked billing — skip
  const orgDel = `org_${randomUUID().slice(0, 8)}`;        // soft-deleted — skip

  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, plan_id, billing_status) VALUES (?, ?, 'Org A', 'active', 'start', 'active')`).run(randomUUID(), orgA);
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, plan_id, billing_status) VALUES (?, ?, 'Org B', 'active', 'start', 'active')`).run(randomUUID(), orgB);
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, plan_id, billing_status) VALUES (?, ?, 'Org C', 'active', 'start', 'active')`).run(randomUUID(), orgC);
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, plan_id, billing_status) VALUES (?, ?, 'Ent', 'active', 'enterprise', 'active')`).run(randomUUID(), orgEnterprise);
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, plan_id, billing_status) VALUES (?, ?, 'Cortesia', 'active', 'cortesia', 'active')`).run(randomUUID(), orgCortesia);
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, plan_id, billing_status) VALUES (?, ?, 'Blocked', 'active', 'start', 'blocked')`).run(randomUUID(), orgBlocked);
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, plan_id, billing_status, deleted_at) VALUES (?, ?, 'Del', 'inactive', 'start', 'active', CURRENT_TIMESTAMP)`).run(randomUUID(), orgDel);

  // Seed AI usage. Plan Start = ai_monthly_limit 3000, contacts 3000, channels 1, users 2.
  const insertAi = (orgId: string, n: number) => {
    for (let i = 0; i < n; i++) {
      db.prepare(`INSERT INTO ai_interactions_log (id, organization_id, agent_used, created_at) VALUES (?, ?, 'test', CURRENT_TIMESTAMP)`).run(randomUUID(), orgId);
    }
  };
  const insertContact = (orgId: string, n: number) => {
    // Um único canal DESABILITADO (status='disabled') — necessário porque
    // contacts.channel_id é NOT NULL, mas 'disabled' não conta em
    // PlanService.getUsage.channels (só canais != disabled contam). Assim
    // o teste isola a métrica CONTATOS sem disparar plan_near_limit_channels.
    const chId = randomUUID();
    db.prepare(`INSERT INTO channels (id, organization_id, provider, name, identifier, status) VALUES (?, ?, 'whatsapp', 'x', ?, 'disabled')`).run(chId, orgId, `ch_test_${orgId.slice(0, 6)}`);
    for (let i = 0; i < n; i++) {
      db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, identifier) VALUES (?, ?, ?, ?)`).run(randomUUID(), orgId, chId, `55119${i}${orgId.slice(0, 3)}`);
    }
  };
  const insertUsers = (orgId: string, n: number) => {
    for (let i = 0; i < n; i++) {
      db.prepare(`INSERT INTO users (id, organization_id, email, global_status) VALUES (?, ?, ?, 'active')`).run(randomUUID(), orgId, `u${i}@${orgId}.com`);
    }
  };

  // orgA: 2850 AI usage (95% de 3000) → risk
  insertAi(orgA, 2850);
  // orgB: 900 AI (30%) → nada
  insertAi(orgB, 900);
  // orgC: 2550 AI (85%) → attention + 3150 contatos (105%) → critical
  insertAi(orgC, 2550);
  insertContact(orgC, 3150);
  // orgEnterprise: 100k AI, mas limit=0 → nada
  insertAi(orgEnterprise, 100000);

  // ===== 1-4. Detector regras de severity =====
  const candA = PlanFitDetectorService.detect(orgA);
  check("orgA: detecta 1 candidato AI (95%)", candA.length === 1);
  check("orgA: severity=risk (95%)", candA[0]?.severity === "risk");
  check("orgA: signalType=plan_near_limit_ai", candA[0]?.signalType === "plan_near_limit_ai");

  const candB = PlanFitDetectorService.detect(orgB);
  check("orgB: uso 30% → 0 candidatos", candB.length === 0);

  const candC = PlanFitDetectorService.detect(orgC);
  check("orgC: 2 candidatos (AI attention + contacts critical)", candC.length === 2);
  const aiC = candC.find((c) => c.metric === "ai");
  const ctC = candC.find((c) => c.metric === "contacts");
  check("orgC: AI severity=attention (85%)", aiC?.severity === "attention");
  check("orgC: contacts severity=critical (>=100%)", ctC?.severity === "critical");

  // ===== 5. Independência entre métricas =====
  // orgA tem AI alto mas contacts baixo — só AI dispara
  check("orgA: só AI (não contacts/channels/users)", candA.every((c) => c.metric === "ai"));

  // ===== 6. targetPlanId =====
  check("orgA (start): targetPlanId aponta pra tier superior (growth ou mais)",
    candA[0]?.targetPlanId != null && ["growth", "scale", "enterprise"].includes(candA[0].targetPlanId));

  // ===== 7. Enterprise (limit=0 = ilimitado) NÃO dispara =====
  const candEnt = PlanFitDetectorService.detect(orgEnterprise);
  check("enterprise: 100k uso mas limit=0 → 0 candidatos", candEnt.length === 0);

  // ===== 8. cortesia NÃO dispara =====
  const candCort = PlanFitDetectorService.detect(orgCortesia);
  check("cortesia: 0 candidatos (regra política)", candCort.length === 0);

  // ===== 9. billing blocked NÃO dispara =====
  const candBlocked = PlanFitDetectorService.detect(orgBlocked);
  check("blocked: 0 candidatos (RN-F7.1-003 — LGPD §15)", candBlocked.length === 0);
  // past_due também
  db.prepare(`UPDATE organization_settings SET billing_status='past_due' WHERE organization_id = ?`).run(orgA);
  const candAPastDue = PlanFitDetectorService.detect(orgA);
  check("past_due: 0 candidatos (mesma regra)", candAPastDue.length === 0);
  db.prepare(`UPDATE organization_settings SET billing_status='active' WHERE organization_id = ?`).run(orgA);

  // ===== 10. soft-deleted NÃO dispara =====
  const candDel = PlanFitDetectorService.detect(orgDel);
  check("soft-deleted: 0 candidatos", candDel.length === 0);

  // ===== 11. Publisher publica em business_signals =====
  const pubA = PlanFitSignalPublisher.run(orgA);
  check("publisher orgA: published=1, deduped=0", pubA.published === 1 && pubA.deduped === 0);
  const signalsA = BusinessSignalService.list(orgA, { domain: "plan", status: "open" });
  check("orgA tem sinal aberto em business_signals", signalsA.length === 1);
  check("sinal orgA: signal_type=plan_near_limit_ai", signalsA[0].signal_type === "plan_near_limit_ai");
  check("sinal orgA: severity=risk", signalsA[0].severity === "risk");
  check("sinal orgA: basis=fact", signalsA[0].basis === "fact");
  check("sinal orgA: source_service=PlanFitSignalPublisher", signalsA[0].source_service === "PlanFitSignalPublisher");
  check("sinal orgA: evidence.pctInt = 95", signalsA[0].evidence?.pctInt === 95);
  check("sinal orgA: premises.detector = PlanFitDetectorService", signalsA[0].premises?.detector === "PlanFitDetectorService");

  // ===== 12. dedupe mensal — 2ª chamada retorna deduped =====
  const pubA2 = PlanFitSignalPublisher.run(orgA);
  check("publisher orgA 2ª rodada: published=0, deduped=1 (mesmo mês)", pubA2.published === 0 && pubA2.deduped === 1);
  const signalsA2 = BusinessSignalService.list(orgA, { domain: "plan", status: "open" });
  check("orgA ainda tem 1 sinal (não duplicou)", signalsA2.length === 1);

  // ===== 13. sinal stale → resolved =====
  // Sequência: (a) publica com uso alto → 2 sinais AI+contacts abertos.
  //            (b) remove uso AI (cai pra < 80%).
  //            (c) re-publica → AI sai do set válido e vira resolved; contacts continua.
  const pubCBefore = PlanFitSignalPublisher.run(orgC);
  check("orgC 1ª rodada: publica ambos AI+contacts", pubCBefore.published + pubCBefore.deduped === 2);
  db.prepare(`DELETE FROM ai_interactions_log WHERE organization_id = ? AND id IN (SELECT id FROM ai_interactions_log WHERE organization_id = ? LIMIT 2000)`).run(orgC, orgC);
  const pubCAfter = PlanFitSignalPublisher.run(orgC);
  check("orgC 2ª rodada (uso AI caiu): AI é resolved", pubCAfter.resolved >= 1);
  const signalsCOpen = BusinessSignalService.list(orgC, { domain: "plan", status: "open" });
  check("orgC: só contacts continua aberto", signalsCOpen.length === 1 && signalsCOpen[0].signal_type === "plan_near_limit_contacts");

  // ===== 14. evidence completa =====
  const evAContacts = signalsA[0].evidence;
  check("evidence.metric preenchido", evAContacts.metric === "ai");
  check("evidence.used preenchido", evAContacts.used === 2850);
  check("evidence.limit preenchido", evAContacts.limit === 3000);
  check("evidence.upgradeTargetPlan preenchido", typeof evAContacts.upgradeTargetPlan === "string");

  // ===== 15. runAll skipa cortesia + blocked =====
  const runAll = PlanFitSignalPublisher.runAll();
  check("runAll: orgsSeen inclui start-actives (não cortesia/blocked/deleted)",
    runAll.orgsSeen >= 3 && runAll.orgsSeen <= 5);
  const cortSignals = BusinessSignalService.list(orgCortesia, { domain: "plan", status: "open" });
  check("cortesia: 0 sinais (skipada)", cortSignals.length === 0);
  const blockedSignals = BusinessSignalService.list(orgBlocked, { domain: "plan", status: "open" });
  check("blocked: 0 sinais (skipada)", blockedSignals.length === 0);

  // ===== 16. Cross-tenant =====
  const signalsB = BusinessSignalService.list(orgB, { domain: "plan", status: "open" });
  check("orgB (uso baixo): 0 sinais", signalsB.length === 0);
  // Mudanças em orgC não afetam orgA
  const signalsAFinal = BusinessSignalService.list(orgA, { domain: "plan", status: "open" });
  check("orgA intocado após ações em orgC", signalsAFinal.length === 1);

  // ===== 17. ImpactPrioritizationService.actionFor =====
  const action = ImpactPrioritizationService.actionFor("plan_near_limit_ai");
  check("actionFor(plan_near_limit_ai).actionType = 'propose_upgrade'", action.actionType === "propose_upgrade");
  check("actionFor(plan_near_limit_contacts) tem label", ImpactPrioritizationService.actionFor("plan_near_limit_contacts").label.length > 0);

  // ===== 18. STRATEGIC['plan'] existe e é alto =====
  // Não temos acesso ao objeto STRATEGIC direto, mas ImpactPrioritizationService.prioritize
  // deve dar prioridade aos sinais 'plan' — o teste é indireto via ranking.
  // Aqui apenas verificamos que os sinais domain='plan' aparecem no /prioritize.
  const prio = ImpactPrioritizationService.prioritize(orgA, {});
  const hasPlan = prio.global.some((p: any) => p.domain === "plan");
  check("prioritize inclui sinal domain='plan' no top-N global", hasPlan);

  // ===== Resultado =====
  console.log("\n=== PlanFitDetector + Publisher (F7.1) ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.note ? "  (" + r.note + ")" : ""}`);
  console.log(`\n${results.length - failures}/${results.length} checks OK`);
  if (failures > 0) process.exit(1);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
