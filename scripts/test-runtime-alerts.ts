/**
 * TESTE — RuntimeAlertPublisher (ADR-152 §17): exceções do Runtime PROATIVAS.
 * ----------------------------------------------------------------------------
 * Prova, offline, que o publisher empurra as exceções do Runtime pra o ledger
 * `business_signals` (dedupe, domain 'runtime') e detecta os dois casos que
 * faltavam (§17): SLA EM RISCO antes de estourar + processo SEM EVOLUÇÃO;
 * e faz SELF-HEAL do que sumiu.
 *
 * Uso:  npm run test:runtime-alerts
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-runtime-alerts-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-runtime-alerts-1";

let failures = 0; const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { RuntimeAlertPublisher } = await import("../src/server/RuntimeAlertPublisher.js");

  const NOW = new Date("2026-09-10T12:00:00Z");
  const A = `org_A_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'A', 'active')`).run(randomUUID(), A);

  const mkPI = (status: string, updatedAt: string) => {
    const id = randomUUID();
    db.prepare(`INSERT INTO process_instances (id, organization_id, process_definition_id, process_type, status, current_step, updated_at, started_at) VALUES (?, ?, 'pd1', 'cobranca', ?, 'passo1', ?, ?)`)
      .run(id, A, status, updatedAt, updatedAt);
    return id;
  };
  const mkAction = (status: string, deadlineAt: string) => {
    const id = randomUUID();
    db.prepare(`INSERT INTO decision_actions (id, organization_id, domain, action_type, title, status, deadline_at) VALUES (?, ?, 'cobranca', 'pix_charge', 'Cobrar cliente', ?, ?)`)
      .run(id, A, status, deadlineAt);
    return id;
  };

  const escalated = mkPI("escalated", "2026-09-10 11:00:00");            // exceção existente → process_escalated
  const stuck = mkPI("executing", "2026-09-10 08:00:00");               // 4h parado → process_stalled (>120min)
  mkPI("executing", "2026-09-10 11:50:00");                              // 10min → NÃO travado
  const overdue = mkAction("approved", "2026-09-10 11:00:00");          // vencido → action_overdue (sla_at_risk/risk)
  const atRisk = mkAction("approved", "2026-09-10 12:30:00");           // 30min → sla_warning (dentro de 60)
  const far = mkAction("approved", "2026-09-10 20:00:00");              // 8h → nada

  const r1 = RuntimeAlertPublisher.run(A, { now: NOW });
  const sig = () => db.prepare(`SELECT signal_type, severity, status, dedupe_key FROM business_signals WHERE organization_id = ? AND domain = 'runtime'`).all(A) as any[];
  const byKey = () => Object.fromEntries(sig().map((s) => [s.dedupe_key, s]));

  // ── 1. exceções + detecções proativas publicadas ──
  let m = byKey();
  check("1.1 processo escalado → sinal", m[`runtime:process_escalated:${escalated}`]?.signal_type === "process_escalated");
  check("1.2 processo sem evolução → process_stalled (attention)", m[`runtime:stuck:${stuck}`]?.signal_type === "process_stalled" && m[`runtime:stuck:${stuck}`]?.severity === "attention");
  check("1.3 ação vencida → action_overdue (risk)", m[`runtime:action_overdue:${overdue}`]?.severity === "risk");
  check("1.4 SLA EM RISCO antes de estourar → sla_warning (attention)", m[`runtime:sla_warning:${atRisk}`]?.signal_type === "sla_at_risk" && m[`runtime:sla_warning:${atRisk}`]?.severity === "attention");
  check("1.5 ação com deadline distante → NÃO alerta", !m[`runtime:sla_warning:${far}`]);
  check("1.6 processo executando há 10min → NÃO travado", !m[`runtime:stuck:${db.prepare(`SELECT id FROM process_instances WHERE organization_id=? AND updated_at='2026-09-10 11:50:00'`).get(A) as any}`]);
  check("1.7 publicou >= 4", r1.published >= 4);

  // ── 2. idempotência: rodar de novo não duplica ──
  const before = sig().length;
  RuntimeAlertPublisher.run(A, { now: NOW });
  check("2.1 dedupe: nº de sinais estável", sig().length === before);

  // ── 3. self-heal: o processo escalado resolveu → sinal auto-resolvido ──
  db.prepare(`UPDATE process_instances SET status = 'completed' WHERE id = ?`).run(escalated);
  const r3 = RuntimeAlertPublisher.run(A, { now: NOW });
  m = byKey();
  check("3.1 escalado resolvido → sinal 'resolved'", m[`runtime:process_escalated:${escalated}`]?.status === "resolved");
  check("3.2 run reporta resolved >= 1", r3.resolved >= 1);
  check("3.3 os demais seguem abertos", m[`runtime:action_overdue:${overdue}`]?.status === "open" && m[`runtime:stuck:${stuck}`]?.status === "open");

  // ── 4. isolamento ──
  const B = `org_B_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'B', 'active')`).run(randomUUID(), B);
  const rB = RuntimeAlertPublisher.run(B, { now: NOW });
  check("4.1 org sem runtime → 0 sinais", rB.published === 0 && (db.prepare(`SELECT COUNT(*) n FROM business_signals WHERE organization_id = ?`).get(B) as any).n === 0);

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name} ${x.detail ? `(${x.detail})` : ""}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} runtime-alerts: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
