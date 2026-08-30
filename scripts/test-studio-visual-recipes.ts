/**
 * TEST — StudioVisualRecipeService (ADR-194 F1).
 * DB-backed, determinístico. Prova:
 *   1. Schema: recipes + aliases, sem organization_id (RN global);
 *   2. recipe_key regex, imutabilidade, supported_formats obrigatório;
 *   3. seedInitialRecipes: cria 6 recipes + aliases, idempotente;
 *   4. resolveAlias: case-insensitive, slash opcional;
 *   5. get(): funciona por key E por alias;
 *   6. list(): retorna só active versions;
 *   7. Versionamento: create com key existente incrementa version + inativa
 *      versões anteriores;
 *   8. buildPromptPlan: monta plan estruturado; rejeita formato não suportado;
 *   9. Todos os 6 slash-commands do PRD §12.4 resolvem;
 *  10. addAlias idempotente.
 *
 * Uso: npm run test:studio-visual-recipes
 */
import os from "os";
import path from "path";
import fs from "fs";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-vre-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-vre-1234567890abcdef";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) {
  results.push({ name, ok });
  if (!ok) failures++;
}

async function main() {
  const dbMod = await import("../src/server/db.js");
  const db = dbMod.default as any;
  const { StudioVisualRecipeService: VRE, VisualRecipeError, SUPPORTED_FORMATS } =
    await import("../src/server/StudioVisualRecipeService.js");

  // ═══════════════ 1. Schema ═══════════════
  const rCols = (db.prepare("PRAGMA table_info(studio_visual_recipes)").all() as any[]).map(c => c.name);
  check("1.1 studio_visual_recipes tem recipe_key/version/active",
    rCols.includes("recipe_key") && rCols.includes("version") && rCols.includes("active"));
  check("1.2 studio_visual_recipes SEM organization_id (GLOBAL nesta fatia)",
    !rCols.includes("organization_id"));

  const aCols = (db.prepare("PRAGMA table_info(studio_visual_recipe_aliases)").all() as any[]).map(c => c.name);
  check("1.3 studio_visual_recipe_aliases tem alias UNIQUE + recipe_key",
    aCols.includes("alias") && aCols.includes("recipe_key"));
  check("1.4 studio_visual_recipe_aliases SEM organization_id",
    !aCols.includes("organization_id"));

  // ═══════════════ 2. Validação de create ═══════════════
  let invalidKey = false;
  try { VRE.create({ key: "bad key", name: "x", supported_formats: ["feed_1_1"] }); }
  catch (e: any) { invalidKey = e instanceof VisualRecipeError && e.code === "invalid_key"; }
  check("2.1 recipe_key inválido rejeitado", invalidKey);

  let missingName = false;
  try { VRE.create({ key: "VALID_KEY", name: "", supported_formats: ["feed_1_1"] }); }
  catch (e: any) { missingName = e instanceof VisualRecipeError && e.code === "missing_name"; }
  check("2.2 name vazio rejeitado", missingName);

  let missingFormats = false;
  try { VRE.create({ key: "VALID_KEY", name: "n", supported_formats: [] }); }
  catch (e: any) { missingFormats = e instanceof VisualRecipeError && e.code === "missing_formats"; }
  check("2.3 supported_formats vazio rejeitado (RN-VRE-4)", missingFormats);

  let invalidFormat = false;
  try { VRE.create({ key: "VALID_KEY", name: "n", supported_formats: ["banana" as any] }); }
  catch (e: any) { invalidFormat = e instanceof VisualRecipeError && e.code === "invalid_format"; }
  check("2.4 formato desconhecido rejeitado", invalidFormat);

  // ═══════════════ 3. Seed inicial ═══════════════
  const seedResult = VRE.seedInitialRecipes();
  check("3.1 seedInitialRecipes cria 7 recipes", seedResult.created.length === 7);
  check("3.2 7 recipes esperados presentes",
    ["PRODUCT_EXPLOSION", "BILLBOARD_3D", "MAGAZINE_COVER", "ADD_CREATIVE", "SOFT_3D", "LIFESTYLE_SHORT", "BRAND_ORGANISM"]
      .every(k => seedResult.created.includes(k)));

  // Idempotência
  const seedAgain = VRE.seedInitialRecipes();
  check("3.3 seed rodado 2x não duplica recipes", seedAgain.created.length === 0);
  check("3.4 seed rodado 2x não duplica aliases", seedAgain.aliases_added === 0);

  const total = (db.prepare("SELECT COUNT(*) as n FROM studio_visual_recipes").get() as any).n;
  check("3.5 total no db = 7", total === 7);

  // Receita de marca (narrativa "organismo inteligente") — transversal.
  check("3.6 alias '/OrganismoInteligente' resolve p/ BRAND_ORGANISM", VRE.resolveAlias("/OrganismoInteligente") === "BRAND_ORGANISM");
  check("3.7 alias natural 'organismo inteligente' resolve", VRE.resolveAlias("organismo inteligente") === "BRAND_ORGANISM");
  const brand = VRE.get("BRAND_ORGANISM");
  check("3.8 BRAND_ORGANISM é institucional (não preserva produto)", brand?.constraints?.preserve_product_identity === false);
  check("3.9 BRAND_ORGANISM é transversal (vertical_hints inclui 'all')", Array.isArray(brand?.vertical_hints) && brand!.vertical_hints.includes("all"));

  // ═══════════════ 4. resolveAlias ═══════════════
  check("4.1 alias slash resolve", VRE.resolveAlias("/3Dbillboard") === "BILLBOARD_3D");
  check("4.2 sem slash também resolve", VRE.resolveAlias("3Dbillboard") === "BILLBOARD_3D");
  check("4.3 case-insensitive: lowercase resolve", VRE.resolveAlias("/productexplosion") === "PRODUCT_EXPLOSION");
  check("4.4 case-insensitive: UPPERCASE resolve", VRE.resolveAlias("/PRODUCTEXPLOSION") === "PRODUCT_EXPLOSION");
  check("4.5 português: 'capa de revista' resolve", VRE.resolveAlias("capa de revista") === "MAGAZINE_COVER");
  check("4.6 alias inexistente → null", VRE.resolveAlias("/inexistente") === null);

  // ═══════════════ 5. get() por key OU alias ═══════════════
  const byKey = VRE.get("PRODUCT_EXPLOSION");
  check("5.1 get() por key retorna recipe", byKey?.key === "PRODUCT_EXPLOSION");
  check("5.2 recipe parseado (composition object)", typeof byKey?.composition === "object");
  check("5.3 recipe parseado (supported_formats array)", Array.isArray(byKey?.supported_formats));

  const byAlias = VRE.get("/MagazineCover");
  check("5.4 get() por alias resolve pra recipe", byAlias?.key === "MAGAZINE_COVER");

  const notFound = VRE.get("NAO_EXISTE");
  check("5.5 get() em key inexistente retorna null", notFound === null);

  // ═══════════════ 6. list() ═══════════════
  const listed = VRE.list();
  check("6.1 list() retorna 7 recipes", listed.length === 7);
  check("6.2 todos active", listed.every(r => r.active === true));
  check("6.3 ordem alfabética por key",
    listed[0].key === "ADD_CREATIVE" && listed[listed.length - 1].key === "SOFT_3D");

  // ═══════════════ 7. Versionamento ═══════════════
  const v2 = VRE.create({
    key: "PRODUCT_EXPLOSION",
    name: "Product Explosion v2",
    supported_formats: ["feed_1_1"],
  });
  check("7.1 create com key existente incrementa version", v2.version === 2);
  check("7.2 v2 é active", v2.active === true);

  // v1 fica inativa
  const allVersions = db.prepare(
    "SELECT version, active FROM studio_visual_recipes WHERE recipe_key = ? ORDER BY version"
  ).all("PRODUCT_EXPLOSION") as any[];
  check("7.3 duas linhas pra PRODUCT_EXPLOSION", allVersions.length === 2);
  check("7.4 v1 marcada active=0", allVersions[0].version === 1 && allVersions[0].active === 0);
  check("7.5 v2 marcada active=1", allVersions[1].version === 2 && allVersions[1].active === 1);

  // list() só retorna active (ainda 7 recipes — não somou nova key)
  const listAfter = VRE.list();
  check("7.6 list() ainda tem 7 (versão nova, não recipe nova)", listAfter.length === 7);

  // ═══════════════ 8. buildPromptPlan ═══════════════
  const plan = VRE.buildPromptPlan({
    recipe_key_or_alias: "/LifestyleShort",
    inputs: { produto: "tênis running", marca: "Acme", cta: "compre já" },
    format: "story_9_16",
  });
  check("8.1 plan resolveu alias corretamente", plan.recipe_key === "LIFESTYLE_SHORT");
  check("8.2 plan carrega version", typeof plan.recipe_version === "number");
  check("8.3 plan carrega composition", !!plan.composition);
  check("8.4 plan carrega inputs originais",
    plan.inputs.produto === "tênis running" && plan.inputs.marca === "Acme");
  check("8.5 plan carrega requested_format", plan.requested_format === "story_9_16");
  check("8.6 prompt_seed é string não-vazia", typeof plan.prompt_seed === "string" && plan.prompt_seed.length > 0);
  check("8.7 prompt_seed inclui nome", plan.prompt_seed.includes("Lifestyle Short"));
  check("8.8 prompt_seed inclui inputs", plan.prompt_seed.includes("tênis running"));

  // Formato não suportado
  let badFormat = false;
  try { VRE.buildPromptPlan({ recipe_key_or_alias: "SOFT_3D", inputs: {}, format: "landscape_16_9" }); }
  catch (e: any) { badFormat = e instanceof VisualRecipeError && e.code === "format_not_supported"; }
  check("8.9 buildPromptPlan rejeita formato não suportado pela recipe", badFormat);

  // Recipe inexistente
  let ghost = false;
  try { VRE.buildPromptPlan({ recipe_key_or_alias: "GHOST", inputs: {}, format: "feed_1_1" }); }
  catch (e: any) { ghost = e instanceof VisualRecipeError && e.code === "recipe_not_found"; }
  check("8.10 buildPromptPlan em recipe inexistente → recipe_not_found", ghost);

  // ═══════════════ 9. 6 slash-commands do PRD §12.4 ═══════════════
  const slashCommands = [
    ["/ProductExplosion", "PRODUCT_EXPLOSION"],
    ["/3Dbillboard", "BILLBOARD_3D"],
    ["/MagazineCover", "MAGAZINE_COVER"],
    ["/AddCreative", "ADD_CREATIVE"],
    ["/3DSoft", "SOFT_3D"],
    ["/LifestyleShort", "LIFESTYLE_SHORT"],
  ];
  const allResolve = slashCommands.every(([s, k]) => VRE.resolveAlias(s) === k);
  check("9.1 os 6 slash-commands do PRD §12.4 resolvem corretamente", allResolve);

  // ═══════════════ 10. addAlias idempotente ═══════════════
  VRE.addAlias("/ProductExplosion", "PRODUCT_EXPLOSION"); // já existe do seed
  const dupCount = (db.prepare(
    "SELECT COUNT(*) as n FROM studio_visual_recipe_aliases WHERE LOWER(alias) = ?"
  ).get("/productexplosion") as any).n;
  check("10.1 addAlias em alias existente não duplica", dupCount === 1);

  let missingRecipe = false;
  try { VRE.addAlias("/qualquer", "RECIPE_INEXISTENTE"); }
  catch (e: any) { missingRecipe = e instanceof VisualRecipeError && e.code === "recipe_not_found"; }
  check("10.2 addAlias para recipe inexistente rejeitado", missingRecipe);

  // ═══════════════ 11. Contadores esperados ═══════════════
  check("11.1 SUPPORTED_FORMATS tem 5 valores", SUPPORTED_FORMATS.length === 5);

  // ═══════════════ 12. F2 — generate() com generator fake ═══════════════
  // Injeta generator fake pra não bater no Google/OpenAI. Retorna base64 dummy
  // (imagem PNG 1x1 transparente).
  let generatorCalls = 0;
  const dummyB64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgAAIAAAUAAeIVWUcAAAAASUVORK5CYII=";
  VRE.configureImageGenerator(async (prompt: string, size: string) => {
    generatorCalls++;
    return dummyB64;
  });

  // Precisa criar org fake pra generate funcionar (constraint em studio_creations
  // aponta pra organization_id, mas não há FK forte — INSERT direto passa).
  const testOrgId = "org-vre-test-" + Date.now();

  const gen1 = await VRE.generate({
    orgId: testOrgId,
    recipe_key_or_alias: "/ProductExplosion",
    inputs: { produto: "tênis running", marca: "Acme" },
    format: "feed_1_1",
    brand_hint: "Loja Acme, paleta pastel, tom minimalista.",
  });
  check("12.1 generate() retorna id", typeof gen1.id === "string" && gen1.id.length > 0);
  check("12.2 mediaUrl começa com /media/", gen1.mediaUrl.startsWith("/media/"));
  check("12.3 mediaUrl termina em .png", gen1.mediaUrl.endsWith(".png"));
  check("12.4 recipe_key retornado (resolveu alias)", gen1.recipe_key === "PRODUCT_EXPLOSION");
  check("12.5 recipe_version > 0", gen1.recipe_version > 0);
  check("12.6 prompt inclui brand_hint", gen1.prompt.includes("Loja Acme"));
  check("12.7 prompt inclui inputs", gen1.prompt.includes("tênis running"));
  check("12.8 generator foi chamado 1x", generatorCalls === 1);

  // Arquivo escrito no MEDIA_DIR
  const mediaFile = path.join(process.env.DATA_DIR!, "media", gen1.mediaUrl.replace("/media/", ""));
  check("12.9 arquivo mídia foi escrito no disco", fs.existsSync(mediaFile));

  // Row em studio_creations com marca do recipe
  const createdRow = db.prepare(
    "SELECT * FROM studio_creations WHERE id = ?"
  ).get(gen1.id) as any;
  check("12.10 studio_creations tem row inserted", !!createdRow);
  check("12.11 organization_id preservado", createdRow?.organization_id === testOrgId);
  check("12.12 kind = 'image'", createdRow?.kind === "image");
  check("12.13 prompt marcado com [KEY@vN]",
    createdRow?.prompt.startsWith("[PRODUCT_EXPLOSION@v"));

  // ═══════════════ 13. F2 — size mapping ═══════════════
  // Reset fake pra capturar size
  let lastSize = "";
  VRE.configureImageGenerator(async (prompt: string, size: string) => {
    lastSize = size;
    return dummyB64;
  });

  await VRE.generate({ orgId: testOrgId, recipe_key_or_alias: "/LifestyleShort", format: "story_9_16" });
  check("13.1 story_9_16 → 1024x1536", lastSize === "1024x1536");

  await VRE.generate({ orgId: testOrgId, recipe_key_or_alias: "/3Dbillboard", format: "landscape_16_9" });
  check("13.2 landscape_16_9 → 1536x1024", lastSize === "1536x1024");

  await VRE.generate({ orgId: testOrgId, recipe_key_or_alias: "/3DSoft", format: "feed_1_1" });
  check("13.3 feed_1_1 → 1024x1024", lastSize === "1024x1024");

  // ═══════════════ 14. F2 — erros ═══════════════
  let missingOrg = false;
  try { await VRE.generate({ orgId: "", recipe_key_or_alias: "/ProductExplosion", format: "feed_1_1" }); }
  catch (e: any) { missingOrg = e instanceof VisualRecipeError && e.code === "missing_org"; }
  check("14.1 generate() sem orgId → missing_org", missingOrg);

  let badFormatGenerate = false;
  try { await VRE.generate({ orgId: testOrgId, recipe_key_or_alias: "/3DSoft", format: "landscape_16_9" }); }
  catch (e: any) { badFormatGenerate = e instanceof VisualRecipeError && e.code === "format_not_supported"; }
  check("14.2 generate() com formato não suportado pela recipe → format_not_supported", badFormatGenerate);

  // Provider retorna vazio → 502
  VRE.configureImageGenerator(async () => "");
  let empty = false;
  try { await VRE.generate({ orgId: testOrgId, recipe_key_or_alias: "/ProductExplosion", format: "feed_1_1" }); }
  catch (e: any) { empty = e instanceof VisualRecipeError && e.code === "provider_empty"; }
  check("14.3 provider vazio → provider_empty", empty);

  VRE.resetImageGenerator();

  // ─── Relatório final ───
  const passed = results.length - failures;
  console.log(`\n${passed}/${results.length} checks OK`);
  for (const r of results) console.log(`  ${r.ok ? "✓" : "✗"} ${r.name}`);
  process.exit(failures > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
