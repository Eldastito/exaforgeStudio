/**
 * TEST — Endurecimento transversal do PRD 7 (ADR-164 F14). DB-backed, det.
 *
 * Codifica como REGRESSÃO os guardrails RN-PRC que atravessam todos os serviços de
 * confiabilidade — se alguma fatia futura regredir um deles, este teste quebra:
 *   - RN-PRC-6/§59 — telemetria DESLIGADA (default) → toda leitura é honesta (available:false/
 *     not_available/insufficient_history/awaiting_load_test), NUNCA "saúde";
 *   - CA17 — anti-spam do alerta segura sob rajada (1 evento aberto por chave);
 *   - RN-PRC-5/§90 — normalização de rota tira id/PII e querystring (cardinalidade);
 *   - §102 — Protection Mode nasce em shadow (active:false).
 *
 * Uso: npm run test:platform-hardening
 */
import os from "os"; import path from "path"; import fs from "fs";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-hard-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-hard-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  await import("../src/server/db.js");
  const { PlatformTelemetryService: TEL } = await import("../src/server/PlatformTelemetryService.js");
  const { OperationalHealthService: OH } = await import("../src/server/OperationalHealthService.js");
  const { PlatformBaselineService: PB } = await import("../src/server/PlatformBaselineService.js");
  const { CapacityForecastService: FC } = await import("../src/server/CapacityForecastService.js");
  const { CapacityEnvelopeService: ENV } = await import("../src/server/CapacityEnvelopeService.js");
  const { PlatformAlertService: AL } = await import("../src/server/PlatformAlertService.js");
  const { PlatformProtectionModeService: PM } = await import("../src/server/PlatformProtectionModeService.js");
  const { HttpMetricsCollector: HTTP } = await import("../src/server/HttpMetricsCollector.js");
  const now = Date.parse("2026-08-12T15:00:00Z");

  // ═══════════════ 1. telemetria desligada (default) → tudo honesto (RN-PRC-6/§59) ═══════════════
  check("1.1 telemetria nasce desligada", TEL.isEnabled() === false);
  check("1.2 baseline sem histórico → insufficient_history (não inventa)", PB.baseline("app.p95", { now }).available === false);
  check("1.3 forecast sem histórico → insufficient_history", FC.forecast("host.mem_used_pct", { now }).available === false);
  check("1.4 envelope sem teste de carga → awaiting_load_test", ENV.current().established === false);
  const oh = OH.snapshot({ now });
  check("1.5 operational health: capacity not_available (honesto, não 'saúde')", oh.capacity.state === "not_available");
  check("1.6 anomalias sem baseline → lista vazia (não opina)", (PB.anomalies({ now }).anomalies || []).length === 0);

  // ═══════════════ 2. anti-spam do alerta segura sob rajada (CA17) ═══════════════
  for (let i = 0; i < 25; i++) AL.raise({ eventType: "anomaly", severity: "warning", dedupeKey: "burst_key", title: "rajada", now: now + i * 1000 });
  const open = AL.listOpen().filter((e: any) => e.dedupe_key === "burst_key");
  check("2.1 25 raises na mesma chave → 1 evento aberto (anti-spam)", open.length === 1 && open[0].occurrences === 25);

  // ═══════════════ 3. normalização de rota tira id/PII e querystring (RN-PRC-5/§90) ═══════════════
  const r1 = HTTP.normalizeRoute("GET", "/api/users/12345/orders/98765?token=abc");
  check("3.1 ids viram :id e querystring some", !/12345|98765|token=abc/.test(r1) && r1.includes(":id"));
  const r2 = HTTP.normalizeRoute("GET", "/api/org/550e8400-e29b-41d4-a716-446655440000/x");
  check("3.2 uuid vira :id (sem vazar identificador)", !/550e8400/.test(r2) && r2.includes(":id"));

  // ═══════════════ 4. Protection Mode nasce em shadow (§102) ═══════════════
  check("4.1 enforcement desligado por padrão", PM.isEnforcing() === false);
  const pm = PM.assess({ now, health: { operational: { state: "degraded" } }, headroom: { resources: [{ resource: "host.mem_used_pct", available: true, zone: "CRITICAL" }] } });
  check("4.2 mesmo em PROTECTED → active:false (shadow não altera nada)", pm.state === "PROTECTED" && pm.active === false);

  // ── relatório ──
  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} platform-hardening: ${passed}/${results.length} checks`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
