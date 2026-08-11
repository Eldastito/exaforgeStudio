/**
 * TEST — PRD 2 F11 (§63-66, CA19): feedback & calibração. O usuário descarta com
 * MOTIVO (§65); o Radar mede a qualidade por detector (false-positive rate,
 * dismissal rate, calibração) — derivado por query, sem contador mutável.
 *
 * Prova (determinístico):
 *   - dismiss grava motivo válido (incorrect=falso-positivo); inválido → NULL;
 *   - detectorMetrics: emitidos/descartados/falso/acionado/resolvido + taxas;
 *   - calibração 'poor' quando o detector é majoritariamente ignorado (§63);
 *   - janela de dias filtra; totais agregam; isolamento.
 *
 * Uso: npm run test:signal-calibration
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-signal-calib-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-signal-calib-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { BusinessSignalService: BS } = await import("../src/server/BusinessSignalService.js");
  const { SignalCalibrationService: CAL } = await import("../src/server/SignalCalibrationService.js");

  const mkOrg = () => { const id = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), id); return id; };
  const org = mkOrg();
  const pub = (svc: string, key: string) => BS.publish(org, { domain: "sales", signalType: "x", severity: "risk", basis: "fact", confidence: 0.9, sourceService: svc, evidence: {}, dedupeKey: key });
  const rowOf = (id: string) => db.prepare(`SELECT * FROM business_signals WHERE id = ?`).get(id) as any;

  // DetectorA: 10 emitidos → 3 incorrect, 2 expected, 2 ack, 1 resolved, 2 open.
  const a = Array.from({ length: 10 }, (_, i) => pub("DetectorA", `a${i}`));
  ["incorrect", "incorrect", "incorrect", "expected", "expected"].forEach((r, i) => BS.dismiss(org, a[i].id, r));
  BS.acknowledge(org, a[5].id); BS.acknowledge(org, a[6].id); BS.resolve(org, a[7].id);

  // DetectorB: 10 emitidos → todos descartados (9 incorrect + 1 irrelevant) → poor.
  const b = Array.from({ length: 10 }, (_, i) => pub("DetectorB", `b${i}`));
  b.forEach((s, i) => BS.dismiss(org, s.id, i < 9 ? "incorrect" : "irrelevant"));

  const out = CAL.detectorMetrics(org);
  const A = out.detectors.find((d: any) => d.detector === "DetectorA");
  const B = out.detectors.find((d: any) => d.detector === "DetectorB");

  // ===== 1. DetectorA =====
  check("1.1 A: emitidos 10, descartados 5, falso 3", A.emitted === 10 && A.dismissed === 5 && A.dismissedFalse === 3);
  check("1.2 A: falsePositiveRate 0.3, dismissalRate 0.5, actedRate 0.2, calibração ok", A.falsePositiveRate === 0.3 && A.dismissalRate === 0.5 && A.actedRate === 0.2 && A.calibration === "ok");
  check("1.3 A: motivos {incorrect:3, expected:2}", A.dismissReasons.incorrect === 3 && A.dismissReasons.expected === 2);

  // ===== 2. DetectorB mal calibrado (§63) =====
  check("2.1 B: dismissalRate 1.0 → calibração POOR; fp 0.9", B.dismissalRate === 1 && B.calibration === "poor" && B.falsePositiveRate === 0.9);

  // ===== 3. Totais =====
  check("3.1 totais: emitidos 20, falso 12", out.totals.emitted === 20 && out.totals.dismissedFalse === 12);

  // ===== 4. Motivo válido/inválido =====
  const v = pub("DetectorC", "v"); BS.dismiss(org, v.id, "duplicate");
  const bad = pub("DetectorC", "bad"); BS.dismiss(org, bad.id, "garbage_reason");
  check("4.1 motivo válido persiste; inválido → NULL (mas status dismissed)", rowOf(v.id).dismiss_reason === "duplicate" && rowOf(bad.id).dismiss_reason == null && rowOf(bad.id).status === "dismissed");

  // ===== 5. Janela de dias =====
  const old = pub("DetectorOld", "old"); db.prepare(`UPDATE business_signals SET detected_at = datetime('now','-40 days') WHERE id = ?`).run(old.id);
  check("5.1 default 30d exclui o antigo; days:0 inclui", !CAL.detectorMetrics(org).detectors.some((d: any) => d.detector === "DetectorOld") && CAL.detectorMetrics(org, { days: 0 }).detectors.some((d: any) => d.detector === "DetectorOld"));

  // ===== 6. Isolamento =====
  const orgB = mkOrg();
  check("6.1 org sem sinais → sem detectores", CAL.detectorMetrics(orgB).detectors.length === 0 && CAL.detectorMetrics(orgB).totals.emitted === 0);

  console.log("\n=== TEST: Calibração do Radar F11 (PRD 2) ===\n");
  for (const rr of results) console.log(`${rr.ok ? "✅" : "❌"} ${rr.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Calibração do Radar F11 OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
