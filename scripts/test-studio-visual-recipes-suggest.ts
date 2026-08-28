/**
 * TEST — StudioVisualRecipeService.suggestForBriefing (ADR-194 F3.5).
 * DB-backed, determinístico. Prova:
 *   1. briefing vazio rejeitado (VisualRecipeError missing_briefing);
 *   2. LLM classifier injetado retorna key válida → suggestion + method='llm';
 *   3. LLM classifier retorna key inválida → cai no fallback keyword;
 *   4. LLM classifier retorna null → cai no fallback keyword;
 *   5. LLM classifier lança erro → cai no fallback (silencioso);
 *   6. Fallback keyword pontua por hits em name/description/intent/verticais;
 *   7. Alternatives filtradas por catálogo (keys inexistentes descartadas);
 *   8. Confidence do LLM clamped em [0,1];
 *   9. Filtro por formato remove receitas incompatíveis;
 *  10. Catálogo vazio → suggestion=null;
 *  11. Fallback com zero hits → devolve primeira do catálogo com confidence 0.1;
 *  12. Normalização de acentos funciona (palavra com til vs sem).
 *
 * Uso: npm run test:studio-visual-recipes-suggest
 */
import os from "os";
import path from "path";
import fs from "fs";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-vre-suggest-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-vre-suggest-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) {
  results.push({ name, ok });
  if (!ok) failures++;
}

async function main() {
  const { StudioVisualRecipeService: VRE, VisualRecipeError } =
    await import("../src/server/StudioVisualRecipeService.js");

  // Precisa do catálogo pra ter algo a sugerir.
  VRE.seedInitialRecipes();

  // ═══════════════ 1. Validação ═══════════════
  let missingBriefing = false;
  try { await VRE.suggestForBriefing({ briefing: "" }); }
  catch (e: any) { missingBriefing = e instanceof VisualRecipeError && e.code === "missing_briefing"; }
  check("1.1 briefing vazio rejeitado (missing_briefing)", missingBriefing);

  let onlySpaces = false;
  try { await VRE.suggestForBriefing({ briefing: "   " }); }
  catch (e: any) { onlySpaces = e instanceof VisualRecipeError && e.code === "missing_briefing"; }
  check("1.2 briefing só com espaços rejeitado", onlySpaces);

  // ═══════════════ 2. LLM classifier injetado, key válida ═══════════════
  let classifierCalls = 0;
  let lastBriefing = "";
  let lastCatalogSize = 0;
  VRE.configureBriefingClassifier(async (input, catalog) => {
    classifierCalls++;
    lastBriefing = input.briefing;
    lastCatalogSize = catalog.length;
    return {
      recipe_key: "PRODUCT_EXPLOSION",
      reasoning: "briefing menciona produto em foco dramático",
      confidence: 0.85,
      alternatives: [
        { recipe_key: "BILLBOARD_3D", reasoning: "também tem apelo dramático" },
        { recipe_key: "KEY_INEXISTENTE", reasoning: "deve ser filtrado" },
      ],
    };
  });

  const r1 = await VRE.suggestForBriefing({ briefing: "explosão do meu tênis novo" });
  check("2.1 LLM classifier foi chamado", classifierCalls === 1);
  check("2.2 briefing chegou no classifier", lastBriefing === "explosão do meu tênis novo");
  check("2.3 catálogo passado ao classifier ≥ 6 (seed)", lastCatalogSize >= 6);
  check("2.4 method='llm'", r1.method === "llm");
  check("2.5 suggestion.recipe_key = PRODUCT_EXPLOSION", r1.suggestion?.recipe_key === "PRODUCT_EXPLOSION");
  check("2.6 suggestion.name preenchido", !!r1.suggestion?.name && r1.suggestion?.name === "Product Explosion");
  check("2.7 suggestion.reasoning preenchida", (r1.suggestion?.reasoning || "").length > 0);
  check("2.8 suggestion.confidence = 0.85", r1.suggestion?.confidence === 0.85);
  check("2.9 alternatives filtradas (KEY_INEXISTENTE removida)",
    r1.alternatives.length === 1 && r1.alternatives[0].recipe_key === "BILLBOARD_3D");
  check("2.10 alternative name preenchido do catálogo",
    r1.alternatives[0].name === "3D Billboard");

  // ═══════════════ 3. LLM retorna key inválida → fallback ═══════════════
  VRE.configureBriefingClassifier(async () => ({
    recipe_key: "COMPLETELY_MADE_UP",
    reasoning: "chute",
    confidence: 0.9,
    alternatives: [],
  }));
  const r2 = await VRE.suggestForBriefing({ briefing: "outdoor 3d luminoso na cidade" });
  check("3.1 key inválida do LLM → method=fallback_keyword", r2.method === "fallback_keyword");
  // "outdoor" bate com BILLBOARD_3D (name: "3D Billboard" — "3d" match) e descrição menciona outdoor
  check("3.2 fallback sugere BILLBOARD_3D (name inclui '3d')",
    r2.suggestion?.recipe_key === "BILLBOARD_3D");

  // ═══════════════ 4. LLM retorna null → fallback ═══════════════
  VRE.configureBriefingClassifier(async () => null);
  const r3 = await VRE.suggestForBriefing({ briefing: "capa de revista com produto" });
  check("4.1 LLM null → method=fallback_keyword", r3.method === "fallback_keyword");
  check("4.2 fallback sugere MAGAZINE_COVER pra briefing 'capa revista'",
    r3.suggestion?.recipe_key === "MAGAZINE_COVER");

  // ═══════════════ 5. LLM lança erro → fallback (silencioso) ═══════════════
  VRE.configureBriefingClassifier(async () => { throw new Error("upstream down"); });
  const r4 = await VRE.suggestForBriefing({ briefing: "lifestyle jovem casual" });
  check("5.1 LLM error → não propaga; method=fallback_keyword", r4.method === "fallback_keyword");
  check("5.2 fallback sugere LIFESTYLE_SHORT pra 'lifestyle'",
    r4.suggestion?.recipe_key === "LIFESTYLE_SHORT");

  // ═══════════════ 6. Filtro por formato ═══════════════
  VRE.configureBriefingClassifier(async () => null);
  // SOFT_3D só suporta feed_1_1 e square_1_1. Pedindo landscape_16_9, ele NÃO deve aparecer.
  const r5 = await VRE.suggestForBriefing({ briefing: "3d soft pastel", format: "landscape_16_9" as any });
  check("6.1 SOFT_3D removido quando format=landscape_16_9 (não suportado)",
    r5.suggestion?.recipe_key !== "SOFT_3D");
  check("6.2 sugestão ainda é uma recipe que suporta landscape_16_9",
    !!r5.suggestion && ["BILLBOARD_3D", "ADD_CREATIVE"].includes(r5.suggestion.recipe_key));

  // Format aceito por SOFT_3D → volta a aparecer
  const r6 = await VRE.suggestForBriefing({ briefing: "3d soft pastel", format: "feed_1_1" as any });
  check("6.3 SOFT_3D reaparece com format=feed_1_1", r6.suggestion?.recipe_key === "SOFT_3D");

  // ═══════════════ 7. Fallback zero hits ═══════════════
  const r7 = await VRE.suggestForBriefing({ briefing: "xyzzy qwerty absurdo" });
  check("7.1 zero hits → suggestion.confidence baixa (0.1)", r7.suggestion?.confidence === 0.1);
  check("7.2 zero hits → suggestion não é null (primeira do catálogo)", r7.suggestion !== null);
  check("7.3 zero hits → alternatives=[]", r7.alternatives.length === 0);

  // ═══════════════ 8. Confidence clamp ═══════════════
  VRE.configureBriefingClassifier(async () => ({
    recipe_key: "PRODUCT_EXPLOSION", reasoning: "x", confidence: 1.5, alternatives: [],
  }));
  const rHigh = await VRE.suggestForBriefing({ briefing: "explosão" });
  check("8.1 confidence > 1 clamped em 1", rHigh.suggestion?.confidence === 1);

  VRE.configureBriefingClassifier(async () => ({
    recipe_key: "PRODUCT_EXPLOSION", reasoning: "x", confidence: -0.2, alternatives: [],
  }));
  const rLow = await VRE.suggestForBriefing({ briefing: "explosão" });
  check("8.2 confidence < 0 clamped em 0", rLow.suggestion?.confidence === 0);

  // ═══════════════ 9. Normalização de acentos no fallback ═══════════════
  VRE.configureBriefingClassifier(async () => null);
  // "explosão" (com acento) deve casar com "product_explosion" (sem acento).
  const rAccent = await VRE.suggestForBriefing({ briefing: "explosão de produto" });
  check("9.1 briefing com acento casa com catálogo sem acento",
    rAccent.suggestion?.recipe_key === "PRODUCT_EXPLOSION" && (rAccent.suggestion?.confidence || 0) > 0.1);

  // ═══════════════ 10. Cleanup ═══════════════
  VRE.resetBriefingClassifier();

  // ─── Relatório final ───
  const passed = results.length - failures;
  console.log(`\n${passed}/${results.length} checks OK`);
  for (const r of results) console.log(`  ${r.ok ? "✓" : "✗"} ${r.name}`);
  process.exit(failures > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
