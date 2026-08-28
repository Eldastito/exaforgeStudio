/**
 * TEST — Aliases per-org (ADR-194 F5).
 * DB-backed, determinístico. Prova:
 *   1. Schema: studio_visual_recipe_org_aliases criada com colunas certas;
 *   2. addOrgAlias exige orgId, alias, recipe_key existente;
 *   3. Rejeita recipe_key inexistente (recipe_not_found);
 *   4. Rejeita duplicata na mesma org (duplicate_alias, 409);
 *   5. Mesma alias em OUTRA org é permitida;
 *   6. resolveAlias(input, orgId): org override tem prioridade sobre global;
 *   7. resolveAlias sem orgId → só global (backward-compat);
 *   8. get() honra orgId (redireciona via alias org-scoped);
 *   9. removeOrgAlias só remove se a org for dona;
 *  10. listAliasesForOrg: global + own; ownOnly=true filtra;
 *  11. Alias org-scoped case-insensitive + slash opcional (mesma regra dos globais);
 *  12. buildPromptPlan resolve por alias org-scoped quando orgId passado.
 *
 * Uso: npm run test:studio-visual-recipes-aliases
 */
import os from "os";
import path from "path";
import fs from "fs";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-vre-aliases-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-vre-aliases-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) {
  results.push({ name, ok });
  if (!ok) failures++;
}

async function main() {
  const dbMod = await import("../src/server/db.js");
  const db = dbMod.default as any;
  const { StudioVisualRecipeService: VRE, VisualRecipeError } =
    await import("../src/server/StudioVisualRecipeService.js");

  // ═══════════════ 1. Schema ═══════════════
  const cols = (db.prepare("PRAGMA table_info(studio_visual_recipe_org_aliases)").all() as any[])
    .map(c => c.name);
  check("1.1 studio_visual_recipe_org_aliases tem organization_id", cols.includes("organization_id"));
  check("1.2 studio_visual_recipe_org_aliases tem alias", cols.includes("alias"));
  check("1.3 studio_visual_recipe_org_aliases tem recipe_key", cols.includes("recipe_key"));
  check("1.4 studio_visual_recipe_org_aliases tem id", cols.includes("id"));

  // Seed do catálogo pra ter recipe_keys válidas.
  VRE.seedInitialRecipes();

  const ORG_A = "org-alpha";
  const ORG_B = "org-beta";

  // ═══════════════ 2. addOrgAlias — validações ═══════════════
  let missingOrg = false;
  try { VRE.addOrgAlias("", "meu_alias", "PRODUCT_EXPLOSION"); }
  catch (e: any) { missingOrg = e instanceof VisualRecipeError && e.code === "missing_org"; }
  check("2.1 orgId vazio → missing_org", missingOrg);

  let missingAlias = false;
  try { VRE.addOrgAlias(ORG_A, "", "PRODUCT_EXPLOSION"); }
  catch (e: any) { missingAlias = e instanceof VisualRecipeError && e.code === "missing_alias"; }
  check("2.2 alias vazio → missing_alias", missingAlias);

  let missingKey = false;
  try { VRE.addOrgAlias(ORG_A, "atalho", ""); }
  catch (e: any) { missingKey = e instanceof VisualRecipeError && e.code === "missing_key"; }
  check("2.3 recipe_key vazio → missing_key", missingKey);

  let notFound = false;
  try { VRE.addOrgAlias(ORG_A, "atalho", "COMPLETELY_MADE_UP"); }
  catch (e: any) { notFound = e instanceof VisualRecipeError && e.code === "recipe_not_found"; }
  check("2.4 recipe_key inexistente → recipe_not_found", notFound);

  // ═══════════════ 3. addOrgAlias happy path ═══════════════
  const a1 = VRE.addOrgAlias(ORG_A, "explosao", "PRODUCT_EXPLOSION");
  check("3.1 addOrgAlias retorna id/org/alias/key",
    !!a1.id && a1.organization_id === ORG_A && a1.alias === "explosao" && a1.recipe_key === "PRODUCT_EXPLOSION");

  // ═══════════════ 4. Duplicata rejeitada na mesma org ═══════════════
  let dup = false;
  try { VRE.addOrgAlias(ORG_A, "explosao", "PRODUCT_EXPLOSION"); }
  catch (e: any) { dup = e instanceof VisualRecipeError && e.code === "duplicate_alias"; }
  check("4.1 mesma alias na mesma org → duplicate_alias", dup);

  // Case-insensitive na duplicata
  let dupCase = false;
  try { VRE.addOrgAlias(ORG_A, "EXPLOSAO", "PRODUCT_EXPLOSION"); }
  catch (e: any) { dupCase = e instanceof VisualRecipeError && e.code === "duplicate_alias"; }
  check("4.2 duplicate_alias é case-insensitive", dupCase);

  // ═══════════════ 5. Mesma alias em outra org é permitida ═══════════════
  const a2 = VRE.addOrgAlias(ORG_B, "explosao", "BILLBOARD_3D");
  check("5.1 mesma alias em outra org OK", a2.organization_id === ORG_B && a2.recipe_key === "BILLBOARD_3D");

  // ═══════════════ 6. resolveAlias com prioridade org > global ═══════════════
  // Alias global do seed: "/ProductExplosion" → PRODUCT_EXPLOSION
  const globalRes = VRE.resolveAlias("/ProductExplosion");
  check("6.1 resolveAlias global funciona sem orgId", globalRes === "PRODUCT_EXPLOSION");

  // Org A definiu "explosao" apontando pra PRODUCT_EXPLOSION → resolve pra ela
  const orgARes = VRE.resolveAlias("explosao", ORG_A);
  check("6.2 resolveAlias com orgId acha alias da org", orgARes === "PRODUCT_EXPLOSION");

  // Org B definiu "explosao" apontando pra BILLBOARD_3D → resolve pra BB
  const orgBRes = VRE.resolveAlias("explosao", ORG_B);
  check("6.3 mesma alias em orgs diferentes resolve diferente", orgBRes === "BILLBOARD_3D");

  // Sem orgId, alias que não é global retorna null
  const noOrg = VRE.resolveAlias("explosao");
  check("6.4 alias sem escopo global e sem orgId → null", noOrg === null);

  // Override: se org tem alias com mesmo nome que um alias global, org vence.
  // Vamos criar um alias org-scoped com nome que EXISTE globalmente.
  // "explosão de produto" é alias global do seed → PRODUCT_EXPLOSION
  // Criar override em ORG_A apontando pra MAGAZINE_COVER
  VRE.addOrgAlias(ORG_A, "explosão de produto", "MAGAZINE_COVER");
  const globalPE = VRE.resolveAlias("explosão de produto");
  check("6.5 sem orgId → alias global vence", globalPE === "PRODUCT_EXPLOSION");
  const overridden = VRE.resolveAlias("explosão de produto", ORG_A);
  check("6.6 com orgId → override da org vence sobre global", overridden === "MAGAZINE_COVER");
  // Outra org sem override → cai no global
  const otherOrg = VRE.resolveAlias("explosão de produto", ORG_B);
  check("6.7 outra org sem override → cai no global", otherOrg === "PRODUCT_EXPLOSION");

  // ═══════════════ 7. get() honra orgId ═══════════════
  const gA = VRE.get("explosao", ORG_A);
  check("7.1 get() por alias org-scoped resolve pra recipe da org",
    gA?.key === "PRODUCT_EXPLOSION");
  const gB = VRE.get("explosao", ORG_B);
  check("7.2 get() em outra org resolve diferente", gB?.key === "BILLBOARD_3D");
  const gNo = VRE.get("explosao");
  check("7.3 get() sem orgId em alias sem global → null", gNo === null);

  // ═══════════════ 8. Slash opcional (compat com padrão do seed) ═══════════════
  // /explosao deve resolver = explosao
  const withSlash = VRE.resolveAlias("/explosao", ORG_A);
  check("8.1 slash inicial ignorado na resolução", withSlash === "PRODUCT_EXPLOSION");

  // ═══════════════ 9. removeOrgAlias ═══════════════
  // Alias de outra org não pode ser removido
  const removedByWrongOrg = VRE.removeOrgAlias(ORG_B, a1.id);
  check("9.1 outra org não consegue remover alias de outra", removedByWrongOrg === false);

  // Confirmar que ainda está lá
  const stillThere = VRE.resolveAlias("explosao", ORG_A);
  check("9.2 alias intacto após tentativa de remoção por org errada", stillThere === "PRODUCT_EXPLOSION");

  // Dono remove
  const removed = VRE.removeOrgAlias(ORG_A, a1.id);
  check("9.3 dono remove alias com sucesso", removed === true);

  const afterRemove = VRE.resolveAlias("explosao", ORG_A);
  check("9.4 após remoção, resolve retorna null (era só org-scoped)", afterRemove === null);

  // ID inexistente
  const nonExistent = VRE.removeOrgAlias(ORG_A, "id-que-nao-existe");
  check("9.5 removeOrgAlias com id inexistente → false", nonExistent === false);

  // ═══════════════ 10. listAliasesForOrg ═══════════════
  // ORG_A ainda tem "explosão de produto" (override)
  const listA = VRE.listAliasesForOrg(ORG_A);
  const listAown = VRE.listAliasesForOrg(ORG_A, true);
  const seedAliases = 12; // 6 slash-commands + 6 alternativas naturais no seed
  check("10.1 lista completa (global + own) tem seed + próprios",
    listA.length >= seedAliases);
  check("10.2 own_only lista só os da org",
    listAown.every(a => a.scope === "org") && listAown.length === 1);
  check("10.3 own alias tem scope='org'", listAown[0].scope === "org");
  check("10.4 lista sem orgId retorna só globais",
    VRE.listAliasesForOrg(null).every(a => a.scope === "global"));

  // ═══════════════ 11. buildPromptPlan honra orgId ═══════════════
  // Restaurar alias de ORG_A pra teste (foi removido acima)
  VRE.addOrgAlias(ORG_A, "meu_atalho", "SOFT_3D");
  const plan = VRE.buildPromptPlan({
    recipe_key_or_alias: "meu_atalho",
    inputs: { desc: "produto pastel" },
    format: "feed_1_1" as any,
    orgId: ORG_A,
  });
  check("11.1 buildPromptPlan resolve alias org-scoped", plan.recipe_key === "SOFT_3D");

  // Sem orgId, "meu_atalho" não existe globalmente → erro
  let planFail = false;
  try {
    VRE.buildPromptPlan({
      recipe_key_or_alias: "meu_atalho",
      inputs: {},
      format: "feed_1_1" as any,
    });
  } catch (e: any) { planFail = e instanceof VisualRecipeError && e.code === "recipe_not_found"; }
  check("11.2 buildPromptPlan sem orgId → recipe_not_found pra alias org-scoped", planFail);

  // ─── Relatório final ───
  const passed = results.length - failures;
  console.log(`\n${passed}/${results.length} checks OK`);
  for (const r of results) console.log(`  ${r.ok ? "✓" : "✗"} ${r.name}`);
  process.exit(failures > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
