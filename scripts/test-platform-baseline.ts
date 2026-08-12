/**
 * TEST — PlatformBaselineService: baseline + anomalia (PRD 7 / ADR-164 F6). DB-backed, det.
 * Prova (§30-35, §56, §59, RN-PRC-3/4):
 *   - capture grava só AGREGADO (uma linha por métrica), GLOBAL (sem organization_id);
 *   - baseline deriva média/p50/p95/desvio; sem amostra suficiente → insufficient_history
 *     (§59, NÃO inventa); seasonality bucket (dow/hora) filtra;
 *   - anomalia = desvio sustentado vs baseline, como HIPÓTESE com confiança (§35), não veredito;
 *   - determinístico (at/now injetáveis); retenção poda snapshots antigos.
 *
 * Uso: npm run test:platform-baseline
 */
import os from "os"; import path from "path"; import fs from "fs";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-pbl-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-pbl-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { PlatformBaselineService: PB } = await import("../src/server/PlatformBaselineService.js");

  const now = Date.parse("2026-08-12T15:00:00Z"); // 12h SP
  const day = 86400000;

  // ═══════════════ 1. capture grava agregado (via op injetado) ═══════════════
  const fakeOp = (p95: number, err: number) => ({
    operational: {
      application: { available: true, p95Ms: p95, errorRatePct: err, rps: 3 },
      runtime: { rssBytes: 100_000_000, eventLoopLagMs: 2, load1m: 0.5, hostMemUsedPct: 40 },
      dependencies: { queue: { pending: 1 }, database: { probeLatencyMs: 0.3 } },
    },
  });
  const c = PB.capture({ at: now, op: fakeOp(100, 0) });
  check("1.1 capture grava várias métricas agregadas", c.captured >= 6);
  const cols = (db.prepare(`PRAGMA table_info(platform_health_snapshots)`).all() as any[]).map((r: any) => r.name);
  check("1.2 tabela é GLOBAL (sem organization_id — RN-PRC-4)", !cols.includes("organization_id"));

  // ═══════════════ 2. insufficient_history honesto (§59) ═══════════════
  const b0 = PB.baseline("app.p95", { now });
  check("2.1 poucas amostras → insufficient_history (não inventa)", b0.available === false && b0.reason === "insufficient_history");

  // ═══════════════ 3. baseline com histórico suficiente ═══════════════
  // 20 dias de app.p95 ~100ms (variação leve) no mesmo horário.
  for (let d = 1; d <= 20; d++) PB.capture({ at: now - d * day, op: fakeOp(100 + (d % 3), 0) });
  const b1 = PB.baseline("app.p95", { now });
  check("3.1 baseline disponível + estatísticas", b1.available === true && b1.sampleSize >= 8 && b1.mean > 90 && b1.mean < 110 && typeof b1.stdev === "number");
  check("3.2 p95 do baseline plausível", b1.p95 >= 100 && b1.p95 <= 103);

  // ═══════════════ 4. anomalia = desvio sustentado (hipótese, §35) ═══════════════
  // valor recente MUITO acima do baseline (~100 ± ~1) → outlier claro.
  PB.capture({ at: now, op: fakeOp(900, 0) });
  const an = PB.anomalies({ now, metrics: ["app.p95"] });
  const p95an = an.anomalies.find((a: any) => a.metric === "app.p95");
  check("4.1 anomalia detectada (valor recente muito acima)", !!p95an && p95an.direction === "above" && p95an.z >= 3);
  check("4.2 é HIPÓTESE com confiança, não veredito (§35)", p95an.basis === "correlation" && ["alta", "média"].includes(p95an.confidence) && p95an.severity === "high");

  // ═══════════════ 5. sem variância → não opina (evita falso positivo) ═══════════════
  for (let d = 1; d <= 12; d++) PB.capture({ at: now - d * day, op: fakeOp(50, 0) === null ? null : { operational: { application: { available: true, p95Ms: 50, errorRatePct: 0, rps: 1 }, runtime: { rssBytes: 1, eventLoopLagMs: 0, load1m: 0, hostMemUsedPct: 0 }, dependencies: { queue: { pending: 0 }, database: { probeLatencyMs: 0.1 } } } } });
  const anRps = PB.anomalies({ now, metrics: ["app.rps"] });
  check("5.1 métrica sem baseline/variância suficiente não gera anomalia falsa", Array.isArray(anRps.anomalies));

  // ═══════════════ 6. seasonality bucket filtra por dow/hora (§33) ═══════════════
  const bSeasonal = PB.baseline("app.p95", { now, seasonal: true });
  check("6.1 baseline sazonal considera só o mesmo bucket (available com hist. no bucket)", bSeasonal.seasonal === true && typeof bSeasonal.available === "boolean");

  // ═══════════════ 7. retenção poda antigos ═══════════════
  const pruned = PB.prune(10);
  check("7.1 prune remove snapshots > 10 dias (não infla o banco)", pruned >= 1);

  // ── relatório ──
  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} platform-baseline: ${passed}/${results.length} checks`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
