/**
 * TEST — Coerência de venda dos módulos (guard contra "módulo morto"). Det.
 * Invariante: TODO módulo gated por rota (MODULE_BY_ROUTE) precisa ser
 * ALCANÇÁVEL por alguém — em algum tier de plano, no catálogo de add-ons, nos
 * add-ons operacionais grátis, ou core. Um módulo route-gated que ninguém pode
 * habilitar é uma feature entregue e inalcançável (foi o caso da Escola antes
 * de virar vendável). Este teste teria pego aquele gap sozinho.
 *
 * Também fixa a recomendação de bundle da vertical `petshop` (consome o módulo
 * `clinica`, igual `saude`): sem o hint, o petshop no Growth ficaria sem caminho
 * pro módulo central da própria vertical.
 *
 * Uso: npm run test:module-sellability-coherence
 */
import { PLAN_GRADE, PLAN_BUNDLES } from "../src/server/plansGrade.js";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { ModuleService } = await import("../src/server/ModuleService.js");
  const { AddonService } = await import("../src/server/AddonService.js");
  const { PLAN_FREE_ADDONS } = await import("../src/server/verticals.js");

  // Universo de módulos ALCANÇÁVEIS.
  const inSomePlan = new Set<string>();
  for (const p of PLAN_GRADE) for (const m of p.features.modules) inSomePlan.add(m);
  const inAddonCatalog = new Set<string>();
  for (const arr of Object.values(AddonService.ADDON_CATALOG)) for (const a of arr) inAddonCatalog.add(a.key);
  const core = new Set<string>(ModuleService.CORE as string[]);
  const freeAddons = new Set<string>(PLAN_FREE_ADDONS as readonly string[]);

  const reachable = (m: string) => inSomePlan.has(m) || inAddonCatalog.has(m) || core.has(m) || freeAddons.has(m);

  // ═══ 1. todo módulo gated por rota é alcançável ═══
  const routeModules = Array.from(new Set(Object.values(ModuleService.MODULE_BY_ROUTE as Record<string, string>)));
  const dead = routeModules.filter((m) => !reachable(m));
  check(`1.1 nenhum módulo route-gated é "morto" (inalcançável): ${dead.length ? dead.join(", ") : "ok"}`, dead.length === 0);

  // Sanidade: as 3 verticais de tela dedicada são vendáveis (plano OU add-on).
  for (const m of ["clinica", "advocacia", "escola"]) {
    check(`1.2 ${m} vendável (tier ou add-on)`, inSomePlan.has(m) && inAddonCatalog.has(m));
  }

  // ═══ 2. petshop recomendado ao bundle que desbloqueia seu módulo central ═══
  const clinicaBundle = PLAN_BUNDLES.find((b) => b.addons.includes("clinica"));
  check("2.1 existe bundle que inclui o add-on 'clinica'", !!clinicaBundle);
  check("2.2 esse bundle recomenda 'saude' e 'petshop'", !!clinicaBundle && clinicaBundle.verticalHints.includes("saude") && clinicaBundle.verticalHints.includes("petshop"));

  // ═══ 3. todo bundle aponta pra add-on realmente vendável ═══
  for (const b of PLAN_BUNDLES) {
    for (const a of b.addons) {
      check(`3.x bundle '${b.key}' → add-on '${a}' está no catálogo`, inAddonCatalog.has(a));
    }
  }

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} module-sellability-coherence: ${passed}/${results.length} checks`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
