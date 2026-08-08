/**
 * TEST — pós-mortem do grimoire / lições (ADR-155 F1.4).
 *
 * Prova o ciclo: A/B ruim → Lição datada na rubrica → GrimoireService injeta
 * <licoes>; A/B volta a ganhar → lição aposentada (some da injeção). Cobre
 * recordLesson/lessonsFor/retireLesson, dedupe/upsert, gating pelo brand voice
 * e ISOLAMENTO multi-tenant.
 *
 * Uso: npm run test:grimoire-postmortem
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-grim-pm-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-grim-pm-1234567890";
delete process.env.OPENAI_API_KEY;

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { GrimoireService } = await import("../src/server/GrimoireService.js");
  const { GrimoirePostmortemService } = await import("../src/server/GrimoirePostmortemService.js");

  const mkOrg = (brandVoice = false) => {
    const orgId = `org_${randomUUID().slice(0, 8)}`;
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical, brand_voice_enabled) VALUES (?, ?, 'Loja', 'active', 'varejo', ?)`).run(randomUUID(), orgId, brandVoice ? 1 : 0);
    return orgId;
  };
  const mkAction = (orgId: string, variant: string, recovered: boolean, amount = 100) => {
    const actionId = randomUUID();
    db.prepare(`INSERT INTO decision_actions (id, organization_id, domain, action_type, title, command_type, status, result_amount) VALUES (?, ?, 'collection', 'collection_send_reminder', 'Cobrança', 'collection_send_reminder', ?, ?)`)
      .run(actionId, orgId, recovered ? "done" : "approved", recovered ? amount : null);
    db.prepare(`INSERT INTO collection_followup_attempts (id, organization_id, action_id, attempt_number, template_key, variant, decline_type) VALUES (?, ?, ?, 2, 'firm', ?, 'soft')`)
      .run(randomUUID(), orgId, actionId, variant);
  };
  // ADR-155 F3.2 — um ticket tocado (variante carimbada) + recuperado ou não.
  const mkTicketR = (orgId: string, variant: string, recovered: boolean) => {
    const ticketId = randomUUID(); const touchId = randomUUID();
    db.prepare(`INSERT INTO sales_recovery_touches (id, organization_id, ticket_id, contact_id, phone, channel_id, variant) VALUES (?, ?, ?, ?, '5511', 'ch1', ?)`)
      .run(touchId, orgId, ticketId, randomUUID(), variant);
    if (recovered) {
      db.prepare(`INSERT INTO sales_recovery_attributions (id, organization_id, ticket_id, touch_id, action_id, stage_change_at, ticket_value, revenue_recovered, source, basis) VALUES (?, ?, ?, ?, ?, '2026-08-08 10:00:00', 100, 100, 'orders', 'fact')`)
        .run(randomUUID(), orgId, ticketId, touchId, randomUUID());
    }
  };
  const activeLessons = (orgId: string) => db.prepare(`SELECT COUNT(*) AS n FROM grimoire_lessons WHERE organization_id = ? AND active = 1`).get(orgId) as any;

  // ===== 1. tabela existe =====
  check("tabela grimoire_lessons existe", !!db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='grimoire_lessons'`).get());

  // ===== 2. record direto + injeção no promptForOrg (brand voice ON) =====
  const orgC = mkOrg(true);
  await GrimoireService.recordLesson(orgC, "dunning-cadence", { lesson: "Evitar emoji no D+7.", source: "manual", dedupeKey: "k1" });
  const lc = await GrimoireService.lessonsFor(orgC, ["dunning-cadence"]);
  check("lessonsFor traz a lição da rubrica", (lc.get("dunning-cadence") || []).length === 1);
  check("lição é datada (YYYY-MM-DD:)", /^\d{4}-\d{2}-\d{2}: /.test((lc.get("dunning-cadence") || [])[0] || ""));
  const promptC = await GrimoireService.promptForOrg(orgC, "cobranca", ["compose"]);
  check("promptForOrg injeta bloco <licoes>", promptC.includes("<licoes>") && promptC.includes("Evitar emoji no D+7."));
  check("<licoes> fica dentro da rubrica dunning-cadence", promptC.includes('id="dunning-cadence"'));

  // ===== 3. gating: brand voice OFF → sem injeção =====
  const orgOff = mkOrg(false);
  await GrimoireService.recordLesson(orgOff, "dunning-cadence", { lesson: "Lição da org off.", dedupeKey: "k1" });
  check("brand voice OFF → promptForOrg vazio (sem injeção)", (await GrimoireService.promptForOrg(orgOff, "cobranca", ["compose"])) === "");

  // ===== 4. pós-mortem RECORD: calibrada perdendo → grava lição =====
  const orgA = mkOrg(true);
  for (let i = 0; i < 6; i++) mkAction(orgA, "control", i < 4);      // control 66.7%
  for (let i = 0; i < 6; i++) mkAction(orgA, "calibrated", i < 2);   // calibrated 33.3% (pior)
  const rA = await GrimoirePostmortemService.runCollectionAb(orgA);
  check("pós-mortem: calibrada perdendo → recorded", rA.recorded === true && rA.retired === false);
  check("orgA tem 1 lição ativa", Number(activeLessons(orgA).n) === 1);
  const la = (await GrimoireService.lessonsFor(orgA, ["dunning-cadence"])).get("dunning-cadence") || [];
  check("lição cita as taxas do A/B", (la[0] || "").includes("33.3%") && (la[0] || "").includes("66.7%"));
  const pA = await GrimoireService.promptForOrg(orgA, "cobranca", ["compose"]);
  check("orgA: lição do A/B injetada no prompt", pA.includes("<licoes>") && pA.includes("pior que o baseline"));

  // ===== 5. dedupe/upsert: rodar de novo não duplica =====
  await GrimoirePostmortemService.runCollectionAb(orgA);
  check("re-rodar não duplica (1 lição ativa)", Number(activeLessons(orgA).n) === 1);

  // ===== 6. pós-mortem RETIRE: calibrada ganhando → aposenta a lição =====
  const orgB = mkOrg(true);
  await GrimoireService.recordLesson(orgB, "dunning-cadence", { lesson: "lição antiga", source: "collection_ab_result", dedupeKey: "ab:dunning-cadence:calibrated-underperform" });
  for (let i = 0; i < 6; i++) mkAction(orgB, "control", i < 2);      // control 33.3%
  for (let i = 0; i < 6; i++) mkAction(orgB, "calibrated", i < 4);   // calibrated 66.7% (melhor)
  const rB = await GrimoirePostmortemService.runCollectionAb(orgB);
  check("pós-mortem: calibrada ganhando → retired", rB.retired === true && rB.recorded === false);
  check("orgB: 0 lições ativas após aposentar", Number(activeLessons(orgB).n) === 0);
  check("orgB: promptForOrg sem <licoes>", !(await GrimoireService.promptForOrg(orgB, "cobranca", ["compose"])).includes("<licoes>"));

  // ===== 7. ISOLAMENTO multi-tenant =====
  const orgD = mkOrg(true); // sem lições
  const pD = await GrimoireService.promptForOrg(orgD, "cobranca", ["compose"]);
  check("ISOLAMENTO: orgD (sem lições) não herda a de orgA", !pD.includes("<licoes>") && !pD.includes("pior que o baseline"));
  check("lessonsFor(orgD) vazio", (await GrimoireService.lessonsFor(orgD, ["dunning-cadence"])).size === 0);

  // ===== 8. runAll agrega =====
  const all = await GrimoirePostmortemService.runAll();
  check("runAll retorna orgs/recorded/retired", typeof all.orgs === "number" && all.orgs >= 2);

  // ===== 9. pós-mortem de RECUPERAÇÃO (F3.2): mesmo loop na rubrica sales-recovery =====
  const orgR = mkOrg(true);
  for (let i = 0; i < 6; i++) mkTicketR(orgR, "control", i < 4);      // control 66.7%
  for (let i = 0; i < 6; i++) mkTicketR(orgR, "calibrated", i < 2);   // calibrated 33.3% (pior)
  const rR = await GrimoirePostmortemService.runSalesRecoveryAb(orgR);
  check("recuperação: calibrada perdendo → recorded", rR.recorded === true && rR.retired === false);
  check("orgR tem 1 lição ativa", Number(activeLessons(orgR).n) === 1);
  const pR = await GrimoireService.promptForOrg(orgR, "recuperacao", ["compose"]);
  check("orgR: lição injetada na rubrica sales-recovery", pR.includes("<licoes>") && pR.includes('id="sales-recovery"') && pR.includes("pior que o baseline"));

  // RETIRE: calibrada ganhando → aposenta a lição de recuperação.
  const orgR2 = mkOrg(true);
  await GrimoireService.recordLesson(orgR2, "sales-recovery", { lesson: "lição antiga", source: "sales_recovery_ab_result", dedupeKey: "ab:sales-recovery:calibrated-underperform" });
  for (let i = 0; i < 6; i++) mkTicketR(orgR2, "control", i < 2);     // control 33.3%
  for (let i = 0; i < 6; i++) mkTicketR(orgR2, "calibrated", i < 4);  // calibrated 66.7% (melhor)
  const rR2 = await GrimoirePostmortemService.runSalesRecoveryAb(orgR2);
  check("recuperação: calibrada ganhando → retired", rR2.retired === true && rR2.recorded === false);
  check("orgR2: 0 lições ativas após aposentar", Number(activeLessons(orgR2).n) === 0);
  const allR = await GrimoirePostmortemService.runAllSalesRecovery();
  check("runAllSalesRecovery agrega orgs", typeof allR.orgs === "number" && allR.orgs >= 2);

  // ===== resultado =====
  console.log("\n=== Grimoire pós-mortem — F1.4 ===");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}`);
  console.log(`\n${results.length - failures}/${results.length} checagens ok`);
  if (failures > 0) { console.error(`\n❌ ${failures} falha(s)`); process.exit(1); }
  console.log("\n✅ pós-mortem do grimoire íntegro");
}

main();
