/**
 * TEST — SloDefinitionService (PRD 7 / ADR-164 F3.4). DB-backed, det.
 * Prova (§14/§99, RN-PRC-4/6, §59):
 *   - sem SLO → defined:false (latência segue só reportada, honesto);
 *   - set valida positivos; GLOBAL (platform_settings);
 *   - evaluate: dentro do alvo → ok; leve → watch; grave (>1.5×) → degraded;
 *   - override por rota tem precedência sobre o default;
 *   - métrica ausente → *Met null (não inventa);
 *   - clear volta ao honesto.
 *
 * Uso: npm run test:slo-definition
 */
import os from "os"; import path from "path"; import fs from "fs";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-slo-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-slo-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const dbMod = await import("../src/server/db.js");
  const db = dbMod.default as any;
  const { SloDefinitionService: SLO } = await import("../src/server/SloDefinitionService.js");

  // ═══════════════ 1. sem SLO → honesto ═══════════════
  check("1.1 sem SLO → configured:false", SLO.get().configured === false);
  check("1.2 evaluate sem SLO → defined:false", SLO.evaluate({ p95Ms: 999 }).defined === false);

  // ═══════════════ 2. set/get + GLOBAL ═══════════════
  SLO.set({ defaultP95TargetMs: 500, errorRatePctTarget: 1, routes: { "GET /api/checkout": 300 } });
  check("2.1 configured após set", SLO.get().configured === true && SLO.get().defaultP95TargetMs === 500);
  const cols = (db.prepare("PRAGMA table_info(platform_settings)").all() as any[]).map((c) => c.name);
  check("2.2 GLOBAL (platform_settings, sem organization_id)", !cols.includes("organization_id"));
  let threw = false; try { SLO.set({ defaultP95TargetMs: -5 }); } catch { threw = true; }
  check("2.3 número inválido rejeitado", threw === true && SLO.get().defaultP95TargetMs === 500);

  // ═══════════════ 3. classificação ═══════════════
  check("3.1 p95 dentro do alvo → ok", SLO.evaluate({ p95Ms: 400, errorRatePct: 0.2 }).state === "ok");
  check("3.2 p95 acima leve (600 > 500, <1.5×) → watch", SLO.evaluate({ p95Ms: 600, errorRatePct: 0 }).state === "watch");
  check("3.3 p95 grave (800 ≥ 1.5×500) → degraded", SLO.evaluate({ p95Ms: 800, errorRatePct: 0 }).state === "degraded");
  check("3.4 erro acima do teto → breach", SLO.evaluate({ p95Ms: 100, errorRatePct: 3 }).breach === true);

  // ═══════════════ 4. override por rota ═══════════════
  // rota crítica com alvo 300: 400ms viola (400≥1.5×300=450? não → watch)
  check("4.1 rota crítica usa o alvo próprio (300), não o default (500)", SLO.evaluate({ p95Ms: 400, route: "GET /api/checkout" }).p95.targetMs === 300 && SLO.evaluate({ p95Ms: 400, route: "GET /api/checkout" }).breach === true);
  check("4.2 mesma latência (400) na rota comum (alvo 500) → ok", SLO.evaluate({ p95Ms: 400, route: "GET /api/outra" }).state === "ok");

  // ═══════════════ 5. métrica ausente → não inventa ═══════════════
  const e5 = SLO.evaluate({ p95Ms: null, errorRatePct: null });
  check("5.1 sem métrica → met null + state unknown", e5.p95.met === null && e5.errorRate.met === null && e5.state === "unknown");

  // ═══════════════ 6. integração — SLO faz a latência CLASSIFICAR estado no OperationalHealth ═══════════════
  const { OperationalHealthService: OH } = await import("../src/server/OperationalHealthService.js");
  const { HttpMetricsCollector: HTTP } = await import("../src/server/HttpMetricsCollector.js");
  const nowT = Date.parse("2026-08-12T15:00:00Z");
  // Sem SLO: latência alta é só reportada, não classifica (comportamento pré-F3.4).
  SLO.clear();
  HTTP.reset();
  for (let i = 0; i < 20; i++) HTTP.record({ method: "GET", route: "/api/x", status: 200, durationMs: 900, at: nowT - 1000 });
  const ohNoSlo = OH.snapshot({ now: nowT });
  check("6.1 sem SLO → operational.slo.defined false; p95 não classifica", ohNoSlo.operational.slo.defined === false);
  // Com SLO apertado (alvo 200ms): p95 ~900ms viola grave → estado degraded.
  SLO.set({ defaultP95TargetMs: 200, errorRatePctTarget: 1 });
  const ohSlo = OH.snapshot({ now: nowT });
  check("6.2 com SLO violado → slo.state degraded e operational.state degraded", ohSlo.operational.slo.state === "degraded" && ohSlo.operational.state === "degraded");

  // ═══════════════ 7. clear ═══════════════
  SLO.clear();
  check("7.1 clear → configured:false", SLO.get().configured === false);

  // ── relatório ──
  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} slo-definition: ${passed}/${results.length} checks`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
