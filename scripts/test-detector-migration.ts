/**
 * TEST — PRD 2 F4.3 (§100): migração do 1º detector real (RetailFloor
 * conversionDrop) pro framework de anomalia. Prova de EQUIVALÊNCIA — a decisão
 * via registry+primitiva reproduz EXATAMENTE a fórmula inline anterior, então o
 * comportamento do detector não regride.
 *
 * (O fluxo ponta-a-ponta com dados reais é coberto por test:retail-floor-signals.)
 *
 * Uso: npm run test:detector-migration
 */
import { AnomalyDetectorRegistry } from "../src/server/AnomalyDetectorRegistry.js";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

// A decisão ANTIGA (inline no RetailFloorSignalPublisher, pré-F4.3).
const oldDecision = (prevRate: number, curRate: number) => prevRate > 0 && (prevRate - curRate) / prevRate >= 0.2;
// A decisão NOVA (via framework).
const newDecision = (prevRate: number, curRate: number) => AnomalyDetectorRegistry.evaluate("retail_floor_conversion_drop", { current: curRate, baseline: prevRate }).fires;

async function main() {
  // ===== 1. Registrado com o contrato certo =====
  const def = AnomalyDetectorRegistry.get("retail_floor_conversion_drop");
  check("1.1 detector registrado", !!def && def.domain === "retail_floor");
  check("1.2 contrato: relative/drop/threshold 0.2", def?.method === "relative" && def?.direction === "drop" && def?.threshold === 0.2 && def?.basis === "fact" && def?.severity === "risk");
  check("1.3 default por vertical (retail/moda)", AnomalyDetectorRegistry.byVertical("retail").some((d: any) => d.name === "retail_floor_conversion_drop") && !AnomalyDetectorRegistry.byVertical("clinica").some((d: any) => d.name === "retail_floor_conversion_drop"));

  // ===== 2. Casos representativos =====
  check("2.1 queda 26%→17% (~35%) dispara", newDecision(0.26, 0.17) === true && newDecision(0.26, 0.17) === oldDecision(0.26, 0.17));
  check("2.2 queda pequena 26%→22% (~15%) NÃO dispara", newDecision(0.26, 0.22) === false && newDecision(0.26, 0.22) === oldDecision(0.26, 0.22));
  check("2.3 queda acima do limite (26%→20%, ~23%) dispara", newDecision(0.26, 0.20) === true && newDecision(0.26, 0.20) === oldDecision(0.26, 0.20));
  check("2.4 alta (spike) NÃO conta como drop", newDecision(0.26, 0.30) === false && newDecision(0.26, 0.30) === oldDecision(0.26, 0.30));

  // ===== 3. Equivalência em varredura ampla =====
  let mismatches = 0, fired = 0;
  for (let prev = 5; prev <= 60; prev += 1) {
    for (let cur = 0; cur <= 60; cur += 1) {
      const p = prev / 100, c = cur / 100;
      const o = oldDecision(p, c), n = newDecision(p, c);
      if (o !== n) mismatches++;
      if (n) fired++;
    }
  }
  check("3.1 zero divergências entre a decisão antiga e a nova (varredura)", mismatches === 0);
  check("3.2 a varredura exercitou os dois ramos (alguns disparos)", fired > 0);

  console.log("\n=== TEST: Migração de detector F4.3 (PRD 2) ===\n");
  for (const rr of results) console.log(`${rr.ok ? "✅" : "❌"} ${rr.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Migração de detector F4.3 OK.");
}

main().catch((e) => { console.error(e); process.exit(1); });
