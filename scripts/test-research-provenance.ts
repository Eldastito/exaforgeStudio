/**
 * TEST — procedência da pesquisa externa (PRD 9 / ADR-166 F7). DB-backed + unidade pura.
 *
 * Prova (§53/§54, RN-EI-1/6):
 *   - ResearchResult carrega evidenceMode + sourceEvidence;
 *   - Stub e LLM são model_knowledge (síntese/paramétrico, NÃO fonte viva);
 *   - fontes que o modelo cita viram sourceEvidence tier 'C' (alegadas), sem retrievedAt;
 *   - URL vs texto simples são distinguidos;
 *   - runResearch PERSISTE a procedência no conteúdo (observável em getFresh);
 *   - pacote vazio do modelo → null (inalterado).
 *
 * Uso: npm run test:research-provenance
 */
import os from "os"; import path from "path"; import fs from "fs";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-rpv-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-rpv-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  await import("../src/server/db.js");
  const { StubResearchProvider, parseLlmResearch, getResearchProvider } = await import("../src/server/ExternalResearchProvider.js");
  const { VerticalIntelligenceService: VI } = await import("../src/server/VerticalIntelligenceService.js");

  const q = { vertical: "padaria", topic: "insumos", query: "padaria insumos" };

  // ═══════════════ 1. Stub → model_knowledge, sem fonte viva ═══════════════
  const s = new StubResearchProvider().research(q);
  check("1.1 stub evidenceMode model_knowledge", s.evidenceMode === "model_knowledge");
  check("1.2 stub sourceEvidence vazio + retrievedAt null", Array.isArray(s.sourceEvidence) && s.sourceEvidence.length === 0 && s.retrievedAt === null);

  // ═══════════════ 2. parseLlmResearch → model_knowledge + fontes tier C ═══════════════
  const raw = JSON.stringify({ summary: "Panorama do nicho de padaria.", drivers: ["custo de farinha", "sazonalidade"], sources: ["https://abip.org.br/relatorio", "Associação do setor"], confidence: 0.7 });
  const r = parseLlmResearch(raw, q)!;
  check("2.1 llm evidenceMode model_knowledge (paramétrico, não live)", r.evidenceMode === "model_knowledge");
  check("2.2 duas fontes viram sourceEvidence", r.sourceEvidence.length === 2);
  const urlEv = r.sourceEvidence.find((e: any) => e.url);
  const textEv = r.sourceEvidence.find((e: any) => e.title);
  check("2.3 URL → url setado, tier C, sem retrievedAt", !!urlEv && urlEv.url === "https://abip.org.br/relatorio" && urlEv.tier === "C" && urlEv.retrievedAt === null);
  check("2.4 texto simples → title, tier C", !!textEv && textEv.title === "Associação do setor" && textEv.tier === "C");
  check("2.5 todas as fontes do modelo são tier C (alegadas)", r.sourceEvidence.every((e: any) => e.tier === "C"));

  // ═══════════════ 3. pacote vazio → null (inalterado) ═══════════════
  check("3.1 summary+drivers vazios → null", parseLlmResearch(JSON.stringify({ summary: "", drivers: [] }), q) === null);

  // ═══════════════ 4. default do registry emite procedência ═══════════════
  const def = getResearchProvider() as any; // stub por default
  const dr = await def.research(q);
  check("4.1 provider default carrega evidenceMode", dr.evidenceMode === "model_knowledge" && Array.isArray(dr.sourceEvidence));

  // ═══════════════ 5. runResearch PERSISTE a procedência (observável) ═══════════════
  const actor = { userId: "admin", organizationId: null };
  await VI.runResearch(actor, { vertical: "padaria", topic: "insumos" }); // usa stub (sem chave IA)
  const fresh = VI.getFresh("padaria", "insumos");
  check("5.1 getFresh traz o conteúdo persistido", !!fresh && !!fresh.content);
  check("5.2 evidenceMode persistido no conteúdo", fresh.content.evidenceMode === "model_knowledge");
  check("5.3 sourceEvidence presente (vazio p/ stub)", Array.isArray(fresh.content.sourceEvidence));

  // ── relatório ──
  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} research-provenance: ${passed}/${results.length} checks`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
