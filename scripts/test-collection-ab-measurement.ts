/**
 * TEST — medição do A/B da copy de cobrança (ADR-155 F2.3).
 *
 * Prova a ATRIBUIÇÃO nível-ação: correlaciona a variante/decline registrados no
 * follow-up com a recuperação real (decision_action done + result_amount),
 * agrega por variante, elege vencedor só com amostra mínima, e publica o KPI
 * como business_signal (upsert idempotente). Isolamento multi-tenant.
 *
 * Uso: npm run test:collection-ab-measurement
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-colab-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-colab-1234567890";
delete process.env.OPENAI_API_KEY;

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { CollectionAbMeasurementService } = await import("../src/server/CollectionAbMeasurementService.js");

  const mkOrg = () => {
    const orgId = `org_${randomUUID().slice(0, 8)}`;
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical) VALUES (?, ?, 'Loja', 'active', 'varejo')`).run(randomUUID(), orgId);
    return orgId;
  };
  // Cria uma ação de cobrança + 1 follow-up (variante/decline), recuperada ou não.
  const mkAction = (orgId: string, variant: string, decline: string, recovered: boolean, amount = 100) => {
    const actionId = randomUUID();
    db.prepare(`INSERT INTO decision_actions (id, organization_id, domain, action_type, title, command_type, status, result_amount) VALUES (?, ?, 'collection', 'collection_send_reminder', 'Cobrança', 'collection_send_reminder', ?, ?)`)
      .run(actionId, orgId, recovered ? "done" : "approved", recovered ? amount : null);
    db.prepare(`INSERT INTO collection_followup_attempts (id, organization_id, action_id, attempt_number, template_key, variant, decline_type) VALUES (?, ?, ?, 2, 'firm', ?, ?)`)
      .run(randomUUID(), orgId, actionId, variant, decline);
    return actionId;
  };

  const orgA = mkOrg();
  const orgB = mkOrg();

  // orgA: control 6 (soft4/hard2), recuperadas 2 @100 → rate 33.3, rev 20000c
  for (let i = 0; i < 4; i++) mkAction(orgA, "control", "soft", i < 2, 100);
  for (let i = 0; i < 2; i++) mkAction(orgA, "control", "hard", false, 100);
  // orgA: calibrated 6 (soft3/hard3), recuperadas 4 @150 → rate 66.7, rev 60000c
  for (let i = 0; i < 3; i++) mkAction(orgA, "calibrated", "soft", true, 150);
  for (let i = 0; i < 3; i++) mkAction(orgA, "calibrated", "hard", i < 1, 150);

  // ===== 1. measure: agregação por variante =====
  const m = CollectionAbMeasurementService.measure(orgA);
  check("totalActions = 12", m.totalActions === 12);
  const ctrl = m.variants.find((v) => v.variant === "control")!;
  const cal = m.variants.find((v) => v.variant === "calibrated")!;
  check("control: sent 6, recovered 2", ctrl?.sent === 6 && ctrl?.recovered === 2);
  check("control: revenueCents 20000", ctrl?.revenueCents === 20000);
  check("control: recoveryRatePct 33.3", ctrl?.recoveryRatePct === 33.3);
  check("calibrated: sent 6, recovered 4", cal?.sent === 6 && cal?.recovered === 4);
  check("calibrated: revenueCents 60000", cal?.revenueCents === 60000);
  check("calibrated: recoveryRatePct 66.7", cal?.recoveryRatePct === 66.7);

  // ===== 2. decline breakdown (nível-tentativa) =====
  const soft = m.declineBreakdown.find((d) => d.declineType === "soft");
  const hard = m.declineBreakdown.find((d) => d.declineType === "hard");
  check("declineBreakdown soft = 7 tentativas", soft?.attempts === 7);
  check("declineBreakdown hard = 5 tentativas", hard?.attempts === 5);

  // ===== 3. winner (amostra suficiente: ambos >= 5) =====
  check("winner = calibrated (66.7 > 33.3)", m.winner === "calibrated");

  // ===== 4. publish → business_signal (upsert) =====
  check("publish retorna published", CollectionAbMeasurementService.publish(orgA).published === true);
  const sig = db.prepare(`SELECT signal_type, severity, evidence_json, impact_amount, dedupe_key FROM business_signals WHERE organization_id = ? AND dedupe_key = ?`).get(orgA, `collection:ab_result:${orgA}`) as any;
  check("sinal collection_ab_result publicado", sig?.signal_type === "collection_ab_result" && sig?.severity === "info");
  check("sinal: impact_amount 800 BRL (revenue total)", Number(sig?.impact_amount) === 800);
  const ev = sig ? JSON.parse(sig.evidence_json) : {};
  check("sinal.evidence.winner = calibrated", ev?.winner === "calibrated");
  check("sinal.evidence tem 2 variantes", Array.isArray(ev?.variants) && ev.variants.length === 2);
  // republicar → upsert (não duplica)
  CollectionAbMeasurementService.publish(orgA);
  const cnt = (db.prepare(`SELECT COUNT(*) AS n FROM business_signals WHERE organization_id = ? AND dedupe_key = ?`).get(orgA, `collection:ab_result:${orgA}`) as any).n;
  check("republicar faz upsert (1 sinal, não duplica)", Number(cnt) === 1);

  // ===== 5. winner=null com amostra insuficiente =====
  const orgC = mkOrg();
  for (let i = 0; i < 2; i++) mkAction(orgC, "control", "soft", true, 100);
  for (let i = 0; i < 2; i++) mkAction(orgC, "calibrated", "soft", true, 100);
  check("winner=null com amostra < 5", CollectionAbMeasurementService.measure(orgC).winner === null);

  // ===== 6. ISOLAMENTO multi-tenant =====
  const mb = CollectionAbMeasurementService.measure(orgB);
  check("orgB (sem dados) → totalActions 0", mb.totalActions === 0);
  check("orgB → publish published=false", CollectionAbMeasurementService.publish(orgB).published === false);
  check("orgB → sem sinal publicado", !db.prepare(`SELECT 1 FROM business_signals WHERE organization_id = ? AND dedupe_key = ?`).get(orgB, `collection:ab_result:${orgB}`));
  check("ISOLAMENTO: measure(orgA) não conta ações de orgC", CollectionAbMeasurementService.measure(orgA).totalActions === 12);

  // ===== resultado =====
  console.log("\n=== Collection A/B measurement — F2.3 ===");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}`);
  console.log(`\n${results.length - failures}/${results.length} checagens ok`);
  if (failures > 0) { console.error(`\n❌ ${failures} falha(s)`); process.exit(1); }
  console.log("\n✅ medição A/B íntegra");
}

main();
