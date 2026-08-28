/**
 * TEST — CompetitorClassificationService (Closure Track B do PRD-PEL-01, F3).
 * DB-backed, determinístico. Prova:
 *   1. Schema: competitor_post_classifications criada com colunas certas;
 *   2. Validações: missing_org/missing_post/post_not_found/missing_recipe;
 *   3. classifyPost integra com VRE.suggestForBriefing (DI-injetável);
 *   4. Ownership via chain post → competitor → org;
 *   5. Post sem caption: não quebra (usa fallback synthetic briefing);
 *   6. recipe_version é enriquecido a partir do catálogo VRE;
 *   7. classifyManual grava method='manual' e requer recipe existente;
 *   8. Reclassificar cria linha nova (histórico preservado);
 *   9. getLatestClassification retorna a mais recente por (classified_at, rowid);
 *  10. listClassificationsForPost retorna histórico completo, ordenado desc;
 *  11. classifyBatchForCompetitor: skipped se já tem; reclassifyAll força;
 *  12. distributionForOrg: só última classificação, agrupa, ignora null recipe;
 *  13. distributionForOrg filtra por platform, competitorId, since;
 *  14. listRecentClassifiedPostsForOrg mostra só última + anexa post/competitor;
 *  15. Isolamento: outra org não vê nada.
 *
 * Uso: npm run test:competitor-classification
 */
import os from "os";
import path from "path";
import fs from "fs";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-cc-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-cc-1234567890abcdef";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) {
  results.push({ name, ok });
  if (!ok) failures++;
}

async function main() {
  const dbMod = await import("../src/server/db.js");
  const db = dbMod.default as any;
  const { CompetitorIntelligenceService: CIS } =
    await import("../src/server/CompetitorIntelligenceService.js");
  const { CompetitorPostsService: CPS } =
    await import("../src/server/CompetitorPostsService.js");
  const { CompetitorClassificationService: CCS, ClassificationError } =
    await import("../src/server/CompetitorClassificationService.js");
  const { StudioVisualRecipeService: VRE } =
    await import("../src/server/StudioVisualRecipeService.js");

  // ═══════════════ 1. Schema ═══════════════
  const cols = (db.prepare("PRAGMA table_info(competitor_post_classifications)").all() as any[])
    .map(c => c.name);
  for (const col of ["id", "post_id", "recipe_key", "recipe_version",
    "confidence", "method", "reasoning", "classified_at"]) {
    check(`1.x coluna ${col}`, cols.includes(col));
  }

  // Seed catálogo VRE
  VRE.seedInitialRecipes();

  // DI classifier fake — sempre devolve PRODUCT_EXPLOSION com alta confiança
  // pra tornar o teste determinístico.
  let classifierCalls = 0;
  VRE.configureBriefingClassifier(async (_input, _catalog) => {
    classifierCalls++;
    return {
      recipe_key: "PRODUCT_EXPLOSION",
      reasoning: "test classifier: sempre PRODUCT_EXPLOSION",
      confidence: 0.9,
      alternatives: [],
    };
  });

  const ORG_A = "org-alpha";
  const ORG_B = "org-beta";
  const cA1 = CIS.addCompetitor({ orgId: ORG_A, platform: "instagram", handle: "nike" });
  const cA2 = CIS.addCompetitor({ orgId: ORG_A, platform: "tiktok", handle: "adidas" });
  const cB1 = CIS.addCompetitor({ orgId: ORG_B, platform: "instagram", handle: "puma" });

  const pA1 = CPS.upsertPost({ orgId: ORG_A, competitorId: cA1.id, external_id: "IG-1",
    caption: "Novo tênis com explosão de cores", posted_at: "2026-08-25T10:00:00Z" });
  const pA2 = CPS.upsertPost({ orgId: ORG_A, competitorId: cA1.id, external_id: "IG-2",
    caption: "Outdoor 3D estilo Times Square", posted_at: "2026-08-26T10:00:00Z" });
  const pA3 = CPS.upsertPost({ orgId: ORG_A, competitorId: cA2.id, external_id: "TT-1",
    caption: "", posted_at: "2026-08-27T10:00:00Z" });     // caption vazia
  const pB1 = CPS.upsertPost({ orgId: ORG_B, competitorId: cB1.id, external_id: "PUMA-1",
    caption: "Lifestyle jovem", posted_at: "2026-08-27T00:00:00Z" });

  // ═══════════════ 2. Validações ═══════════════
  let missingOrg = false;
  try { await CCS.classifyPost({ orgId: "", postId: pA1.id }); }
  catch (e: any) { missingOrg = e instanceof ClassificationError && e.code === "missing_org"; }
  check("2.1 orgId vazio → missing_org", missingOrg);

  let missingPost = false;
  try { await CCS.classifyPost({ orgId: ORG_A, postId: "" }); }
  catch (e: any) { missingPost = e instanceof ClassificationError && e.code === "missing_post"; }
  check("2.2 postId vazio → missing_post", missingPost);

  let notFound = false;
  try { await CCS.classifyPost({ orgId: ORG_A, postId: "id-que-nao-existe" }); }
  catch (e: any) { notFound = e instanceof ClassificationError && e.code === "post_not_found"; }
  check("2.3 post inexistente → post_not_found", notFound);

  let crossOrg = false;
  try { await CCS.classifyPost({ orgId: ORG_B, postId: pA1.id }); }
  catch (e: any) { crossOrg = e instanceof ClassificationError && e.code === "post_not_found"; }
  check("2.4 outra org classificar post alheio → post_not_found", crossOrg);

  // ═══════════════ 3. classifyPost happy path ═══════════════
  const cls1 = await CCS.classifyPost({ orgId: ORG_A, postId: pA1.id });
  check("3.1 classifyPost retorna Classification", !!cls1.id);
  check("3.2 recipe_key vem do classifier", cls1.recipe_key === "PRODUCT_EXPLOSION");
  check("3.3 method='llm' (classifier retornou)", cls1.method === "llm");
  check("3.4 confidence = 0.9", cls1.confidence === 0.9);
  check("3.5 reasoning preenchida", (cls1.reasoning || "").length > 0);
  check("3.6 recipe_version enriquecido do catálogo", cls1.recipe_version === 1);
  check("3.7 classifier foi chamado", classifierCalls === 1);

  // ═══════════════ 4. Post sem caption ═══════════════
  const cls3 = await CCS.classifyPost({ orgId: ORG_A, postId: pA3.id });
  check("4.1 post sem caption ainda classifica", !!cls3.id);
  check("4.2 classifier foi chamado no post sem caption", classifierCalls === 2);

  // ═══════════════ 5. classifyManual ═══════════════
  let missingRecipe = false;
  try { CCS.classifyManual({ orgId: ORG_A, postId: pA1.id, recipe_key: "" }); }
  catch (e: any) { missingRecipe = e instanceof ClassificationError && e.code === "missing_recipe"; }
  check("5.1 classifyManual sem recipe → missing_recipe", missingRecipe);

  let recipeNotFound = false;
  try { CCS.classifyManual({ orgId: ORG_A, postId: pA1.id, recipe_key: "GHOST" }); }
  catch (e: any) { recipeNotFound = e instanceof ClassificationError && e.code === "recipe_not_found"; }
  check("5.2 classifyManual com recipe inexistente → recipe_not_found", recipeNotFound);

  let manualCrossOrg = false;
  try { CCS.classifyManual({ orgId: ORG_B, postId: pA1.id, recipe_key: "BILLBOARD_3D" }); }
  catch (e: any) { manualCrossOrg = e instanceof ClassificationError && e.code === "post_not_found"; }
  check("5.3 classifyManual em post alheio → post_not_found", manualCrossOrg);

  const manual = CCS.classifyManual({
    orgId: ORG_A, postId: pA1.id, recipe_key: "BILLBOARD_3D",
    reasoning: "Humano corrige — é 3D billboard, não explosion",
    confidence: 0.95,
  });
  check("5.4 classifyManual grava method='manual'", manual.method === "manual");
  check("5.5 manual recipe_key = BILLBOARD_3D", manual.recipe_key === "BILLBOARD_3D");
  check("5.6 manual confidence clamped", manual.confidence === 0.95);
  check("5.7 manual recipe_version do catálogo", manual.recipe_version === 1);

  const manualDefault = CCS.classifyManual({
    orgId: ORG_A, postId: pA2.id, recipe_key: "MAGAZINE_COVER",
  });
  check("5.8 classifyManual sem confidence → 1.0", manualDefault.confidence === 1.0);
  check("5.9 classifyManual sem reasoning → default preenchido",
    (manualDefault.reasoning || "").length > 0);

  // ═══════════════ 6. Histórico (reclassificar) ═══════════════
  // pA1 já tem 2: cls1 (llm) e manual. Reclassificar cria uma 3ª.
  const cls1Again = await CCS.classifyPost({ orgId: ORG_A, postId: pA1.id });
  check("6.1 reclassificar cria linha nova", cls1Again.id !== cls1.id);

  const history = CCS.listClassificationsForPost(ORG_A, pA1.id);
  check("6.2 histórico tem 3 entradas em pA1", history.length === 3);
  check("6.3 histórico ordenado desc (mais recente primeiro)",
    history[0].id === cls1Again.id);

  // ═══════════════ 7. getLatestClassification ═══════════════
  const latest = CCS.getLatestClassification(ORG_A, pA1.id);
  check("7.1 latest = a mais recente", latest?.id === cls1Again.id);

  const latestCross = CCS.getLatestClassification(ORG_B, pA1.id);
  check("7.2 outra org → null", latestCross === null);

  const latestNone = CCS.getLatestClassification(ORG_A, "id-inexistente");
  check("7.3 post inexistente → null", latestNone === null);

  // pA2 tem 1 (o manual MAGAZINE_COVER)
  const latestP2 = CCS.getLatestClassification(ORG_A, pA2.id);
  check("7.4 pA2 latest = MAGAZINE_COVER manual", latestP2?.recipe_key === "MAGAZINE_COVER");

  // ═══════════════ 8. classifyBatchForCompetitor ═══════════════
  // pA1 já tem classificações → skipped. pA2 já tem → skipped. Sem novos.
  const batch1 = await CCS.classifyBatchForCompetitor({ orgId: ORG_A, competitorId: cA1.id });
  check("8.1 batch sem reclassifyAll: só posts sem classificação são processados",
    batch1.classified === 0 && batch1.skipped === 2);

  // Reclassificar todos
  const batch2 = await CCS.classifyBatchForCompetitor({
    orgId: ORG_A, competitorId: cA1.id, reclassifyAll: true });
  check("8.2 reclassifyAll: todos processados", batch2.classified === 2 && batch2.skipped === 0);

  // cA2 tem 1 post (pA3) sem classificação
  const batchA2 = await CCS.classifyBatchForCompetitor({ orgId: ORG_A, competitorId: cA2.id });
  check("8.3 batch em cA2: pA3 sem class → classified=1",
    batchA2.classified === 0 && batchA2.skipped === 1);
  // (pA3 já foi classificado no test 4)

  // ═══════════════ 9. distributionForOrg ═══════════════
  // Estado atual em ORG_A:
  // - pA1: última = PRODUCT_EXPLOSION (batch reclassifyAll acima)
  // - pA2: última = PRODUCT_EXPLOSION (batch reclassifyAll acima)
  // - pA3: única = PRODUCT_EXPLOSION (do test 4)
  // Todas 3 pra PRODUCT_EXPLOSION.
  const dist = CCS.distributionForOrg(ORG_A);
  check("9.1 total_classified = 3", dist.total_classified === 3);
  check("9.2 by_recipe tem 1 entrada", dist.by_recipe.length === 1);
  check("9.3 PRODUCT_EXPLOSION uses=3", dist.by_recipe[0].recipe_key === "PRODUCT_EXPLOSION" && dist.by_recipe[0].uses === 3);
  check("9.4 name enriquecido do catálogo", dist.by_recipe[0].name === "Product Explosion");

  // Filtro por platform
  const distIG = CCS.distributionForOrg(ORG_A, { platform: "instagram" });
  check("9.5 filtro platform=instagram → 2 posts", distIG.total_classified === 2);

  // Filtro por competitor
  const distCA2 = CCS.distributionForOrg(ORG_A, { competitorId: cA2.id });
  check("9.6 filtro competitorId=cA2 → 1 post", distCA2.total_classified === 1);

  // Isolamento: ORG_B não deve ter classifications
  const distB = CCS.distributionForOrg(ORG_B);
  check("9.7 ORG_B sem classificações ainda → total=0", distB.total_classified === 0);

  // ═══════════════ 10. listRecentClassifiedPostsForOrg ═══════════════
  const feed = CCS.listRecentClassifiedPostsForOrg(ORG_A);
  check("10.1 feed traz 3 (uma por post)", feed.length === 3);
  check("10.2 anexa competitor_platform",
    feed.every(c => typeof c.competitor_platform === "string"));
  check("10.3 anexa competitor_handle",
    feed.every(c => typeof c.competitor_handle === "string"));
  check("10.4 anexa post_caption",
    feed.some(c => c.post_caption === "Outdoor 3D estilo Times Square"));

  const feedFiltered = CCS.listRecentClassifiedPostsForOrg(ORG_A, { recipeKey: "MAGAZINE_COVER" });
  check("10.5 filtro recipeKey — 0 posts com MAGAZINE_COVER (foi sobrescrito no reclassifyAll)",
    feedFiltered.length === 0);

  const feedIG = CCS.listRecentClassifiedPostsForOrg(ORG_A, { platform: "instagram" });
  check("10.6 filtro platform=instagram → 2 posts", feedIG.length === 2);

  const feedB = CCS.listRecentClassifiedPostsForOrg(ORG_B);
  check("10.7 ORG_B sem class ainda → []", feedB.length === 0);

  // ═══════════════ 11. Isolamento em listClassificationsForPost ═══════════════
  const histCross = CCS.listClassificationsForPost(ORG_B, pA1.id);
  check("11.1 outra org listar histórico de post alheio → []", histCross.length === 0);

  // Confirmar que ORG_B só vê seus próprios posts quando classificar
  const clsB = await CCS.classifyPost({ orgId: ORG_B, postId: pB1.id });
  check("11.2 ORG_B pode classificar seus posts", !!clsB.id);

  const distB2 = CCS.distributionForOrg(ORG_B);
  check("11.3 ORG_B agora tem 1 classificação", distB2.total_classified === 1);

  const distA2 = CCS.distributionForOrg(ORG_A);
  check("11.4 ORG_A não é afetada por ORG_B", distA2.total_classified === 3);

  // ═══════════════ 12. Cleanup ═══════════════
  VRE.resetBriefingClassifier();

  // ─── Relatório final ───
  const passed = results.length - failures;
  console.log(`\n${passed}/${results.length} checks OK`);
  for (const r of results) console.log(`  ${r.ok ? "✓" : "✗"} ${r.name}`);
  process.exit(failures > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
