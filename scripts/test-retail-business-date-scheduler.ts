/**
 * TESTE — writes DIÁRIOS do Scheduler no dia COMERCIAL (não UTC).
 * ----------------------------------------------------------------------------
 * Follow-up do cluster de dia-comercial (estabilização TOULON): três escritas/
 * leituras server-side keyed no dia, que ficavam em UTC, agora usam
 * `BusinessTimeService.businessDate(orgId)` (honra o kill-switch 6B):
 *   - `RetailImpactService.snapshotDaily` (snapshot idempotente por (org, dia));
 *   - `RetailFloorSettingsService.inCalibration` (janela de calibração);
 *   - `RetailOpsSignalPublisher.run` (asOf/dedupe — smoke, mesma delegação).
 *
 * Trava a INVARIANTE de delegação: ligado → dia comercial; kill-switch off →
 * dia UTC (0-regressão). A matemática de fuso em si é coberta por
 * `test:business-time`.
 *
 * Uso:  npm run test:retail-business-date-scheduler
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-retail-bizsched-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-retail-bizsched-1";

let failures = 0; const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }
const minus1 = (day: string) => new Date(new Date(`${day}T12:00:00Z`).getTime() - 86400000).toISOString().slice(0, 10);

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { RetailImpactService } = await import("../src/server/RetailImpactService.js");
  const { RetailFloorSettingsService } = await import("../src/server/RetailFloorService.js");
  const { RetailOpsSignalPublisher } = await import("../src/server/RetailOpsSignalPublisher.js");
  const { RetailFeatureFlagService } = await import("../src/server/RetailFeatureFlagService.js");
  const { BusinessTimeService } = await import("../src/server/BusinessTimeService.js");

  const snapDate = (org: string) => (db.prepare(`SELECT snapshot_date FROM retail_impact_snapshots WHERE organization_id = ?`).get(org) as any)?.snapshot_date;

  // ── org A: kill-switch ON (dia comercial SP) ──
  const A = `org_A_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'A', 'active')`).run(randomUUID(), A);
  RetailFeatureFlagService.set(A, "business_date", true);
  const bizA = BusinessTimeService.businessDate(A);

  check("1.1 snapshotDaily grava no dia comercial", (RetailImpactService.snapshotDaily(A), snapDate(A) === bizA), `${snapDate(A)} vs ${bizA}`);
  RetailFloorSettingsService.update(A, { calibrationUntil: bizA });
  check("1.2 inCalibration true quando até = dia comercial", RetailFloorSettingsService.inCalibration(A) === true);
  RetailFloorSettingsService.update(A, { calibrationUntil: minus1(bizA) });
  check("1.3 inCalibration false quando até = ontem (comercial)", RetailFloorSettingsService.inCalibration(A) === false);
  const ops = RetailOpsSignalPublisher.run(A);
  check("1.4 opsSignal.run roda sem erro (smoke, asOf=dia comercial)", ops && typeof ops.published === "number");

  // ── org B: kill-switch OFF (dia UTC, 0-regressão) ──
  const B = `org_B_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'B', 'active')`).run(randomUUID(), B);
  RetailFeatureFlagService.set(B, "business_date", false);
  const utcB = new Date().toISOString().slice(0, 10);

  check("2.1 OFF: snapshotDaily grava no dia UTC (legado)", (RetailImpactService.snapshotDaily(B), snapDate(B) === utcB), `${snapDate(B)} vs ${utcB}`);
  RetailFloorSettingsService.update(B, { calibrationUntil: utcB });
  check("2.2 OFF: inCalibration true quando até = dia UTC", RetailFloorSettingsService.inCalibration(B) === true);
  check("2.3 OFF: opsSignal.run roda sem erro", (() => { const r = RetailOpsSignalPublisher.run(B); return r && typeof r.published === "number"; })());

  // ── isolamento ──
  check("3.1 snapshot de A não vaza pra B", snapDate(A) === bizA && snapDate(B) === utcB);

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name} ${x.detail ? `(${x.detail})` : ""}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} retail-business-date-scheduler: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
