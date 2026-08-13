/**
 * TEST — Competitive Intelligence Adapter (PRD 10 / ADR-167 F5). DB-backed, determinístico.
 * Prova (D5/§42, RN-EI-1/2/5/6, RN-SI-11):
 *   - provider `competitive` registrado no MESMO registry do PRD 9 (sem pipeline paralelo);
 *   - SEM fonte pública configurada → model_knowledge honesto (nunca fabrica live);
 *   - parse() live exige GROUNDING (≥1 fonte) → tier B + retrievedAt; sem fonte → null;
 *     JSON inválido → null;
 *   - gather() flui pelo runResearch e grava no compartilhado `vertical_intelligence`
 *     com a procedência (evidenceMode) embutida, anonimizado/curado (reúso PRD 9);
 *   - query derivada só da taxonomia (sem dado de tenant).
 *
 * Uso: npm run test:competitive-intelligence
 */
import os from "os"; import path from "path"; import fs from "fs";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-compintel-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-compintel-123";
delete process.env.COMPETITIVE_INTEL_SOURCE_URL;  // garante o caminho honesto (sem fonte)

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { getResearchProvider } = await import("../src/server/ExternalResearchProvider.js");
  const { CompetitiveIntelligenceProvider } = await import("../src/server/CompetitiveIntelligenceProvider.js");
  const { CompetitiveIntelligenceService: CI } = await import("../src/server/CompetitiveIntelligenceService.js");
  const { VerticalIntelligenceService: VI } = await import("../src/server/VerticalIntelligenceService.js");

  // ═══════════════ 1. registrado no MESMO registry (D5/§42) ═══════════════
  const prov = getResearchProvider("competitive");
  check("1.1 registry resolve 'competitive' (sem pipeline paralelo)", prov.name === "competitive");
  check("1.2 isConfigured false sem fonte pública", CompetitiveIntelligenceProvider.isConfigured() === false);

  // ═══════════════ 2. sem fonte → model_knowledge honesto (RN-EI-6/RN-SI-11) ═══════════════
  const q = { vertical: "moda", topic: "concorrência", region: "SP", timeframe: "30d", query: "moda concorrência SP 30d" };
  const r = await prov.research(q);
  check("2.1 evidenceMode = model_knowledge (não inventa live)", r.evidenceMode === "model_knowledge");
  check("2.2 sourceEvidence vazio (não fabrica fonte)", Array.isArray(r.sourceEvidence) && r.sourceEvidence.length === 0);
  check("2.3 conteúdo rotula síntese do modelo", typeof r.content?.note === "string" && /model|síntese/i.test(r.content.note));
  check("2.4 query derivada só da taxonomia (sem tenant)", r.content?.scope === "moda · concorrência · SP · 30d");

  // ═══════════════ 3. parse() live exige GROUNDING (RN-EI-5) ═══════════════
  const p = new CompetitiveIntelligenceProvider();
  const grounded = p.parse(JSON.stringify({
    summary: "3 concorrentes ativos no período",
    competitors: [{ handle: "@rival.a" }, { handle: "@rival.b" }],
    sources: [{ url: "https://portal.publico/ranking", title: "Ranking público", publisher: "Portal" }],
    confidence: 0.7,
  }), q, "2026-08-13T12:00:00Z");
  check("3.1 com fonte → live tier B", grounded?.evidenceMode === "live" && grounded?.sourceEvidence[0]?.tier === "B");
  check("3.2 retrievedAt carimbado (recuperação real)", grounded?.sourceEvidence[0]?.retrievedAt === "2026-08-13T12:00:00Z" && grounded?.retrievedAt === "2026-08-13T12:00:00Z");
  check("3.3 competidores no conteúdo", Array.isArray(grounded?.content?.competitors) && grounded?.content.competitors.length === 2);
  const ungrounded = p.parse(JSON.stringify({ summary: "sem fonte", competitors: [{ handle: "@x" }], sources: [] }), q, "2026-08-13T12:00:00Z");
  check("3.4 SEM fonte → null (grounding, live não é live sem fonte)", ungrounded === null);
  const badJson = p.parse("{ nao é json", q, "2026-08-13T12:00:00Z");
  check("3.5 JSON inválido → null (degrada)", badJson === null);

  // ═══════════════ 4. gather() flui pelo pipeline PRD 9 e grava no compartilhado ═══════════════
  const actor = { userId: "master-1", organizationId: null };
  const out = await CI.gather(actor, { vertical: "restaurante", topic: "concorrência", region: "RJ" });
  check("4.1 gather retornou o registro persistido", !!out && !!out.fingerprint);
  const row = db.prepare(`SELECT content_json, provider FROM vertical_intelligence WHERE vertical = ? AND topic = ?`).get("restaurante", "concorrência") as any;
  check("4.2 gravou no compartilhado vertical_intelligence", !!row && row.provider === "competitive");
  const content = JSON.parse(row.content_json || "{}");
  check("4.3 procedência embutida (evidenceMode model_knowledge)", content.evidenceMode === "model_knowledge");
  check("4.4 compartilhado SEM organization_id (camada compartilhada, ADR-156)", (db.prepare(`SELECT COUNT(*) n FROM pragma_table_info('vertical_intelligence') WHERE name='organization_id'`).get() as any).n === 0);

  // ═══════════════ 5. topic default = concorrência ═══════════════
  const out2 = await CI.gather(actor, { vertical: "clinica" });
  const row2 = db.prepare(`SELECT topic FROM vertical_intelligence WHERE vertical = ?`).get("clinica") as any;
  check("5.1 topic default 'concorrência'", row2?.topic === "concorrência" && !!out2);

  // ── relatório ──
  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} competitive-intelligence: ${passed}/${results.length} checks`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
