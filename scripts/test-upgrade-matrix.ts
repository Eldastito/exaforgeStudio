/**
 * TEST — Fatia 2.1 (ADR-153): matriz de upgrade origem × destino × módulos.
 *
 * PRD §8.3 exige: "criar teste automatizado para plano origem × plano destino ×
 * vertical × módulos ativos. Nenhum upgrade poderá resultar em perda inesperada."
 *
 * Estratégia:
 *   - Para cada par (origem, destino) onde tier(destino) >= tier(origem):
 *     - Para cada módulo M que está em `PLAN_GRADE[origem].modules`:
 *       - M também deve estar em `PLAN_GRADE[destino].modules` (regra dura).
 *   - Se falhar em algum par, é um bug crítico de política (upgrade estaria
 *     removendo capacidade — G-153-2 violada).
 *
 * Também cobre casos concretos:
 *   - autonomo → start preserva TODOS os módulos do autonomo.
 *   - start → growth preserva TODOS de start.
 *   - growth → scale preserva TODOS de growth.
 *   - scale → enterprise preserva TODOS de scale.
 *   - autonomo → enterprise preserva TODOS (chain completo).
 *   - Downgrade (destino menor): a matriz NÃO exige preservação (dono aceitou
 *     perder). Só valida upgrade.
 *   - PLAN_GRADE inclui todos os 5 tiers.
 *
 * Uso: npm run test:upgrade-matrix
 */
import { PLAN_GRADE } from "../src/server/plansGrade.js";

let failures = 0;
const results: { name: string; ok: boolean; note?: string }[] = [];
function check(name: string, ok: boolean, note?: string) {
  results.push({ name, ok, note });
  if (!ok) failures++;
}

const TIER_ORDER = ["autonomo", "start", "growth", "scale", "enterprise"] as const;
type Tier = typeof TIER_ORDER[number];

function tierIdx(id: string): number {
  return (TIER_ORDER as readonly string[]).indexOf(id);
}

function modulesOf(id: string): string[] {
  const p = PLAN_GRADE.find((pl) => pl.id === id);
  return p?.features.modules || [];
}

async function main() {
  // ===== 1. PLAN_GRADE integridade =====
  check("PLAN_GRADE tem exatamente 5 tiers", PLAN_GRADE.length === 5);
  for (const t of TIER_ORDER) {
    const p = PLAN_GRADE.find((pl) => pl.id === t);
    check(`PLAN_GRADE inclui '${t}'`, !!p);
    check(`PLAN_GRADE.${t}.features.modules é array não-vazio`, Array.isArray(p?.features.modules) && p!.features.modules.length > 0);
  }

  // ===== 2. Matriz origem × destino — nenhum módulo pré-existente sai no upgrade =====
  for (const origem of TIER_ORDER) {
    for (const destino of TIER_ORDER) {
      if (tierIdx(destino) < tierIdx(origem)) continue; // só valida upgrade
      if (origem === destino) continue;                  // no-op
      const modsOrig = modulesOf(origem);
      const modsDest = new Set(modulesOf(destino));
      const perdidos = modsOrig.filter((m) => !modsDest.has(m));
      check(`upgrade ${origem} → ${destino} não remove nenhum módulo (perdidos: ${perdidos.length === 0 ? "0" : perdidos.join(",")})`, perdidos.length === 0);
    }
  }

  // ===== 3. Casos concretos =====
  const autonomoMods = modulesOf("autonomo");
  const startMods = new Set(modulesOf("start"));
  for (const m of autonomoMods) {
    check(`autonomo → start preserva '${m}'`, startMods.has(m));
  }

  const growthMods = new Set(modulesOf("growth"));
  for (const m of modulesOf("start")) {
    check(`start → growth preserva '${m}'`, growthMods.has(m));
  }

  const scaleMods = new Set(modulesOf("scale"));
  for (const m of modulesOf("growth")) {
    check(`growth → scale preserva '${m}'`, scaleMods.has(m));
  }

  const entMods = new Set(modulesOf("enterprise"));
  for (const m of modulesOf("scale")) {
    check(`scale → enterprise preserva '${m}'`, entMods.has(m));
  }

  // Chain completa autonomo → enterprise
  for (const m of autonomoMods) {
    check(`autonomo → enterprise (chain) preserva '${m}'`, entMods.has(m));
  }

  // ===== 4. Comigo (copiloto) especificamente — foco da Decisão #1 =====
  for (const t of TIER_ORDER) {
    check(`copiloto está em ${t} (Decisão #1 aprovada — F2.1)`, modulesOf(t).includes("copiloto"));
  }

  // ===== 5. Módulos "topo" só existem no tier certo (sanity: sem regressão inversa) =====
  //   - vms/clinica/prospect são exclusivos do Enterprise (blueprints comerciais).
  //   - valor entra no Scale+.
  //   - retail entra no Scale+.
  check("vms só em enterprise", !modulesOf("scale").includes("vms") && modulesOf("enterprise").includes("vms"));
  check("clinica só em enterprise", !modulesOf("scale").includes("clinica") && modulesOf("enterprise").includes("clinica"));
  check("prospect só em enterprise", !modulesOf("scale").includes("prospect") && modulesOf("enterprise").includes("prospect"));
  check("valor entra no scale+", !modulesOf("growth").includes("valor") && modulesOf("scale").includes("valor"));
  check("retail entra no scale+", !modulesOf("growth").includes("retail") && modulesOf("scale").includes("retail"));

  // ===== 6. Downgrade NÃO é obrigado a preservar (fatia F6.2 vai transformar em read_only) =====
  //   Aqui apenas confirmamos que o downgrade REMOVE módulos (comportamento
  //   esperado do teto do plano). F6.2 introduz read_only pra preservar dados.
  const downgradePerdidos = modulesOf("enterprise").filter((m) => !new Set(modulesOf("autonomo")).has(m));
  check("downgrade enterprise → autonomo remove módulos (esperado — F6.2 fará read_only)", downgradePerdidos.length > 0);

  // ===== Resultado =====
  console.log("\n=== Upgrade Matrix (F2.1) ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.note ? "  (" + r.note + ")" : ""}`);
  console.log(`\n${results.length - failures}/${results.length} checks OK`);
  if (failures > 0) process.exit(1);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
