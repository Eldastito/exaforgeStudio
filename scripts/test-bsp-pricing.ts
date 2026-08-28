/**
 * TEST — BusinessSkillsPackService (Track C do PRD-PEL-01, F1 Pricing 360).
 * DB-backed, determinístico. Prova:
 *   1. Schema: business_skills_pack_org_config com colunas certas;
 *   2. Validações: missing_org, invalid_cost (não-número, negativo);
 *   3. Adapter map delega corretamente por vertical:
 *      - retail/loja_virtual/beauty/clinic → markup_psycho via pricing.ts
 *      - comigo/falatu/advocacia → comigo_margin via ComigoPricingService
 *      - vertical desconhecida → default_markup40
 *   4. Overrides: input > prefs > default;
 *   5. floor_multiplier e ceiling_multiplier aplicam quando setados;
 *   6. getOrgConfig retorna null quando não existe; updateOrgConfig cria/atualiza;
 *   7. enabled_dimensions filtra valores inválidos;
 *   8. patch parcial preserva outros campos;
 *   9. Isolamento multi-tenant.
 *
 * Uso: npm run test:bsp-pricing
 */
import os from "os";
import path from "path";
import fs from "fs";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-bsp-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-bsp-1234567890abcdef";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) {
  results.push({ name, ok });
  if (!ok) failures++;
}

async function main() {
  const dbMod = await import("../src/server/db.js");
  const db = dbMod.default as any;
  const { BusinessSkillsPackService: BSP, BusinessSkillsPackError, SUPPORTED_VERTICALS, DIMENSIONS } =
    await import("../src/server/BusinessSkillsPackService.js");

  // ═══════════════ 1. Schema ═══════════════
  const cols = (db.prepare("PRAGMA table_info(business_skills_pack_org_config)").all() as any[])
    .map(c => c.name);
  for (const col of ["organization_id", "quote_template_json", "outreach_pack_json",
    "pricing_prefs_json", "enabled_dimensions_json", "created_at", "updated_at"]) {
    check(`1.x coluna ${col}`, cols.includes(col));
  }
  check("1.x SUPPORTED_VERTICALS inclui retail/loja_virtual/comigo",
    (SUPPORTED_VERTICALS as readonly string[]).includes("retail") &&
    (SUPPORTED_VERTICALS as readonly string[]).includes("loja_virtual") &&
    (SUPPORTED_VERTICALS as readonly string[]).includes("comigo"));
  check("1.x DIMENSIONS = pricing/rfp/local_marketing",
    (DIMENSIONS as readonly string[]).length === 3 &&
    (DIMENSIONS as readonly string[]).includes("pricing"));

  const ORG_A = "org-alpha";
  const ORG_B = "org-beta";

  // ═══════════════ 2. Validações ═══════════════
  let missingOrg = false;
  try { BSP.suggestPrice({ orgId: "", cost: 10, vertical: "retail" }); }
  catch (e: any) { missingOrg = e instanceof BusinessSkillsPackError && e.code === "missing_org"; }
  check("2.1 orgId vazio → missing_org", missingOrg);

  let invalidCostNaN = false;
  try { BSP.suggestPrice({ orgId: ORG_A, cost: NaN, vertical: "retail" }); }
  catch (e: any) { invalidCostNaN = e instanceof BusinessSkillsPackError && e.code === "invalid_cost"; }
  check("2.2 cost NaN → invalid_cost", invalidCostNaN);

  let invalidCostNeg = false;
  try { BSP.suggestPrice({ orgId: ORG_A, cost: -5, vertical: "retail" }); }
  catch (e: any) { invalidCostNeg = e instanceof BusinessSkillsPackError && e.code === "invalid_cost"; }
  check("2.3 cost negativo → invalid_cost", invalidCostNeg);

  let invalidCostString = false;
  try { BSP.suggestPrice({ orgId: ORG_A, cost: "abc" as any, vertical: "retail" }); }
  catch (e: any) { invalidCostString = e instanceof BusinessSkillsPackError && e.code === "invalid_cost"; }
  check("2.4 cost string → invalid_cost", invalidCostString);

  // ═══════════════ 3. Adapter map ═══════════════
  // Retail → markup_psycho (markup 40% default = 14/0.6=23.33 → arredondado)
  const retail = BSP.suggestPrice({ orgId: ORG_A, cost: 10, vertical: "retail" });
  check("3.1 retail → adapter=pricing.ts", retail.adapter === "pricing.ts");
  check("3.2 retail → method=markup_psycho", retail.method === "markup_psycho");
  check("3.3 retail markup 40% aplicado (markup_percent_used=40)", retail.markup_percent_used === 40);
  // suggestSalePrice(10, 40) = 10 * 1.4 = 14 → psychologicalRound(14) = 13.99
  check("3.4 retail cost=10, price = 13.99 (markup 40% + psycho round)",
    retail.suggested_price === 13.99);

  const lojaVirtual = BSP.suggestPrice({ orgId: ORG_A, cost: 10, vertical: "loja_virtual" });
  check("3.5 loja_virtual → mesma delegação que retail",
    lojaVirtual.adapter === "pricing.ts" && lojaVirtual.method === "markup_psycho");

  const beauty = BSP.suggestPrice({ orgId: ORG_A, cost: 10, vertical: "beauty" });
  check("3.6 beauty → adapter=pricing.ts (mesmo mapa)",
    beauty.adapter === "pricing.ts");

  const clinic = BSP.suggestPrice({ orgId: ORG_A, cost: 10, vertical: "clinic" });
  check("3.7 clinic → adapter=pricing.ts", clinic.adapter === "pricing.ts");

  // Comigo → ComigoPricingService.suggestPrice (target margin 0.3)
  const comigo = BSP.suggestPrice({ orgId: ORG_A, cost: 10, vertical: "comigo" });
  check("3.8 comigo → adapter=ComigoPricingService", comigo.adapter === "ComigoPricingService");
  check("3.9 comigo → method=comigo_margin", comigo.method === "comigo_margin");
  check("3.10 comigo target_margin_used=0.3", comigo.target_margin_used === 0.3);
  // price = cost / (1 - 0.3) ≈ 14.29
  check("3.11 comigo cost=10 → price ≈ 14.29",
    Math.abs(comigo.suggested_price - 14.29) < 1);

  const falatu = BSP.suggestPrice({ orgId: ORG_A, cost: 10, vertical: "falatu" });
  check("3.12 falatu → mesma delegação que comigo",
    falatu.adapter === "ComigoPricingService" && falatu.method === "comigo_margin");

  const advocacia = BSP.suggestPrice({ orgId: ORG_A, cost: 10, vertical: "advocacia" });
  check("3.13 advocacia → adapter=ComigoPricingService (margin-based)",
    advocacia.adapter === "ComigoPricingService");

  // Vertical desconhecida → default
  const unknown = BSP.suggestPrice({ orgId: ORG_A, cost: 10, vertical: "meta_vertical" });
  check("3.14 vertical desconhecida → adapter=default", unknown.adapter === "default");
  check("3.15 vertical desconhecida → method=default_markup40", unknown.method === "default_markup40");
  check("3.16 vertical desconhecida usa markup 40%", unknown.markup_percent_used === 40);

  // Sem vertical → default
  const noVertical = BSP.suggestPrice({ orgId: ORG_A, cost: 10 });
  check("3.17 sem vertical → adapter=default", noVertical.adapter === "default");

  // Case-insensitive
  const upperCase = BSP.suggestPrice({ orgId: ORG_A, cost: 10, vertical: "RETAIL" });
  check("3.18 vertical case-insensitive (RETAIL → retail)",
    upperCase.adapter === "pricing.ts");

  // ═══════════════ 4. Overrides ═══════════════
  // Input override na chamada
  const inputOverride = BSP.suggestPrice({
    orgId: ORG_A, cost: 10, vertical: "retail", markup_percent: 60,
  });
  check("4.1 input override markup 60% aplicado", inputOverride.markup_percent_used === 60);
  check("4.2 input override retorna preço mais alto que default",
    inputOverride.suggested_price > retail.suggested_price);

  // Config override (org-scoped)
  BSP.updateOrgConfig(ORG_A, { pricing_prefs: { markup_percent: 55 } });
  const configOverride = BSP.suggestPrice({ orgId: ORG_A, cost: 10, vertical: "retail" });
  check("4.3 config markup 55% pego pelo suggestPrice", configOverride.markup_percent_used === 55);

  // Input tem prioridade sobre config
  const inputBeatsConfig = BSP.suggestPrice({
    orgId: ORG_A, cost: 10, vertical: "retail", markup_percent: 70,
  });
  check("4.4 input override > config override", inputBeatsConfig.markup_percent_used === 70);

  // Comigo target_margin do config
  BSP.updateOrgConfig(ORG_A, { pricing_prefs: { markup_percent: 55, target_margin: 0.5 } });
  const comigoConfig = BSP.suggestPrice({ orgId: ORG_A, cost: 10, vertical: "comigo" });
  check("4.5 config target_margin 0.5 pego pra comigo", comigoConfig.target_margin_used === 0.5);

  // ═══════════════ 5. Floor/ceiling ═══════════════
  BSP.updateOrgConfig(ORG_A, {
    pricing_prefs: { markup_percent: 40, floor_multiplier: 1.1, ceiling_multiplier: 3 },
  });
  const bounded = BSP.suggestPrice({ orgId: ORG_A, cost: 10, vertical: "retail" });
  check("5.1 floor_price = cost * 1.1 = 11", bounded.floor_price === 11);
  check("5.2 ceiling_price = cost * 3 = 30", bounded.ceiling_price === 30);

  // Sem multipliers → null
  BSP.updateOrgConfig(ORG_A, { pricing_prefs: { markup_percent: 40 } });
  const unbounded = BSP.suggestPrice({ orgId: ORG_A, cost: 10, vertical: "retail" });
  check("5.3 sem multipliers → floor/ceiling null",
    unbounded.floor_price === null && unbounded.ceiling_price === null);

  // ═══════════════ 6. getOrgConfig / updateOrgConfig ═══════════════
  const noneB = BSP.getOrgConfig(ORG_B);
  check("6.1 org sem config → null", noneB === null);

  const cfgB = BSP.updateOrgConfig(ORG_B, { pricing_prefs: { markup_percent: 60 } });
  check("6.2 update cria linha nova", cfgB.organization_id === ORG_B);
  check("6.3 pricing_prefs.markup_percent=60 preservado",
    cfgB.pricing_prefs?.markup_percent === 60);

  let updateMissingOrg = false;
  try { BSP.updateOrgConfig("", { pricing_prefs: null }); }
  catch (e: any) { updateMissingOrg = e instanceof BusinessSkillsPackError && e.code === "missing_org"; }
  check("6.4 update sem orgId → missing_org", updateMissingOrg);

  // ═══════════════ 7. enabled_dimensions filtra inválidos ═══════════════
  const cfgDims = BSP.updateOrgConfig(ORG_B, {
    enabled_dimensions: ["pricing", "invalid_dim" as any, "rfp"],
  });
  check("7.1 dimensões inválidas são filtradas",
    cfgDims.enabled_dimensions.length === 2 &&
    cfgDims.enabled_dimensions.includes("pricing") &&
    cfgDims.enabled_dimensions.includes("rfp") &&
    !cfgDims.enabled_dimensions.includes("invalid_dim" as any));

  const cfgEmptyDims = BSP.updateOrgConfig(ORG_B, {
    enabled_dimensions: [],
  });
  check("7.2 enabled_dimensions vazio aceito", cfgEmptyDims.enabled_dimensions.length === 0);

  // ═══════════════ 8. Patch parcial preserva ═══════════════
  BSP.updateOrgConfig(ORG_B, {
    pricing_prefs: { markup_percent: 45 },
    enabled_dimensions: ["pricing", "rfp", "local_marketing"],
  });
  BSP.updateOrgConfig(ORG_B, { quote_template: { header: "Meu template" } });
  const afterPatch = BSP.getOrgConfig(ORG_B);
  check("8.1 pricing_prefs preservado após patch de quote_template",
    afterPatch?.pricing_prefs?.markup_percent === 45);
  check("8.2 quote_template atualizado",
    afterPatch?.quote_template?.header === "Meu template");
  check("8.3 enabled_dimensions preservado",
    afterPatch?.enabled_dimensions?.length === 3);

  // pricing_prefs = null explícito limpa o campo
  BSP.updateOrgConfig(ORG_B, { pricing_prefs: null });
  const afterClear = BSP.getOrgConfig(ORG_B);
  check("8.4 pricing_prefs = null limpa o campo", afterClear?.pricing_prefs === null);

  // ═══════════════ 9. Isolamento ═══════════════
  BSP.updateOrgConfig(ORG_A, { pricing_prefs: { markup_percent: 88 } });
  BSP.updateOrgConfig(ORG_B, { pricing_prefs: { markup_percent: 22 } });
  const orgAPrice = BSP.suggestPrice({ orgId: ORG_A, cost: 10, vertical: "retail" });
  const orgBPrice = BSP.suggestPrice({ orgId: ORG_B, cost: 10, vertical: "retail" });
  check("9.1 ORG_A pega seu próprio markup 88",
    orgAPrice.markup_percent_used === 88);
  check("9.2 ORG_B pega seu próprio markup 22",
    orgBPrice.markup_percent_used === 22);
  check("9.3 preços diferentes entre orgs (isolamento)",
    orgAPrice.suggested_price !== orgBPrice.suggested_price);

  // ═══════════════ 10. cost=0 ═══════════════
  const zeroCost = BSP.suggestPrice({ orgId: ORG_A, cost: 0, vertical: "retail" });
  check("10.1 cost=0 aceito (não erro)", zeroCost.suggested_price >= 0);

  // ─── Relatório final ───
  const passed = results.length - failures;
  console.log(`\n${passed}/${results.length} checks OK`);
  for (const r of results) console.log(`  ${r.ok ? "✓" : "✗"} ${r.name}`);
  process.exit(failures > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
