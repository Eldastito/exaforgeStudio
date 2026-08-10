/**
 * TEST — ADR-159 F6 (D6, parte 2): detector de anomalia → business_signals.
 *
 * Prova, determinístico (RN-004, derivado):
 *   - rajada de execuções governadas FALHAS na janela ≥ limiar → publica sinal
 *     security/anomalous_behavior com breakdown por error_code (basis=fact);
 *   - abaixo do limiar → NÃO publica; e faz SWEEP (resolve sinal aberto quando
 *     a org volta ao normal);
 *   - severidade escala com o volume;
 *   - execuções DONE ou fora da janela não contam;
 *   - runAll só orgs opt-in + isolamento.
 *
 * Uso: npm run test:security-anomaly
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-sec-anomaly-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-sec-anomaly-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { SecurityAnomalyDetectorService: SA } = await import("../src/server/SecurityAnomalyDetectorService.js");
  const { BusinessSignalService: SS } = await import("../src/server/BusinessSignalService.js");

  const mkOrg = (anomalyOn: boolean) => { const id = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, anomaly_detector_enabled) VALUES (?, ?, 'X', 'active', ?)`).run(randomUUID(), id, anomalyOn ? 1 : 0); return id; };
  // Insere uma linha de execução no log. `agoHours`: quantas horas atrás (default agora).
  const mkExec = (orgId: string, status: string, errorCode: string | null, agoHours = 0) => {
    db.prepare(`INSERT INTO action_execution_log (id, organization_id, action_id, attempt, handler, mode, status, error_code, started_at) VALUES (?, ?, ?, 1, 'H', 'execute', ?, ?, datetime('now', ?))`)
      .run(randomUUID(), orgId, randomUUID(), status, errorCode, `-${agoHours} hours`);
  };
  const anomaly = (orgId: string) => SS.list(orgId, { status: "open", domain: "security" }).find((s: any) => s.signal_type === "anomalous_behavior");

  // ===== 1. Rajada de falhas ≥ limiar (10) → publica =====
  const orgA = mkOrg(true);
  for (let i = 0; i < 8; i++) mkExec(orgA, "failed", "autonomy_below_execute");
  for (let i = 0; i < 4; i++) mkExec(orgA, "failed", "step_up_required");
  mkExec(orgA, "done", null); // sucesso não conta
  mkExec(orgA, "failed", "handler_error", 48); // fora da janela (48h) não conta
  const r1 = SA.evaluate(orgA);
  check("rajada de 12 falhas na janela → publica 1", r1.published === 1);
  const sig = anomaly(orgA);
  check("sinal security/anomalous_behavior basis=fact", !!sig && sig.basis === "fact");
  check("evidência: failedCount=12 (done e fora-da-janela não contam)", sig.evidence?.failedCount === 12);
  check("evidência: breakdown por error_code (2 códigos)", Array.isArray(sig.evidence?.byErrorCode) && sig.evidence.byErrorCode.length === 2);
  check("severidade escala (12 ≥ 10 → attention)", sig.severity === "attention");

  // ===== 2. Volume alto → severidade sobe =====
  const orgHi = mkOrg(true);
  for (let i = 0; i < 35; i++) mkExec(orgHi, "failed", "handler_error"); // ≥ 3× limiar
  SA.evaluate(orgHi);
  check("35 falhas (≥3× limiar) → critical", anomaly(orgHi)?.severity === "critical");

  // ===== 3. Idempotência: re-evaluate não duplica =====
  const r1b = SA.evaluate(orgA);
  check("re-evaluate não duplica (dedupe por org)", SS.list(orgA, { status: "open", domain: "security" }).length === 1 && r1b.published === 1);

  // ===== 4. Sweep: volta ao normal → resolve o sinal aberto =====
  db.prepare(`DELETE FROM action_execution_log WHERE organization_id = ?`).run(orgA); // sem falhas na janela agora
  const r4 = SA.evaluate(orgA);
  check("normalizou → resolve o sinal (sweep)", r4.published === 0 && r4.resolved === 1);
  check("sinal fica resolved (some do open)", !anomaly(orgA));

  // ===== 5. Abaixo do limiar → não publica =====
  const orgLow = mkOrg(true);
  for (let i = 0; i < 5; i++) mkExec(orgLow, "failed", "handler_error");
  check("5 falhas (< 10) → não publica", SA.evaluate(orgLow).published === 0 && !anomaly(orgLow));

  // ===== 6. runAll só opt-in + isolamento =====
  const orgOff = mkOrg(false);
  for (let i = 0; i < 20; i++) mkExec(orgOff, "failed", "handler_error");
  const all = SA.runAll();
  check("runAll ignora org sem flag (isolamento/opt-in)", !anomaly(orgOff) && all.orgs >= 1);

  console.log("\n=== TEST: Security Anomaly Detector (ADR-159 F6/D6) ===\n");
  for (const rr of results) console.log(`${rr.ok ? "✅" : "❌"} ${rr.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Security Anomaly Detector (F6) OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
