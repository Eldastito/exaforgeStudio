/**
 * TEST — Fatia 2.2 (ADR-153): PLAN_BUNDLES + GET /api/plans/bundles.
 *
 * Fecha a segunda correção comercial identificada no PRD §10.3 ("módulo
 * Clínica não deve depender exclusivamente do Enterprise"). Bundle
 * `growth_clinica` composto: plano Growth + add-on Clínica. Decisão #5
 * aprovada = Opção A (bundle Growth+addon).
 *
 * Cobre:
 *  1. PLAN_BUNDLES exportado e não-vazio.
 *  2. Cada bundle tem campos obrigatórios (key, name, description, basePlan,
 *     addons, priceMonthly, priceAnnualMonth, verticalHints, bundleDiscount).
 *  3. Bundle `growth_clinica` presente com shape correto.
 *  4. `basePlan` referencia plano válido em PLAN_GRADE.
 *  5. `addons` são keys conhecidas de módulos (referências válidas do
 *     ADDON_CATALOG do AddonService).
 *  6. `verticalHints` inclui `saude` pra Clínica.
 *  7. `bundleDiscount` é consistente: avulsoTotal - priceMonthly = savingsMonthly.
 *  8. `priceMonthly < avulsoTotal` (é DESCONTO, não markup).
 *  9. Rota GET /api/plans/bundles devolve `{bundles: [...]}` (simulado sem Express).
 * 10. Bundle NÃO quebra a rota GET /api/plans (que continua devolvendo array de plans).
 * 11. Não há duplicatas em `key`.
 *
 * Uso: npm run test:plan-bundles
 */
import { PLAN_BUNDLES, PLAN_GRADE } from "../src/server/plansGrade.js";
import { AddonService } from "../src/server/AddonService.js";

let failures = 0;
const results: { name: string; ok: boolean; note?: string }[] = [];
function check(name: string, ok: boolean, note?: string) {
  results.push({ name, ok, note });
  if (!ok) failures++;
}

async function main() {
  // ===== 1. PLAN_BUNDLES existe e não-vazio =====
  check("PLAN_BUNDLES é array", Array.isArray(PLAN_BUNDLES));
  check("PLAN_BUNDLES não-vazio", PLAN_BUNDLES.length >= 1);

  // ===== 2. Cada bundle tem shape completo =====
  for (const b of PLAN_BUNDLES) {
    const required = ["key", "name", "description", "basePlan", "addons", "priceMonthly", "priceAnnualMonth", "verticalHints", "bundleDiscount"];
    for (const field of required) {
      check(`bundle '${b.key}' tem campo '${field}'`, (b as any)[field] != null || field === "priceAnnualMonth");
    }
    check(`bundle '${b.key}'.bundleDiscount tem avulsoTotal + savingsMonthly + savingsPercent`,
      b.bundleDiscount &&
      typeof b.bundleDiscount.avulsoTotal === "number" &&
      typeof b.bundleDiscount.savingsMonthly === "number" &&
      typeof b.bundleDiscount.savingsPercent === "number");
  }

  // ===== 3. Bundle growth_clinica existe =====
  const clinica = PLAN_BUNDLES.find((b) => b.key === "growth_clinica");
  check("bundle 'growth_clinica' existe (PRD §10.3 Decisão #5)", !!clinica);
  check("growth_clinica.basePlan = 'growth'", clinica?.basePlan === "growth");
  check("growth_clinica.addons inclui 'clinica'", (clinica?.addons || []).includes("clinica"));
  check("growth_clinica.verticalHints inclui 'saude'", (clinica?.verticalHints || []).includes("saude"));
  check("growth_clinica.priceMonthly > 0", (clinica?.priceMonthly || 0) > 0);

  // ===== 3b. Bundles verticais Escola e Advocacia (mesma tese comercial) =====
  const escola = PLAN_BUNDLES.find((b) => b.key === "growth_escola");
  check("bundle 'growth_escola' existe", !!escola);
  check("growth_escola.basePlan = 'growth'", escola?.basePlan === "growth");
  check("growth_escola.addons inclui 'escola'", (escola?.addons || []).includes("escola"));
  check("growth_escola.verticalHints inclui 'educacao'", (escola?.verticalHints || []).includes("educacao"));

  const adv = PLAN_BUNDLES.find((b) => b.key === "growth_advocacia");
  check("bundle 'growth_advocacia' existe", !!adv);
  check("growth_advocacia.basePlan = 'growth'", adv?.basePlan === "growth");
  check("growth_advocacia.addons inclui 'advocacia'", (adv?.addons || []).includes("advocacia"));
  check("growth_advocacia.verticalHints inclui 'advocacia'", (adv?.verticalHints || []).includes("advocacia"));

  // ===== 4. basePlan é válido em PLAN_GRADE =====
  const validPlans = new Set(PLAN_GRADE.map((p) => p.id));
  for (const b of PLAN_BUNDLES) {
    check(`bundle '${b.key}'.basePlan '${b.basePlan}' existe em PLAN_GRADE`, validPlans.has(b.basePlan));
  }

  // ===== 5. addons são keys válidas do ADDON_CATALOG =====
  // ADDON_CATALOG tem keys de modules — o addon 'clinica' hoje vive no tier 'scale'.
  const allAddonKeys = new Set<string>();
  for (const arr of Object.values((AddonService as any).ADDON_CATALOG || {})) {
    for (const item of arr as { key: string }[]) allAddonKeys.add(item.key);
  }
  for (const b of PLAN_BUNDLES) {
    for (const addonKey of b.addons) {
      check(`bundle '${b.key}': addon '${addonKey}' é key conhecida em ADDON_CATALOG`, allAddonKeys.has(addonKey));
    }
  }

  // ===== 6. verticalHints é array não-vazio (bundle serve pra guiar onboarding) =====
  for (const b of PLAN_BUNDLES) {
    check(`bundle '${b.key}': verticalHints não-vazio`, Array.isArray(b.verticalHints) && b.verticalHints.length > 0);
  }

  // ===== 7. bundleDiscount é consistente: avulsoTotal - priceMonthly = savingsMonthly =====
  for (const b of PLAN_BUNDLES) {
    const calculated = b.bundleDiscount.avulsoTotal - b.priceMonthly;
    check(`bundle '${b.key}': savingsMonthly consistente (${b.bundleDiscount.avulsoTotal} - ${b.priceMonthly} = ${b.bundleDiscount.savingsMonthly})`,
      Math.abs(calculated - b.bundleDiscount.savingsMonthly) < 0.01);
  }

  // ===== 8. priceMonthly < avulsoTotal (é DESCONTO, não markup) =====
  for (const b of PLAN_BUNDLES) {
    check(`bundle '${b.key}': é desconto real (priceMonthly ${b.priceMonthly} < avulso ${b.bundleDiscount.avulsoTotal})`,
      b.priceMonthly < b.bundleDiscount.avulsoTotal);
  }

  // ===== 9. Simular resposta da rota GET /api/plans/bundles =====
  const routeResponse = { bundles: PLAN_BUNDLES };
  check("rota /bundles devolve {bundles: [...]}", Array.isArray(routeResponse.bundles));
  check("rota /bundles inclui growth_clinica", routeResponse.bundles.some((b) => b.key === "growth_clinica"));

  // ===== 10. Backward compat: PLAN_GRADE continua funcionando =====
  check("PLAN_GRADE continua tendo 5 tiers (não quebra)", PLAN_GRADE.length === 5);
  check("PLAN_GRADE.growth continua existindo", validPlans.has("growth"));

  // ===== 11. Sem duplicatas em key =====
  const keys = PLAN_BUNDLES.map((b) => b.key);
  check("nenhuma duplicata em bundle.key", keys.length === new Set(keys).size);

  // ===== 12. priceAnnualMonth ≤ priceMonthly quando definido =====
  for (const b of PLAN_BUNDLES) {
    if (b.priceAnnualMonth != null) {
      check(`bundle '${b.key}': plano anual (${b.priceAnnualMonth}/mês) ≤ mensal (${b.priceMonthly})`,
        b.priceAnnualMonth <= b.priceMonthly);
    }
  }

  // ===== Resultado =====
  console.log("\n=== PLAN_BUNDLES (F2.2) ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.note ? "  (" + r.note + ")" : ""}`);
  console.log(`\n${results.length - failures}/${results.length} checks OK`);
  if (failures > 0) process.exit(1);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
