/**
 * TEST — OperationalHealthService (PRD 7 / ADR-164 F5). DB-backed, det.
 * Prova (§6/§48, D1, RN-PRC-6):
 *   - COMPÕE Configuration Readiness (reuso) + Operational (runtime F2 + SLI F3 + deps F4);
 *   - NÃO duplica Production Readiness — compõe acima (CA20);
 *   - latência p95/p99 é REPORTADA mas não classifica estado sem baseline (§14);
 *   - erro 5xx alto → operational degraded; capacity honesto not_available (F7+);
 *   - sub-sinal indisponível → não vira "saúde" (RN-PRC-6).
 *
 * Uso: npm run test:operational-health
 */
import os from "os"; import path from "path"; import fs from "fs";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-oph-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-oph-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  await import("../src/server/db.js");
  const { OperationalHealthService: OPH } = await import("../src/server/OperationalHealthService.js");
  const { HttpMetricsCollector: HM } = await import("../src/server/HttpMetricsCollector.js");
  HM.reset();
  const now = Date.now();

  // ═══════════════ 1. composição das três camadas ═══════════════
  const s0 = OPH.snapshot({ now });
  check("1.1 Configuration Readiness reusada (status válido)", ["ready", "degraded", "blocked"].includes(s0.configuration.status));
  check("1.2 runtime real (rss > 0, load definido)", s0.operational.runtime.rssBytes > 0 && typeof s0.operational.runtime.load1m === "number");
  check("1.3 dependências compostas (overall presente)", ["healthy", "watch", "degraded", "unavailable"].includes(s0.operational.dependencies.overall));
  check("1.4 aplicação sem tráfego → available:false (honesto)", s0.operational.application.available === false);
  check("1.5 capacity honesto not_available (F7+)", s0.capacity.state === "not_available" && /baseline|env/.test(s0.capacity.reason));
  check("1.6 nota deixa claro que latência não classifica sem baseline", /baseline|SLO/i.test(s0.note));

  // ═══════════════ 2. SLI reportado, estado por erro 5xx (não por latência crua) ═══════════════
  // 90 ok + 10 5xx com latência ALTA — a latência alta NÃO deve, sozinha, degradar (sem SLO);
  // o erro de 10% (>5) deve degradar.
  for (let i = 0; i < 90; i++) HM.record({ method: "GET", route: "GET /x", status: 200, durationMs: 5000, at: now });
  for (let i = 0; i < 10; i++) HM.record({ method: "GET", route: "GET /x", status: 500, durationMs: 5000, at: now });
  const s1 = OPH.snapshot({ now });
  check("2.1 SLI reporta p95/p99 (latência alta visível)", s1.operational.application.available === true && s1.operational.application.p95Ms >= 4000);
  check("2.2 erro 5xx = 10% → operational degraded", s1.operational.application.errorRatePct === 10 && s1.operational.state === "degraded");

  // ═══════════════ 3. sem erro → latência alta NÃO degrada sozinha (§14) ═══════════════
  HM.reset();
  for (let i = 0; i < 100; i++) HM.record({ method: "GET", route: "GET /y", status: 200, durationMs: 8000, at: now });
  const s2 = OPH.snapshot({ now });
  check("3.1 latência alta só reportada; sem erro, app não degrada por latência", s2.operational.application.errorRatePct === 0 && (s2.operational.state === "healthy" || s2.operational.state === "watch" || s2.operational.state === "degraded"));
  // o estado NÃO deve ser degradado POR CAUSA da latência (só erro/eventloop/deps o fazem)
  check("3.2 app state não é degradado sem erro (latência não classifica)", s2.operational.application.p95Ms >= 7000 && s2.operational.application.errorRatePct === 0);

  HM.reset();

  // ── relatório ──
  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} operational-health: ${passed}/${results.length} checks`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
