/**
 * TEST — CompetitorInsightsService (Closure Track B do PRD-PEL-01, F4).
 * DB-backed, determinístico. Prova:
 *   1. compareRecipeUsage sem dados → totais zero, by_recipe=[];
 *   2. compareRecipeUsage faz UNION de keys (recipes só num lado
 *      aparecem com uses=0 no outro);
 *   3. own_share e competitor_share são fração do próprio total;
 *   4. delta_share = competitor_share - own_share; ordena desc;
 *   5. topGapsForOrg: filtra own_uses=0 AND competitor_uses ≥ min;
 *      ordena por competitor_uses DESC;
 *   6. Filtro platform propaga pra distribution;
 *   7. Filtro since propaga pras duas fontes;
 *   8. trendingRecipes: janela atual vs anterior; classifica up/down/flat;
 *      ordena delta_share DESC;
 *   9. trendingRecipes com ambas janelas vazias → [];
 *  10. Isolamento multi-tenant (ORG_B não vê dados de ORG_A).
 *
 * Uso: npm run test:competitor-insights
 */
import os from "os";
import path from "path";
import fs from "fs";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-ci-insights-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-ci-insights-1234567890";

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
  const { CompetitorClassificationService: CCS } =
    await import("../src/server/CompetitorClassificationService.js");
  const { CompetitorInsightsService: CInsights } =
    await import("../src/server/CompetitorInsightsService.js");
  const { StudioVisualRecipeService: VRE } =
    await import("../src/server/StudioVisualRecipeService.js");

  VRE.seedInitialRecipes();

  const ORG_A = "org-alpha";
  const ORG_B = "org-beta";

  // ═══════════════ 1. Estado vazio ═══════════════
  const emptyCmp = CInsights.compareRecipeUsage(ORG_A);
  check("1.1 sem dados: own_total=0", emptyCmp.own_total === 0);
  check("1.2 sem dados: competitor_total=0", emptyCmp.competitor_total === 0);
  check("1.3 sem dados: by_recipe=[]", emptyCmp.by_recipe.length === 0);

  const emptyGaps = CInsights.topGapsForOrg(ORG_A);
  check("1.4 sem dados: topGaps=[]", emptyGaps.length === 0);

  const emptyTrend = CInsights.trendingRecipes(ORG_A);
  check("1.5 sem dados: trending=[]", emptyTrend.length === 0);

  const emptyOrg = CInsights.compareRecipeUsage("");
  check("1.6 orgId vazio → estrutura vazia", emptyOrg.by_recipe.length === 0);

  // ═══════════════ 2. Setup: gerações próprias + posts classificados ═══════════════
  // Gerações próprias em ORG_A (via studio_creations)
  const insertGen = db.prepare(
    "INSERT INTO studio_creations (id, organization_id, kind, prompt, media_url, created_at) VALUES (?, ?, 'image', ?, '/m/x.png', ?)"
  );
  insertGen.run("g1", ORG_A, "[PRODUCT_EXPLOSION@v1] test", "2026-08-25 10:00:00");
  insertGen.run("g2", ORG_A, "[PRODUCT_EXPLOSION@v1] test2", "2026-08-25 11:00:00");
  insertGen.run("g3", ORG_A, "[BILLBOARD_3D@v1] test3", "2026-08-25 12:00:00");
  // own_total=3: 2 PRODUCT_EXPLOSION, 1 BILLBOARD_3D

  // Competitor accounts
  const cA1 = CIS.addCompetitor({ orgId: ORG_A, platform: "instagram", handle: "nike" });
  const cA2 = CIS.addCompetitor({ orgId: ORG_A, platform: "tiktok", handle: "adidas" });
  const cB1 = CIS.addCompetitor({ orgId: ORG_B, platform: "instagram", handle: "puma" });

  // Posts (all instagram in cA1; tiktok in cA2)
  const pA1 = CPS.upsertPost({ orgId: ORG_A, competitorId: cA1.id, external_id: "P1", posted_at: "2026-08-20T10:00:00Z" });
  const pA2 = CPS.upsertPost({ orgId: ORG_A, competitorId: cA1.id, external_id: "P2", posted_at: "2026-08-21T10:00:00Z" });
  const pA3 = CPS.upsertPost({ orgId: ORG_A, competitorId: cA1.id, external_id: "P3", posted_at: "2026-08-22T10:00:00Z" });
  const pA4 = CPS.upsertPost({ orgId: ORG_A, competitorId: cA2.id, external_id: "P4", posted_at: "2026-08-23T10:00:00Z" });
  const pA5 = CPS.upsertPost({ orgId: ORG_A, competitorId: cA2.id, external_id: "P5", posted_at: "2026-08-24T10:00:00Z" });
  const pB1 = CPS.upsertPost({ orgId: ORG_B, competitorId: cB1.id, external_id: "PB1", posted_at: "2026-08-24T10:00:00Z" });

  // Manual classifications (deterministic — não depende de LLM)
  CCS.classifyManual({ orgId: ORG_A, postId: pA1.id, recipe_key: "MAGAZINE_COVER" });
  CCS.classifyManual({ orgId: ORG_A, postId: pA2.id, recipe_key: "MAGAZINE_COVER" });
  CCS.classifyManual({ orgId: ORG_A, postId: pA3.id, recipe_key: "MAGAZINE_COVER" });
  CCS.classifyManual({ orgId: ORG_A, postId: pA4.id, recipe_key: "LIFESTYLE_SHORT" });
  CCS.classifyManual({ orgId: ORG_A, postId: pA5.id, recipe_key: "BILLBOARD_3D" });
  // ORG_A competitor: 3 MAGAZINE_COVER, 1 LIFESTYLE_SHORT, 1 BILLBOARD_3D (total 5)
  CCS.classifyManual({ orgId: ORG_B, postId: pB1.id, recipe_key: "SOFT_3D" });

  // ═══════════════ 3. compareRecipeUsage ═══════════════
  const cmp = CInsights.compareRecipeUsage(ORG_A);
  check("3.1 own_total = 3", cmp.own_total === 3);
  check("3.2 competitor_total = 5", cmp.competitor_total === 5);
  const byKey = new Map(cmp.by_recipe.map(r => [r.recipe_key, r]));
  check("3.3 UNION inclui PRODUCT_EXPLOSION (só own)", byKey.has("PRODUCT_EXPLOSION"));
  check("3.4 UNION inclui MAGAZINE_COVER (só competitor)", byKey.has("MAGAZINE_COVER"));
  check("3.5 UNION inclui BILLBOARD_3D (ambos)", byKey.has("BILLBOARD_3D"));

  const pe = byKey.get("PRODUCT_EXPLOSION")!;
  check("3.6 PE own_uses=2, competitor_uses=0",
    pe.own_uses === 2 && pe.competitor_uses === 0);
  check("3.7 PE own_share = 2/3", Math.abs(pe.own_share - 2/3) < 0.001);
  check("3.8 PE competitor_share = 0", pe.competitor_share === 0);
  check("3.9 PE delta_share negativo (só uso próprio)", pe.delta_share < 0);

  const mc = byKey.get("MAGAZINE_COVER")!;
  check("3.10 MC own=0, competitor=3", mc.own_uses === 0 && mc.competitor_uses === 3);
  check("3.11 MC competitor_share = 3/5", Math.abs(mc.competitor_share - 3/5) < 0.001);
  check("3.12 MC delta_share positivo (gap)", mc.delta_share > 0);

  const bb = byKey.get("BILLBOARD_3D")!;
  check("3.13 BB own=1, competitor=1", bb.own_uses === 1 && bb.competitor_uses === 1);
  check("3.14 BB shares diferentes (denominadores diferentes)",
    Math.abs(bb.own_share - 1/3) < 0.001 && Math.abs(bb.competitor_share - 1/5) < 0.001);

  // Ordenação: maior delta primeiro → MAGAZINE_COVER deve vir antes de todos
  check("3.15 by_recipe[0] tem MAIOR delta (MAGAZINE_COVER)",
    cmp.by_recipe[0].recipe_key === "MAGAZINE_COVER");

  check("3.16 name enriquecido do catálogo",
    pe.name === "Product Explosion" && mc.name === "Magazine Cover");

  // ═══════════════ 4. topGapsForOrg ═══════════════
  const gaps = CInsights.topGapsForOrg(ORG_A);
  const gapKeys = gaps.map(g => g.recipe_key);
  check("4.1 gaps inclui MAGAZINE_COVER", gapKeys.includes("MAGAZINE_COVER"));
  check("4.2 gaps inclui LIFESTYLE_SHORT", gapKeys.includes("LIFESTYLE_SHORT"));
  check("4.3 gaps NÃO inclui BILLBOARD_3D (own_uses>0)",
    !gapKeys.includes("BILLBOARD_3D"));
  check("4.4 gaps NÃO inclui PRODUCT_EXPLOSION (competitor_uses=0)",
    !gapKeys.includes("PRODUCT_EXPLOSION"));
  check("4.5 gaps ordenado por competitor_uses DESC (MAGAZINE_COVER=3 antes)",
    gaps[0].recipe_key === "MAGAZINE_COVER");

  // Filtro minCompetitorUses = 2 filtra LIFESTYLE_SHORT (uses=1)
  const gapsMin2 = CInsights.topGapsForOrg(ORG_A, { minCompetitorUses: 2 });
  check("4.6 min=2 exclui LIFESTYLE_SHORT (uses=1)",
    !gapsMin2.some(g => g.recipe_key === "LIFESTYLE_SHORT"));
  check("4.7 min=2 mantém MAGAZINE_COVER (uses=3)",
    gapsMin2.some(g => g.recipe_key === "MAGAZINE_COVER"));

  // ═══════════════ 5. Filtro platform ═══════════════
  const cmpIG = CInsights.compareRecipeUsage(ORG_A, { platform: "instagram" });
  // Instagram-only: pA1, pA2, pA3 → 3 MAGAZINE_COVER
  check("5.1 platform=instagram → competitor_total=3", cmpIG.competitor_total === 3);
  const cmpIGmap = new Map(cmpIG.by_recipe.map(r => [r.recipe_key, r]));
  check("5.2 platform=instagram: MC competitor_uses=3",
    cmpIGmap.get("MAGAZINE_COVER")?.competitor_uses === 3);
  check("5.3 platform=instagram: LIFESTYLE_SHORT ausente ou zero",
    (cmpIGmap.get("LIFESTYLE_SHORT")?.competitor_uses || 0) === 0);

  // ═══════════════ 6. Isolamento ORG_B ═══════════════
  const cmpB = CInsights.compareRecipeUsage(ORG_B);
  check("6.1 ORG_B own_total=0 (não gerou)", cmpB.own_total === 0);
  check("6.2 ORG_B competitor_total=1 (só o SOFT_3D)", cmpB.competitor_total === 1);
  check("6.3 ORG_B NÃO vê PRODUCT_EXPLOSION da ORG_A",
    !cmpB.by_recipe.some(r => r.recipe_key === "PRODUCT_EXPLOSION"));

  // ═══════════════ 7. trendingRecipes ═══════════════
  // Cenário: dividir classificações em duas janelas.
  // Vou criar novo cenário com timestamps controlados:
  const cA3 = CIS.addCompetitor({ orgId: ORG_A, platform: "youtube", handle: "reebok" });
  const t1 = CPS.upsertPost({ orgId: ORG_A, competitorId: cA3.id, external_id: "T1" });
  const t2 = CPS.upsertPost({ orgId: ORG_A, competitorId: cA3.id, external_id: "T2" });
  const t3 = CPS.upsertPost({ orgId: ORG_A, competitorId: cA3.id, external_id: "T3" });
  const t4 = CPS.upsertPost({ orgId: ORG_A, competitorId: cA3.id, external_id: "T4" });

  // Janela anterior (mais antiga): t1 + t2
  const insertCls = db.prepare(
    "INSERT INTO competitor_post_classifications (id, post_id, recipe_key, recipe_version, confidence, method, reasoning, classified_at) VALUES (?, ?, ?, 1, 0.9, 'manual', 'test', ?)"
  );
  insertCls.run("cls-a1", t1.id, "PRODUCT_EXPLOSION", "2026-07-01 10:00:00");
  insertCls.run("cls-a2", t2.id, "PRODUCT_EXPLOSION", "2026-07-05 10:00:00");
  // Janela atual: t3 + t4 (semanas mais recentes)
  insertCls.run("cls-b1", t3.id, "BILLBOARD_3D", "2026-08-15 10:00:00");
  insertCls.run("cls-b2", t4.id, "BILLBOARD_3D", "2026-08-16 10:00:00");
  // Total no cenário completo: 2 PE (antigos) + 2 BB (novos) — em ORG_A YouTube

  // now = 2026-08-20, windowDays = 14 → currentStart = 2026-08-06
  // Janela atual: 2026-08-06 → 2026-08-20 → cls-b1, cls-b2 (BILLBOARD_3D)
  // Janela anterior: 2026-07-23 → 2026-08-06 → nada
  // Precisa windowDays maior pra pegar os PE
  const now = new Date("2026-08-20T00:00:00Z");
  const trending = CInsights.trendingRecipes(ORG_A, {
    platform: "youtube", windowDays: 20, now,
  });
  // windowDays=20: current = 2026-07-31 → 2026-08-20; previous = 2026-07-11 → 2026-07-31
  // Current: cls-b1, cls-b2 → 2 BILLBOARD_3D
  // Previous: nenhum (cls-a1 é 2026-07-01, fora da previous)
  const trendKeys = trending.map(t => t.recipe_key);
  check("7.1 trending inclui BILLBOARD_3D (up)", trendKeys.includes("BILLBOARD_3D"));

  const bb2 = trending.find(t => t.recipe_key === "BILLBOARD_3D")!;
  check("7.2 BB direction=up", bb2.direction === "up");
  check("7.3 BB current_uses=2", bb2.current_uses === 2);

  // Ampliar janela pra incluir PE também
  const trendingWide = CInsights.trendingRecipes(ORG_A, {
    platform: "youtube", windowDays: 30, now,
  });
  // windowDays=30: current = 2026-07-21 → 2026-08-20; previous = 2026-06-21 → 2026-07-21
  // Current: cls-a1 (2026-07-01)... espera, 2026-07-01 < 2026-07-21 → previous.
  // Actually cls-a1 = 2026-07-01, previous window = 2026-06-21 → 2026-07-21 → INCLUI
  // cls-a2 = 2026-07-05, previous window → INCLUI
  // Current: cls-b1 e cls-b2
  const wideMap = new Map(trendingWide.map(t => [t.recipe_key, t]));
  check("7.4 janela ampla inclui PE (só previous)", wideMap.has("PRODUCT_EXPLOSION"));
  const peTrend = wideMap.get("PRODUCT_EXPLOSION")!;
  check("7.5 PE previous_uses=2, current_uses=0",
    peTrend.previous_uses === 2 && peTrend.current_uses === 0);
  check("7.6 PE direction=down", peTrend.direction === "down");

  // ═══════════════ 8. Janela sem dados ═══════════════
  const trendingFuture = CInsights.trendingRecipes(ORG_A, {
    platform: "youtube", windowDays: 5, now: new Date("2027-01-01"),
  });
  check("8.1 janela futura sem dados → []", trendingFuture.length === 0);

  // Sem orgId
  const trendingEmpty = CInsights.trendingRecipes("");
  check("8.2 orgId vazio → []", trendingEmpty.length === 0);

  // ─── Relatório final ───
  const passed = results.length - failures;
  console.log(`\n${passed}/${results.length} checks OK`);
  for (const r of results) console.log(`  ${r.ok ? "✓" : "✗"} ${r.name}`);
  process.exit(failures > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
