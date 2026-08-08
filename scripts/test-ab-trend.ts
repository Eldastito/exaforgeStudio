/**
 * TEST — histórico temporal do A/B (control × calibrada) — ADR-155.
 *
 * `AbTrendService` grava um snapshot diário (upsert por org/kind/dia) do que os
 * *AbMeasurementService medem e serve a série pro gráfico da aba Operações.
 * Cobre: capture (cobrança + recuperação), upsert idempotente por dia, série
 * ordenada por data, skip sem dado, captureAll e isolamento multi-tenant.
 *
 * Uso: npm run test:ab-trend
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-abtrend-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-abtrend-1234567890";
delete process.env.OPENAI_API_KEY;

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

const dayOffset = (n: number) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { AbTrendService } = await import("../src/server/AbTrendService.js");

  const mkOrg = () => {
    const orgId = `org_${randomUUID().slice(0, 8)}`;
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical) VALUES (?, ?, 'Loja', 'active', 'varejo')`).run(randomUUID(), orgId);
    return orgId;
  };
  const mkAction = (orgId: string, variant: string, recovered: boolean, amount = 100) => {
    const actionId = randomUUID();
    db.prepare(`INSERT INTO decision_actions (id, organization_id, domain, action_type, title, command_type, status, result_amount) VALUES (?, ?, 'collection', 'collection_send_reminder', 'Cobrança', 'collection_send_reminder', ?, ?)`)
      .run(actionId, orgId, recovered ? "done" : "approved", recovered ? amount : null);
    db.prepare(`INSERT INTO collection_followup_attempts (id, organization_id, action_id, attempt_number, template_key, variant, decline_type) VALUES (?, ?, ?, 2, 'firm', ?, 'soft')`)
      .run(randomUUID(), orgId, actionId, variant);
  };
  const mkTicket = (orgId: string, variant: string, recovered: boolean) => {
    const ticketId = randomUUID(); const touchId = randomUUID();
    db.prepare(`INSERT INTO sales_recovery_touches (id, organization_id, ticket_id, contact_id, phone, channel_id, variant) VALUES (?, ?, ?, ?, '5511', 'ch1', ?)`)
      .run(touchId, orgId, ticketId, randomUUID(), variant);
    if (recovered) {
      db.prepare(`INSERT INTO sales_recovery_attributions (id, organization_id, ticket_id, touch_id, action_id, stage_change_at, ticket_value, revenue_recovered, source, basis) VALUES (?, ?, ?, ?, ?, '2026-08-08 10:00:00', 100, 100, 'orders', 'fact')`)
        .run(randomUUID(), orgId, ticketId, touchId, randomUUID());
    }
  };

  const orgA = mkOrg();
  const orgB = mkOrg();
  // orgA cobrança: control 6 (2 rec → 33.3%), calibrated 6 (4 rec → 66.7%) → winner calibrated
  for (let i = 0; i < 6; i++) mkAction(orgA, "control", i < 2);
  for (let i = 0; i < 6; i++) mkAction(orgA, "calibrated", i < 4);
  // orgA recuperação: control 6 (2 rec), calibrated 6 (4 rec)
  for (let i = 0; i < 6; i++) mkTicket(orgA, "control", i < 2);
  for (let i = 0; i < 6; i++) mkTicket(orgA, "calibrated", i < 4);

  // ===== 1. capture (cobrança) grava snapshot com as taxas medidas =====
  check("capture cobrança → captured", AbTrendService.capture(orgA, "collection").captured === true);
  const snap = db.prepare(`SELECT * FROM ab_trend_snapshots WHERE organization_id = ? AND kind = 'collection'`).get(orgA) as any;
  check("snapshot: control_rate 33.3 / sent 6", snap?.control_rate === 33.3 && snap?.control_sent === 6);
  check("snapshot: calibrated_rate 66.7 / sent 6", snap?.calibrated_rate === 66.7 && snap?.calibrated_sent === 6);
  check("snapshot: winner calibrated", snap?.winner === "calibrated");

  // ===== 2. upsert idempotente por dia (rodar 2x hoje = 1 linha) =====
  AbTrendService.capture(orgA, "collection");
  const cnt = (db.prepare(`SELECT COUNT(*) AS n FROM ab_trend_snapshots WHERE organization_id = ? AND kind = 'collection'`).get(orgA) as any).n;
  check("upsert: 1 linha por org/kind/dia (não duplica)", Number(cnt) === 1);

  // ===== 3. série ordenada por data (injeta 2 dias passados + hoje) =====
  AbTrendService.capture(orgA, "collection", dayOffset(2));
  AbTrendService.capture(orgA, "collection", dayOffset(1));
  const serie = AbTrendService.series(orgA, "collection", { days: 30 });
  check("série tem 3 pontos (2 passados + hoje)", serie.points.length === 3);
  check("série ordenada ascendente por data", serie.points[0].date < serie.points[1].date && serie.points[1].date < serie.points[2].date);
  check("ponto carrega control/calibrated rate", serie.points[0].controlRate === 33.3 && serie.points[0].calibratedRate === 66.7);

  // ===== 4. recuperação também snapshota + serve série =====
  check("capture recuperação → captured", AbTrendService.capture(orgA, "sales_recovery").captured === true);
  const serieR = AbTrendService.series(orgA, "sales_recovery", { days: 30 });
  check("série recuperação tem 1 ponto (só hoje)", serieR.points.length === 1);
  check("série recuperação winner calibrated no ponto", serieR.points[0].winner === "calibrated");

  // ===== 5. skip sem dado + isolamento =====
  check("capture sem dado (orgB) → captured false", AbTrendService.capture(orgB, "collection").captured === false);
  check("série orgB vazia (isolamento)", AbTrendService.series(orgB, "collection").points.length === 0);
  check("orgB sem snapshot", !db.prepare(`SELECT 1 FROM ab_trend_snapshots WHERE organization_id = ?`).get(orgB));

  // ===== 6. captureAll agrega os dois kinds =====
  const all = AbTrendService.captureAll();
  check("captureAll cobre cobrança e recuperação de orgA", all.collection >= 1 && all.sales_recovery >= 1);

  console.log("\n=== A/B trend (gráfico temporal) — ADR-155 ===");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}`);
  console.log(`\n${results.length - failures}/${results.length} checagens ok`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
  if (failures > 0) { console.error(`\n❌ ${failures} falha(s)`); process.exit(1); }
  console.log("\n✅ histórico temporal do A/B íntegro");
}

main();
