/**
 * TEST — PRD 2 (F4.3+): migração do 2º detector real (ConsumptionSignalPublisher
 * `consumo_acima_padrao`) pro framework de anomalia — e o 1º SPIKE do registry
 * (o piloto F4.3 provou o DROP). A DECISÃO passa a rodar por
 * `AnomalyDetectorRegistry.evaluate` (primitiva pura), não mais por constante
 * inline (`ABOVE_FACTOR`).
 *
 * Prova de EQUIVALÊNCIA HONESTA: a decisão nova reproduz a inline antiga
 * (`recent > base × 1.5`) em TODO ponto, EXCETO no fio exato de 1.5× — onde o
 * inline usava `>` (não dispara) e o registry usa `>=` (dispara). Essa é a única
 * diferença, INTENCIONAL (o contrato do registry vira canônico); a varredura
 * prova que não há nenhuma outra divergência.
 *
 * Uso: npm run test:consumption-detector-migration
 */
import { AnomalyDetectorRegistry } from "../src/server/AnomalyDetectorRegistry.js";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

// Decisão ANTIGA (inline no ConsumptionSignalPublisher, pré-migração): estrito `>`.
const oldDecision = (recent: number, base: number) => base > 0 && recent > base * 1.5;
// Decisão NOVA (via framework): `>=` no threshold 0.5.
const newDecision = (recent: number, base: number) => AnomalyDetectorRegistry.evaluate("consumo_acima_padrao", { current: recent, baseline: base }).fires;
// Fio exato de 1.5× (base par * 1.5 = inteiro) — o único ponto de divergência.
const isBoundary = (recent: number, base: number) => base > 0 && recent === base * 1.5;

async function main() {
  // ===== 1. Registrado com o contrato certo =====
  const def = AnomalyDetectorRegistry.get("consumo_acima_padrao");
  check("1.1 detector registrado no domínio consumption", !!def && def.domain === "consumption");
  check("1.2 contrato: relative/SPIKE/threshold 0.5, attention/fact", def?.method === "relative" && def?.direction === "spike" && def?.threshold === 0.5 && def?.severity === "attention" && def?.basis === "fact");
  check("1.3 universal (sem restrição de vertical → aparece em qualquer uma)", AnomalyDetectorRegistry.byVertical("clinica").some((d: any) => d.name === "consumo_acima_padrao") && AnomalyDetectorRegistry.byVertical("food").some((d: any) => d.name === "consumo_acima_padrao"));

  // ===== 2. Casos representativos =====
  check("2.1 pico forte (base 1 → recente 3, +200%) dispara", newDecision(3, 1) === true && newDecision(3, 1) === oldDecision(3, 1));
  check("2.2 alta pequena (base 1 → recente 1.2, +20%) NÃO dispara", newDecision(1.2, 1) === false && newDecision(1.2, 1) === oldDecision(1.2, 1));
  check("2.3 acima do limite (base 1 → recente 1.6, +60%) dispara", newDecision(1.6, 1) === true && newDecision(1.6, 1) === oldDecision(1.6, 1));
  check("2.4 queda (base 1 → recente 0.5) NÃO conta como spike", newDecision(0.5, 1) === false && newDecision(0.5, 1) === oldDecision(0.5, 1));
  check("2.5 sem base (base 0) → não dispara (fail-safe)", newDecision(5, 0) === false);

  // ===== 3. Diferença ÚNICA no fio de 1.5× (>, inline → >=, registry) =====
  check("3.1 no fio exato: inline não dispara, registry dispara", oldDecision(3, 2) === false && newDecision(3, 2) === true && isBoundary(3, 2));

  // ===== 4. Equivalência em varredura ampla (única divergência = fio) =====
  let boundaryDiffs = 0, nonBoundaryDiffs = 0, fired = 0;
  for (let base = 1; base <= 20; base += 1) {
    for (let recent = 0; recent <= 40; recent += 1) {
      const o = oldDecision(recent, base), n = newDecision(recent, base);
      if (n) fired++;
      if (o !== n) { if (isBoundary(recent, base)) boundaryDiffs++; else nonBoundaryDiffs++; }
    }
  }
  check("4.1 ZERO divergências fora do fio de 1.5×", nonBoundaryDiffs === 0);
  check("4.2 no fio, a única diferença é registry dispara / inline não (intencional)", boundaryDiffs > 0);
  check("4.3 a varredura exercitou os dois ramos (alguns disparos)", fired > 0);

  console.log("\n=== TEST: Migração detector consumo_acima_padrao (PRD 2) ===\n");
  for (const rr of results) console.log(`${rr.ok ? "✅" : "❌"} ${rr.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Migração detector consumo_acima_padrao OK.");
}

main().catch((e) => { console.error(e); process.exit(1); });
