/**
 * TEST — medição do A/B da copy de Recuperação Comercial (ADR-155 F3.2).
 *
 * Prova a ATRIBUIÇÃO nível-ticket: correlaciona a variante carimbada no touch
 * (F3.2) com a recuperação real (existência de sales_recovery_attributions),
 * agrega por variante, quebra as respostas por intent, elege vencedor só com
 * amostra mínima, e publica o KPI como business_signal (upsert idempotente).
 * Isolamento multi-tenant.
 *
 * Uso: npm run test:sales-recovery-ab-measurement
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-srab-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-srab-1234567890";
delete process.env.OPENAI_API_KEY;

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { SalesRecoveryAbMeasurementService } = await import("../src/server/SalesRecoveryAbMeasurementService.js");

  const mkOrg = () => {
    const orgId = `org_${randomUUID().slice(0, 8)}`;
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical) VALUES (?, ?, 'Loja', 'active', 'varejo')`).run(randomUUID(), orgId);
    return orgId;
  };
  // Um ticket tocado (1 touch, variante carimbada) + recuperado ou não.
  const mkTicket = (orgId: string, variant: string, recovered: boolean, revenue = 100, replyIntent: string | null = null) => {
    const ticketId = randomUUID();
    const touchId = randomUUID();
    db.prepare(`INSERT INTO sales_recovery_touches (id, organization_id, ticket_id, contact_id, phone, channel_id, variant, reply_intent) VALUES (?, ?, ?, ?, '5511', 'ch1', ?, ?)`)
      .run(touchId, orgId, ticketId, randomUUID(), variant, replyIntent);
    if (recovered) {
      db.prepare(`INSERT INTO sales_recovery_attributions (id, organization_id, ticket_id, touch_id, action_id, stage_change_at, ticket_value, revenue_recovered, source, basis) VALUES (?, ?, ?, ?, ?, '2026-08-08 10:00:00', ?, ?, 'orders', 'fact')`)
        .run(randomUUID(), orgId, ticketId, touchId, randomUUID(), revenue, revenue);
    }
    return ticketId;
  };

  const orgA = mkOrg();
  const orgB = mkOrg();

  // orgA control: 6 tickets, 2 recuperados @100 → rate 33.3, rev 20000c
  for (let i = 0; i < 6; i++) mkTicket(orgA, "control", i < 2, 100, i < 3 ? "interested" : null);
  // orgA calibrated: 6 tickets, 4 recuperados @150 → rate 66.7, rev 60000c
  for (let i = 0; i < 6; i++) mkTicket(orgA, "calibrated", i < 4, 150, i < 2 ? "meeting_request" : null);

  // ===== 1. measure: agregação por variante (nível-ticket) =====
  const m = SalesRecoveryAbMeasurementService.measure(orgA);
  check("totalTickets = 12", m.totalTickets === 12);
  const ctrl = m.variants.find((v) => v.variant === "control")!;
  const cal = m.variants.find((v) => v.variant === "calibrated")!;
  check("control: sent 6, recovered 2", ctrl?.sent === 6 && ctrl?.recovered === 2);
  check("control: revenueCents 20000", ctrl?.revenueCents === 20000);
  check("control: recoveryRatePct 33.3", ctrl?.recoveryRatePct === 33.3);
  check("calibrated: sent 6, recovered 4", cal?.sent === 6 && cal?.recovered === 4);
  check("calibrated: revenueCents 60000", cal?.revenueCents === 60000);
  check("calibrated: recoveryRatePct 66.7", cal?.recoveryRatePct === 66.7);

  // ===== 2. reply breakdown (nível-resposta, por intent) =====
  const interested = m.replyBreakdown.find((d) => d.intent === "interested");
  const meeting = m.replyBreakdown.find((d) => d.intent === "meeting_request");
  check("replyBreakdown interested = 3", interested?.replies === 3);
  check("replyBreakdown meeting_request = 2", meeting?.replies === 2);

  // ===== 3. winner (amostra suficiente: ambos >= 5) =====
  check("winner = calibrated (66.7 > 33.3)", m.winner === "calibrated");

  // ===== 4. variante do ticket = touch MAIS RECENTE (multi-touch) =====
  const multiTicket = randomUUID();
  const orgD = mkOrg();
  const early = randomUUID(), late = randomUUID();
  db.prepare(`INSERT INTO sales_recovery_touches (id, organization_id, ticket_id, contact_id, phone, channel_id, variant, sent_at) VALUES (?, ?, ?, ?, '5511', 'ch1', 'control', '2026-08-01 09:00:00')`).run(early, orgD, multiTicket, randomUUID());
  db.prepare(`INSERT INTO sales_recovery_touches (id, organization_id, ticket_id, contact_id, phone, channel_id, variant, sent_at) VALUES (?, ?, ?, ?, '5511', 'ch1', 'calibrated', '2026-08-05 09:00:00')`).run(late, orgD, multiTicket, randomUUID());
  const md = SalesRecoveryAbMeasurementService.measure(orgD);
  check("ticket multi-touch conta 1x", md.totalTickets === 1);
  check("variante = touch mais recente (calibrated)", md.variants.length === 1 && md.variants[0].variant === "calibrated");

  // ===== 5. publish → business_signal (upsert) =====
  check("publish retorna published", SalesRecoveryAbMeasurementService.publish(orgA).published === true);
  const sig = db.prepare(`SELECT signal_type, severity, evidence_json, impact_amount, dedupe_key FROM business_signals WHERE organization_id = ? AND dedupe_key = ?`).get(orgA, `sales_recovery:ab_result:${orgA}`) as any;
  check("sinal sales_recovery_ab_result publicado", sig?.signal_type === "sales_recovery_ab_result" && sig?.severity === "info");
  check("sinal: impact_amount 800 BRL (revenue total)", Number(sig?.impact_amount) === 800);
  const ev = sig ? JSON.parse(sig.evidence_json) : {};
  check("sinal.evidence.winner = calibrated", ev?.winner === "calibrated");
  check("sinal.evidence tem 2 variantes", Array.isArray(ev?.variants) && ev.variants.length === 2);
  // republicar → upsert (não duplica)
  SalesRecoveryAbMeasurementService.publish(orgA);
  const cnt = (db.prepare(`SELECT COUNT(*) AS n FROM business_signals WHERE organization_id = ? AND dedupe_key = ?`).get(orgA, `sales_recovery:ab_result:${orgA}`) as any).n;
  check("republicar faz upsert (1 sinal, não duplica)", Number(cnt) === 1);

  // ===== 6. winner=null com amostra insuficiente =====
  const orgC = mkOrg();
  for (let i = 0; i < 2; i++) mkTicket(orgC, "control", true, 100);
  for (let i = 0; i < 2; i++) mkTicket(orgC, "calibrated", true, 100);
  check("winner=null com amostra < 5", SalesRecoveryAbMeasurementService.measure(orgC).winner === null);

  // ===== 7. ISOLAMENTO multi-tenant =====
  const mb = SalesRecoveryAbMeasurementService.measure(orgB);
  check("orgB (sem dados) → totalTickets 0", mb.totalTickets === 0);
  check("orgB → publish published=false", SalesRecoveryAbMeasurementService.publish(orgB).published === false);
  check("orgB → sem sinal publicado", !db.prepare(`SELECT 1 FROM business_signals WHERE organization_id = ? AND dedupe_key = ?`).get(orgB, `sales_recovery:ab_result:${orgB}`));
  check("ISOLAMENTO: measure(orgA) não conta tickets de orgC/orgD", SalesRecoveryAbMeasurementService.measure(orgA).totalTickets === 12);

  // ===== resultado =====
  console.log("\n=== Sales Recovery A/B measurement — F3.2 ===");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}`);
  console.log(`\n${results.length - failures}/${results.length} checagens ok`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
  if (failures > 0) { console.error(`\n❌ ${failures} falha(s)`); process.exit(1); }
  console.log("\n✅ medição A/B de recuperação íntegra");
}

main();
