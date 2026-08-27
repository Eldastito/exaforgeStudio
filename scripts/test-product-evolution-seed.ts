/**
 * TEST — Seed do Product Evolution Ledger (ADR-193 F5).
 * DB-backed, determinístico. Prova:
 *   1. runSeed() executa sem erro e cria os 25 items da matriz F0;
 *   2. Idempotência: rodar 2x produz mesmo estado (skip existente);
 *   3. Estados finais correspondem ao target_status da matriz;
 *   4. blocked_reason preservado nas iniciativas bloqueadas;
 *   5. Sources são anexadas e deduplicadas;
 *   6. Gaps view coerente (PRODUCTION/IDEA fora, TESTED/PRD_READY sem evid. dentro);
 *   7. Filtros da API funcionam sobre o seed;
 *   8. seedProgressTo respeita STATUS_GRAPH.
 *
 * Uso: npm run test:product-evolution-seed
 */
import os from "os";
import path from "path";
import fs from "fs";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-pel-seed-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-seed-1234567890abcdef";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) {
  results.push({ name, ok });
  if (!ok) failures++;
}

async function main() {
  const dbMod = await import("../src/server/db.js");
  const db = dbMod.default as any;
  const { ProductEvolutionLedgerService: PEL } = await import("../src/server/ProductEvolutionLedgerService.js");
  const { runSeed } = await import("./seed-product-evolution-ledger.js");

  // ═══════════════ 1. runSeed() executa ═══════════════
  const summary1 = await runSeed({ silent: true });
  check("1.1 runSeed() sem erros", summary1.errors.length === 0);
  check("1.2 cria 25 items", summary1.created.length === 25);
  check("1.3 21 status ajustados (4 permanecem em IDEA por design)", summary1.status_bumped.length === 21);
  check("1.4 fontes anexadas > 40", summary1.sources_added.reduce((a, b) => a + b.count, 0) > 40);

  const total1 = (db.prepare("SELECT COUNT(*) as n FROM product_evolution_items").get() as any).n;
  check("1.5 total no db = 25", total1 === 25);

  // ═══════════════ 2. Chaves presentes ═══════════════
  const expected = [
    "CEO_OPERATING_LAYER", "MISSION_OPERATING_LAYER", "DECISION_INTELLIGENCE_RADAR",
    "EXECUTION_RUNTIME_ZAPPFLOW", "FALA_TU", "RETAIL_FLOOR_TOULON", "PETSHOP",
    "AGENDA_FEDERADA", "BEAUTY_SALOES", "ADVOCACIA", "CONTENT_GROWTH_ENGINE",
    "SOCIAL_PROVIDERS", "INTELLIGENCE_HUB", "VISUAL_RECIPE_ENGINE", "BUSINESS_SKILLS_PACK",
    "VISION_VMS_CONTROL_PLANE", "VISION_EDGE_PERCEPTION", "WIFI_PRESENCE_CSI",
    "ZAPFLOW_SENSE", "PLATFORM_RELIABILITY_CAPACITY", "INTEGRATION_FACTORY",
    "RECLAME_AQUI_INTELLIGENCE", "ENTERPRISE_INTELLIGENCE_CONTROLER", "AI_RELIABILITY",
    "STUDIO_IMAGE_GEN_CORE",
  ];
  const allPresent = expected.every(k => PEL.getItem(k) !== null);
  check("2.1 todas as 25 chaves esperadas foram criadas", allPresent);

  // ═══════════════ 3. Estados finais ═══════════════
  check("3.1 CEO_OPERATING_LAYER em PRODUCTION", PEL.getItem("CEO_OPERATING_LAYER")?.status === "PRODUCTION");
  check("3.2 FALA_TU em PRODUCTION", PEL.getItem("FALA_TU")?.status === "PRODUCTION");
  check("3.3 VISION_VMS_CONTROL_PLANE em TESTED", PEL.getItem("VISION_VMS_CONTROL_PLANE")?.status === "TESTED");
  check("3.4 BUSINESS_SKILLS_PACK fica em IDEA (target IDEA)", PEL.getItem("BUSINESS_SKILLS_PACK")?.status === "IDEA");
  check("3.5 VISION_EDGE_PERCEPTION fica em IDEA (NÃO EXISTE)", PEL.getItem("VISION_EDGE_PERCEPTION")?.status === "IDEA");
  check("3.6 WIFI_PRESENCE_CSI fica em IDEA (conceitual)", PEL.getItem("WIFI_PRESENCE_CSI")?.status === "IDEA");
  check("3.7 ZAPFLOW_SENSE fica em IDEA (cascata NÃO EXISTE)", PEL.getItem("ZAPFLOW_SENSE")?.status === "IDEA");
  check("3.8 VISUAL_RECIPE_ENGINE em PRD_READY", PEL.getItem("VISUAL_RECIPE_ENGINE")?.status === "PRD_READY");
  check("3.9 RETAIL_FLOOR_TOULON em PILOT (precisa validar dados reais)", PEL.getItem("RETAIL_FLOOR_TOULON")?.status === "PILOT");

  // ═══════════════ 4. blocked_reason preservado ═══════════════
  const bsp = PEL.getItem("BUSINESS_SKILLS_PACK");
  check("4.1 BUSINESS_SKILLS_PACK tem blocked_reason mencionando PRD-BSP-01",
    !!bsp?.blocked_reason && bsp.blocked_reason.includes("PRD-BSP-01"));
  check("4.2 VISION_EDGE_PERCEPTION tem blocked_reason (runtime adiado)",
    !!PEL.getItem("VISION_EDGE_PERCEPTION")?.blocked_reason);
  check("4.3 RETAIL_FLOOR_TOULON tem blocked_reason (campo pendente)",
    !!PEL.getItem("RETAIL_FLOOR_TOULON")?.blocked_reason);
  check("4.4 RECLAME_AQUI_INTELLIGENCE tem blocked_reason (Reclame AQUI)",
    !!PEL.getItem("RECLAME_AQUI_INTELLIGENCE")?.blocked_reason);

  // ═══════════════ 5. Sources anexadas ═══════════════
  const ceoSources = PEL.listSources("CEO_OPERATING_LAYER");
  check("5.1 CEO_OPERATING_LAYER tem ≥3 sources", ceoSources.length >= 3);
  check("5.2 sources incluem ADR", ceoSources.some(s => s.source_type === "adr"));
  check("5.3 sources incluem PRD", ceoSources.some(s => s.source_type === "prd"));

  const missionSources = PEL.listSources("MISSION_OPERATING_LAYER");
  check("5.4 MISSION_OPERATING_LAYER tem sources", missionSources.length >= 2);

  // ═══════════════ 6. Idempotência: segundo run ═══════════════
  const summary2 = await runSeed({ silent: true });
  check("6.1 segundo run: 0 criados", summary2.created.length === 0);
  check("6.2 segundo run: 25 já existiam", summary2.skipped_existing.length === 25);
  check("6.3 segundo run: 0 status ajustados (já no alvo)", summary2.status_bumped.length === 0);
  check("6.4 segundo run: 0 fontes novas", summary2.sources_added.reduce((a, b) => a + b.count, 0) === 0);

  const total2 = (db.prepare("SELECT COUNT(*) as n FROM product_evolution_items").get() as any).n;
  check("6.5 total inalterado após 2º run", total2 === total1);
  const ceoSourcesAfter = PEL.listSources("CEO_OPERATING_LAYER");
  check("6.6 sources não duplicadas após 2º run", ceoSourcesAfter.length === ceoSources.length);

  // ═══════════════ 7. Gaps view coerente ═══════════════
  const gaps = PEL.gaps();
  check("7.1 PRODUCTION não aparece em gaps",
    !gaps.some(i => i.evolution_key === "PLATFORM_RELIABILITY_CAPACITY"));
  check("7.2 IDEA não aparece em gaps",
    !gaps.some(i => i.evolution_key === "BUSINESS_SKILLS_PACK") &&
    !gaps.some(i => i.evolution_key === "VISION_EDGE_PERCEPTION"));
  check("7.3 TESTED sem evid. aparece em gaps",
    gaps.some(i => i.evolution_key === "CONTENT_GROWTH_ENGINE"));
  check("7.4 PRD_READY sem evid. aparece em gaps",
    gaps.some(i => i.evolution_key === "VISUAL_RECIPE_ENGINE"));

  // Ordenação por prioridade
  const p0Gaps = gaps.filter(i => i.priority === "P0");
  const p1Gaps = gaps.filter(i => i.priority === "P1");
  if (p0Gaps.length > 0 && p1Gaps.length > 0) {
    const firstP0Idx = gaps.findIndex(i => i.priority === "P0");
    const firstP1Idx = gaps.findIndex(i => i.priority === "P1");
    check("7.5 gaps P0 vêm antes de P1", firstP0Idx < firstP1Idx);
  } else {
    check("7.5 sem P0 ou P1 pra comparar — skip", true);
  }

  // ═══════════════ 8. Filtros ═══════════════
  const production = PEL.listItems({ status: "PRODUCTION" });
  check("8.1 ≥6 items em PRODUCTION", production.length >= 6);

  const growth = PEL.listItems({ domain: "growth" });
  check("8.2 ≥3 items em domain=growth", growth.length >= 3);

  const studio = PEL.listItems({ q: "studio" });
  check("8.3 busca por 'studio' retorna VISUAL_RECIPE_ENGINE e STUDIO_IMAGE_GEN_CORE",
    studio.some(i => i.evolution_key === "VISUAL_RECIPE_ENGINE") &&
    studio.some(i => i.evolution_key === "STUDIO_IMAGE_GEN_CORE"));

  // ═══════════════ 9. seedProgressTo respeita grafo ═══════════════
  PEL.createItem({ evolution_key: "PROGRESS_TEST", title: "progressão" });
  const progressed = PEL.seedProgressTo("PROGRESS_TEST", "TESTED", "test");
  check("9.1 seedProgressTo IDEA → TESTED funciona", progressed.status === "TESTED");

  PEL.createItem({ evolution_key: "PROGRESS_TEST_VALIDATED", title: "target validated" });
  const stopped = PEL.seedProgressTo("PROGRESS_TEST_VALIDATED", "VALIDATED", "test");
  check("9.2 seedProgressTo target=VALIDATED para em PRODUCTION (sem evid.)", stopped.status === "PRODUCTION");

  const stopped2 = PEL.seedProgressTo("PROGRESS_TEST_VALIDATED", "VALIDATED", "test");
  check("9.3 seedProgressTo é idempotente no target efetivo", stopped2.status === "PRODUCTION");

  // ─── Relatório final ───
  const passed = results.length - failures;
  console.log(`\n${passed}/${results.length} checks OK`);
  for (const r of results) console.log(`  ${r.ok ? "✓" : "✗"} ${r.name}`);
  process.exit(failures > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
