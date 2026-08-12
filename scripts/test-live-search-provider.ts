/**
 * TEST — LiveSearchResearchProvider (PRD 9 / ADR-166 F8). Unidade pura + provider.
 *
 * Prova (§53/§54, RN-EI-2/4/6/7):
 *   - parseLiveSearch mapeia fontes recuperadas → evidenceMode 'live', tier 'B', retrievedAt;
 *   - aceita {results:[...]} e array no topo; vazio → null;
 *   - query/content derivam só da taxonomia (sem dado de tenant);
 *   - SEM vendor configurado → provider cai no stub (model_knowledge), NÃO inventa live;
 *   - 'live' registrado no registry (mesmo contrato, sem pipeline paralelo).
 *
 * Uso: npm run test:live-search-provider
 */
import os from "os"; import path from "path"; import fs from "fs";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-live-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-live-123456";
delete process.env.EXTERNAL_RESEARCH_SEARCH_URL; // garante estado não-configurado

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  await import("../src/server/db.js");
  const { parseLiveSearch, LiveSearchResearchProvider, getResearchProvider } = await import("../src/server/ExternalResearchProvider.js");
  const q = { vertical: "padaria", topic: "insumos", query: "padaria insumos" };
  const RA = "2026-08-12T12:00:00.000Z";

  // ═══════════════ 1. parseLiveSearch → evidenceMode live + tier B + retrievedAt ═══════════════
  const raw1 = JSON.stringify({ results: [
    { url: "https://abip.org.br/r1", title: "Custo da farinha sobe", snippet: "alta de 12% no trimestre", publisher: "ABIP", date: "2026-07" },
    { url: "https://ex.com/r2", title: "Sazonalidade de inverno" },
  ] });
  const r1 = parseLiveSearch(raw1, q, { retrievedAt: RA })!;
  check("1.1 evidenceMode live", r1.evidenceMode === "live");
  check("1.2 duas fontes recuperadas, tier B", r1.sourceEvidence.length === 2 && r1.sourceEvidence.every((e: any) => e.tier === "B"));
  check("1.3 retrievedAt propagado (injeção, sem relógio)", r1.sourceEvidence.every((e: any) => e.retrievedAt === RA) && r1.retrievedAt === RA);
  check("1.4 publisher + freshness capturados", r1.sourceEvidence[0].publisher === "ABIP" && r1.sourceEvidence[0].freshness === "2026-07");
  check("1.5 drivers vêm dos snippets/títulos", r1.content.drivers.length === 2 && r1.content.generatedBy === "live_search");
  check("1.6 costCents > 0 (busca real custa)", (r1.costCents ?? 0) > 0);

  // ═══════════════ 2. aceita array no topo; vazio → null ═══════════════
  const r2 = parseLiveSearch(JSON.stringify([{ url: "https://x.com/a", title: "A" }]), q, { retrievedAt: RA })!;
  check("2.1 array no topo aceito", r2.evidenceMode === "live" && r2.sourceEvidence.length === 1);
  check("2.2 sem resultados → null (não inventa fonte, RN-EI-6)", parseLiveSearch(JSON.stringify({ results: [] }), q, { retrievedAt: RA }) === null);
  check("2.3 JSON inválido → null", parseLiveSearch("nao é json", q, { retrievedAt: RA }) === null);

  // ═══════════════ 3. content deriva só da taxonomia (sem dado de tenant) ═══════════════
  check("3.1 summary/scope só do nicho", r1.content.scope === "padaria · insumos" && /padaria/.test(r1.content.summary));

  // ═══════════════ 4. SEM vendor → cai no stub (honesto, model_knowledge) ═══════════════
  const live = new LiveSearchResearchProvider();
  check("4.1 isConfigured false sem env", LiveSearchResearchProvider.isConfigured() === false);
  const res = await live.research(q);
  check("4.2 sem vendor → evidenceMode model_knowledge (não finge live)", res.evidenceMode === "model_knowledge");
  check("4.3 sem vendor → sourceEvidence vazio (não inventa fonte)", res.sourceEvidence.length === 0 && res.retrievedAt === null);

  // ═══════════════ 5. 'live' no registry (mesmo contrato) ═══════════════
  const fromRegistry = getResearchProvider("live");
  check("5.1 registry resolve 'live'", fromRegistry.name === "live");

  // ── relatório ──
  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} live-search-provider: ${passed}/${results.length} checks`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
