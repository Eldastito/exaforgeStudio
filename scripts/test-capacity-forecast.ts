/**
 * TEST — CapacityForecastService: forecast de capacidade (PRD 7 / ADR-164 F8).
 * DB-backed, det. Prova (§80-85, §59, RN-PRC-9/RN-PRC-1):
 *   - sem histórico suficiente → insufficient_history (não inventa);
 *   - tendência de alta com bom ajuste → slope>0, confiança alta, daysToTarget coerente;
 *   - alvo já ultrapassado → approaching:false/already_at_or_above;
 *   - série plana com muitos dias → estável (slope≈0), não "se aproximando";
 *   - forecastCapacity aponta o primeiro gargalo (menor daysToTarget);
 *   - determinismo com `now` injetado.
 *
 * Uso: npm run test:capacity-forecast
 */
import os from "os"; import path from "path"; import fs from "fs";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-fc-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-fc-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const dbMod = await import("../src/server/db.js");
  const db = dbMod.default as any;
  const { CapacityForecastService: FC } = await import("../src/server/CapacityForecastService.js");
  const now = Date.parse("2026-08-12T15:00:00Z");
  const DAY = 86400000;

  const ins = db.prepare(`INSERT INTO platform_health_snapshots (id, captured_at, metric, value, dow, hour) VALUES (?, ?, ?, ?, ?, ?)`);
  let idc = 0;
  const seed = (metric: string, atMs: number, value: number) => ins.run(`fc-${idc++}`, new Date(atMs).toISOString(), metric, value, 0, 12);

  // ═══════════════ 1. sem histórico → insufficient_history (§59) ═══════════════
  const f0 = FC.forecast("host.mem_used_pct", { now });
  check("1.1 sem dados → insufficient_history + available:false", f0.available === false && f0.reason === "insufficient_history");
  // 3 dias só (< MIN_DAYS=5) ainda insuficiente
  for (let d = 1; d <= 3; d++) seed("host.mem_used_pct", now - d * DAY, 50);
  check("1.2 3 dias distintos < MIN_DAYS → insufficient_history", FC.forecast("host.mem_used_pct", { now }).available === false);

  // ═══════════════ 2. tendência de alta clara → slope>0, alta confiança ═══════════════
  // 20 dias subindo 1.5%/dia, começando em 60 → chega perto de 94 dentro da janela
  for (let d = 0; d <= 20; d++) seed("host.load1m", now - (20 - d) * DAY, 0.4 + d * 0.06); // 0.4 → 1.6 em 20 dias
  const fL = FC.forecast("host.load1m", { now, days: 30, horizonDays: 30 });
  check("2.1 tendência de alta → available + slope>0", fL.available === true && fL.slopePerDay > 0);
  check("2.2 ajuste bom + 21 dias → confiança alta", fL.confidence === "alta" && fL.r2 >= 0.9);
  check("2.3 basis trend (hipótese, §35)", fL.basis === "trend");
  check("2.4 alvo crítico 2.0 → se aproximando, daysToTarget>0", fL.targetCrossing.approaching === true && fL.targetCrossing.daysToTarget > 0);

  // ═══════════════ 3. alvo já ultrapassado → não se aproxima ═══════════════
  for (let d = 0; d <= 10; d++) seed("db.probe_ms", now - (10 - d) * DAY, 60 + d); // já acima do alvo 50, subindo
  const fD = FC.forecast("db.probe_ms", { now });
  check("3.1 valor atual já ≥ alvo → approaching:false/already_at_or_above", fD.targetCrossing.approaching === false && fD.targetCrossing.reason === "already_at_or_above");

  // ═══════════════ 4. série plana com muitos dias → estável, não se aproxima ═══════════════
  for (let d = 0; d <= 14; d++) seed("app.p95", now - (14 - d) * DAY, 200); // constante
  const fP = FC.forecast("app.p95", { now });
  check("4.1 plana → slope≈0", Math.abs(fP.slopePerDay) < 0.001);
  check("4.2 plana muitos dias → confiança alta (estável)", fP.confidence === "alta");
  check("4.3 plana abaixo do alvo → approaching:false/flat_or_declining", fP.targetCrossing.approaching === false && fP.targetCrossing.reason === "flat_or_declining");

  // ═══════════════ 5. forecastCapacity → primeiro gargalo ═══════════════
  const cap = FC.forecastCapacity({ now, horizonDays: 60 });
  check("5.1 firstBottleneck presente (load1m se aproxima)", !!cap.firstBottleneck && cap.firstBottleneck.metric === "host.load1m");
  check("5.2 lista todas as métricas de capacidade", Array.isArray(cap.forecasts) && cap.forecasts.length === 5);

  // ═══════════════ 6. determinismo ═══════════════
  const a = FC.forecast("host.load1m", { now }); const b = FC.forecast("host.load1m", { now });
  check("6.1 mesmo now → mesmo resultado", JSON.stringify(a) === JSON.stringify(b));

  // ── relatório ──
  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} capacity-forecast: ${passed}/${results.length} checks`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
