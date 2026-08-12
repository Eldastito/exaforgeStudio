/**
 * TEST — Lembrete proativo do gate de redução de legado (PRD 6 / ADR-163 F16).
 * DB-backed, det., isolado. Prova (§107/§112, convenção nº 12):
 *   - sweep publica business_signal quando há candidato ready_to_retire;
 *   - idempotente (dedupe) — 2º sweep não duplica;
 *   - resolve o sinal quando não há mais candidato (sem ruído residual);
 *   - só orgs com telemetria ligada; advisório (severity info); multi-tenant;
 *   - maybeWeeklySweep: gate semanal (roda, depois not_due; disabled pula).
 *
 * Uso: npm run test:legacy-reduction-reminder
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-lrr-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-lrr-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { LegacyReductionReminderService: REM } = await import("../src/server/LegacyReductionReminderService.js");

  const A = `org_${randomUUID().slice(0, 8)}`, B = `org_${randomUUID().slice(0, 8)}`, C = `org_${randomUUID().slice(0, 8)}`;
  // A: telemetria ON + adoção que prova substituição. B: telemetria ON mas sem dados.
  // C: telemetria OFF (não deve ser varrida).
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical, plan_id, billing_status, ux_telemetry_enabled) VALUES (?, ?, 'X','active','varejo','autonomo','active',1)`).run(randomUUID(), A);
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical, plan_id, billing_status, ux_telemetry_enabled) VALUES (?, ?, 'X','active','varejo','autonomo','active',1)`).run(randomUUID(), B);
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical, plan_id, billing_status, ux_telemetry_enabled) VALUES (?, ?, 'X','active','varejo','autonomo','active',0)`).run(randomUUID(), C);

  const ev = (org: string, surface: string, userId: string, n: number) => {
    for (let i = 0; i < n; i++)
      db.prepare(`INSERT INTO ux_telemetry_events (id, organization_id, user_id, event_type, surface) VALUES (?, ?, ?, 'view_opened', ?)`).run(randomUUID(), org, userId, surface);
  };
  // A: insights→hoje pronto (hoje 20/3 usuários, insights 0).
  ev(A, "hoje", "u1", 8); ev(A, "hoje", "u2", 7); ev(A, "hoje", "u3", 5);
  // C também tem dados, mas telemetria OFF → não varre.
  ev(C, "hoje", "u1", 20);

  const sigCount = (org: string) => (db.prepare(`SELECT COUNT(*) n FROM business_signals WHERE organization_id = ? AND signal_type = 'legacy_ux_ready_to_retire' AND status = 'open'`).get(org) as any).n;

  // ═══════════════ 1. sweep publica quando há candidato ═══════════════
  const r1 = REM.sweep();
  check("1.1 varreu só orgs com telemetria ON (A e B, não C)", r1.orgs === 2);
  check("1.2 publicou ≥ 1 (org A pronta)", r1.published >= 1);
  check("1.3 sinal aberto em A", sigCount(A) === 1);
  check("1.4 org B (sem dados) não gera sinal", sigCount(B) === 0);
  check("1.5 org C (telemetria OFF) não gera sinal", sigCount(C) === 0);

  // ═══════════════ 2. sinal é advisório (severity info) + evidência ═══════════════
  const sig = db.prepare(`SELECT severity, evidence_json FROM business_signals WHERE organization_id = ? AND signal_type = 'legacy_ux_ready_to_retire'`).get(A) as any;
  check("2.1 severity info (baixa urgência, não compete com risco)", sig.severity === "info");
  check("2.2 evidência lista os candidatos", /candidates/.test(sig.evidence_json) && /insights/.test(sig.evidence_json));

  // ═══════════════ 3. idempotente (dedupe) ═══════════════
  REM.sweep();
  check("3.1 2º sweep não duplica (dedupe)", sigCount(A) === 1);

  // ═══════════════ 4. resolve quando não há mais candidato ═══════════════
  // Some com a adoção de A e faz o legado ressurgir → deixa de ser ready.
  db.prepare(`DELETE FROM ux_telemetry_events WHERE organization_id = ?`).run(A);
  ev(A, "insights", "u1", 30); // legado voltou a ser usado; hoje zerado
  const r2 = REM.sweep();
  check("4.1 resolve o sinal quando não há candidato", r2.resolved >= 1 && sigCount(A) === 0);

  // ═══════════════ 5. maybeWeeklySweep — gate semanal ═══════════════
  db.prepare(`DELETE FROM platform_settings WHERE key LIKE 'legacy_reduction_reminder%'`).run();
  const w1 = REM.maybeWeeklySweep();
  check("5.1 1ª chamada roda (result presente)", !!w1.result && !w1.skipped);
  const w2 = REM.maybeWeeklySweep();
  check("5.2 2ª chamada logo em seguida → not_due", w2.skipped === "not_due");
  REM.setEnabled(false);
  const w3 = REM.maybeWeeklySweep();
  check("5.3 desligado → disabled", w3.skipped === "disabled");
  REM.setEnabled(true);

  // ── relatório ──
  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} legacy-reduction-reminder: ${passed}/${results.length} checks`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
