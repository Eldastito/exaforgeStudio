/**
 * TEST — PRD 2 F4.1 (§21-26): primitivas determinísticas de anomalia. Biblioteca
 * pura (sem DB): baseline (média/percentil/desvio) + deviation + minSample +
 * threshold + cooldown + TTL. Base pro registry (F4.2) e detectores (F4.3).
 *
 * Uso: npm run test:anomaly-primitives
 */
import { mean, stdDev, percentile, evaluateAnomaly, cooldownActive, ttlIso } from "../src/server/anomalyPrimitives.js";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps;

async function main() {
  // ===== 1. Estatística base =====
  check("1.1 mean", near(mean([10, 20, 30]), 20));
  check("1.2 stdDev amostral (n-1)", near(stdDev([2, 4, 6, 8]), Math.sqrt(20 / 3)));
  check("1.3 percentile interpola (p50 de [10,20,30,40] = 25)", near(percentile([10, 20, 30, 40], 50), 25));
  check("1.4 percentile extremos", percentile([10, 20, 30, 40], 0) === 10 && percentile([10, 20, 30, 40], 100) === 40);

  // ===== 2. evaluateAnomaly — queda/alta/normal =====
  const drop = evaluateAnomaly({ current: 17, sample: [26, 27, 25, 28], method: "relative", threshold: 0.2, direction: "drop" });
  check("2.1 queda de conversão 26.5→17 (~36%) é anomalia (drop)", drop.isAnomaly && drop.direction === "drop" && drop.magnitude > 0.3);
  const normal = evaluateAnomaly({ current: 25, sample: [26, 27, 25, 28], method: "relative", threshold: 0.2, direction: "both" });
  check("2.2 dentro do normal NÃO é anomalia", !normal.isAnomaly);
  const spike = evaluateAnomaly({ current: 40, sample: [26, 27, 25, 28], method: "relative", threshold: 0.2, direction: "spike" });
  check("2.3 alta (spike) detectada quando pedida", spike.isAnomaly && spike.direction === "spike");

  // ===== 3. Filtro de direção =====
  const wrongDir = evaluateAnomaly({ current: 40, sample: [26, 27, 25, 28], method: "relative", threshold: 0.2, direction: "drop" });
  check("3.1 spike NÃO conta quando só drop é pedido", !wrongDir.isAnomaly && wrongDir.direction === "spike");

  // ===== 4. minSample + sem baseline (fail-safe §25) =====
  const small = evaluateAnomaly({ current: 5, sample: [26, 27], minSample: 5, threshold: 0.2 });
  check("4.1 amostra < minSample → não dispara (belowMinSample)", !small.isAnomaly && small.belowMinSample);
  const noBase = evaluateAnomaly({ current: 5, threshold: 0.2 });
  check("4.2 sem baseline nem amostra → não dispara", !noBase.isAnomaly && noBase.baseline == null);

  // ===== 5. z-score + absolute + baseline zero =====
  const z = evaluateAnomaly({ current: 30, sample: [10, 10, 10, 10, 20], method: "zscore", threshold: 3, direction: "spike" });
  check("5.1 z-score: outlier claro (>3σ) é anomalia", z.isAnomaly && (z.zscore ?? 0) > 3);
  const abs = evaluateAnomaly({ current: 100, baseline: 40, method: "absolute", threshold: 50, direction: "spike" });
  check("5.2 absolute: delta 60 ≥ threshold 50 é anomalia", abs.isAnomaly && abs.deltaAbsolute === 60);
  const zeroBase = evaluateAnomaly({ current: 10, baseline: 0, method: "relative", threshold: 0.2 });
  check("5.3 baseline 0 no modo relativo → magnitude 0 (use absolute)", !zeroBase.isAnomaly);

  // ===== 6. Cooldown + TTL =====
  const now = Date.parse("2026-08-10T12:00:00Z");
  check("6.1 cooldown ativo dentro da janela", cooldownActive(new Date(now - 3600e3).toISOString(), 6 * 3600e3, now));
  check("6.2 cooldown expirado fora da janela", !cooldownActive(new Date(now - 8 * 3600e3).toISOString(), 6 * 3600e3, now));
  check("6.3 sem último disparo → sem cooldown", !cooldownActive(null, 6 * 3600e3, now));
  check("6.4 ttlIso = agora + ttl", ttlIso(3600e3, now) === new Date(now + 3600e3).toISOString());

  console.log("\n=== TEST: Anomaly primitives F4.1 (PRD 2) ===\n");
  for (const rr of results) console.log(`${rr.ok ? "✅" : "❌"} ${rr.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Anomaly primitives F4.1 OK.");
}

main().catch((e) => { console.error(e); process.exit(1); });
