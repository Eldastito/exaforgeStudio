/**
 * TEST — Studio Intelligence Handoff (PRD 10 / ADR-167 F8). DB-backed, determinístico.
 * Prova (§42, RN-SI-02/03): a oportunidade (F7) abre o Estúdio já ORIENTADO.
 *   - listOpportunities lista as oportunidades de conteúdo abertas;
 *   - fromOpportunity deriva briefing (nicho/tópico/ângulo/formato/procedência + texto
 *     pronto p/ StudioService.generate), SEM LLM, SEM tabela nova, GROUNDED na evidência;
 *   - carrega correlationId (fio ADR-158); procedência (evidenceMode) + basis hipótese;
 *   - marca opcional entra no tom; sem marca ainda funciona;
 *   - oportunidade expirada sai da lista; not-found → null; isolamento multi-tenant.
 *
 * Uso: npm run test:studio-brief
 */
import os from "os"; import path from "path"; import fs from "fs";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-studio-brief-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-studio-brief-1";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { StudioBriefService: SB } = await import("../src/server/StudioBriefService.js");
  const { StudioService } = await import("../src/server/StudioService.js");
  const { OpportunityMatchingService: OM } = await import("../src/server/OpportunityMatchingService.js");
  const { VerticalIntelligenceService: VI } = await import("../src/server/VerticalIntelligenceService.js");
  const { SocialAnalyticsService: AN } = await import("../src/server/SocialAnalyticsService.js");

  const A = "org_sb_A", B = "org_sb_B";
  const master = { userId: "master-1", organizationId: null };
  const setup = (org: string) => {
    db.prepare(`INSERT OR IGNORE INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Loja X', 'active')`).run(`os-${org}`, org);
    db.prepare(`UPDATE organization_settings SET vertical='moda', external_intelligence_enabled=1 WHERE organization_id = ?`).run(org);
  };
  setup(A); setup(B);
  await VI.runResearch(master, { vertical: "moda", topic: "concorrência", ttlDays: 7 }, { providerName: "stub" });
  await VI.runResearch(master, { vertical: "moda", topic: "tendências", ttlDays: 7 }, { providerName: "stub" });
  await AN.sync(A, "stub");
  OM.match(A, { channel: "stub", publish: true });   // publica 2 oportunidades

  // ═══════════════ 1. lista de oportunidades ═══════════════
  const opps = SB.listOpportunities(A);
  check("1.1 lista 2 oportunidades abertas", opps.length === 2);
  check("1.2 traz tópico/vertical/procedência", opps.every((o: any) => o.vertical === "moda" && !!o.topic && !!o.evidenceMode));
  const target = opps.find((o: any) => o.topic === "concorrência")!;
  check("1.3 correlationId presente (fio ADR-158)", !!target.correlationId);

  // ═══════════════ 2. briefing orientado (sem marca) ═══════════════
  const brief = SB.fromOpportunity(A, target.signalId);
  check("2.1 brief montado", !!brief);
  check("2.2 nicho + tópico + canal", brief?.vertical === "moda" && brief?.topic === "concorrência" && brief?.channel === "stub");
  check("2.3 ângulo e briefingText derivados (GROUNDED)", !!brief?.angle && !!brief?.briefingText && brief!.briefingText.includes("concorrência") && brief!.briefingText.includes("moda"));
  check("2.4 formato sugerido reflete desempenho próprio (story, ownPosts>0)", brief?.suggestedFormat === "story");
  check("2.5 procedência: evidenceMode + basis hipótese (PUBLISHED≠RESULTADO)", brief?.provenance?.evidenceMode === "model_knowledge" && brief?.provenance?.basis === "hypothesis");
  check("2.6 correlationId propagado", brief?.correlationId === target.correlationId);
  check("2.7 sem marca → brand null, ainda funciona", brief?.brand === null);
  check("2.8 texto declara a procedência (síntese do modelo)", brief!.briefingText.includes("síntese de mercado do modelo"));

  // ═══════════════ 3. marca entra no tom ═══════════════
  StudioService.saveBrand(A, { palette: ["#000"], tone: "elegante", style: "minimalista", summary: "marca premium" });
  const brief2 = SB.fromOpportunity(A, target.signalId);
  check("3.1 brand presente após saveBrand", brief2?.brand?.tone === "elegante");
  check("3.2 briefingText incorpora o tom da marca", brief2!.briefingText.includes("elegante"));

  // ═══════════════ 4. expirada sai da lista ═══════════════
  db.prepare(`UPDATE business_signals SET expires_at = datetime('now','-1 day') WHERE organization_id = ? AND evidence_json LIKE '%tendências%'`).run(A);
  const oppsAfter = SB.listOpportunities(A);
  check("4.1 oportunidade expirada some da lista", oppsAfter.length === 1);

  // ═══════════════ 5. not-found + isolamento ═══════════════
  check("5.1 signalId inexistente → null", SB.fromOpportunity(A, "nope") === null);
  check("5.2 org B não lê o sinal de A (isolamento)", SB.fromOpportunity(B, target.signalId) === null);
  check("5.3 B sem oportunidades próprias", SB.listOpportunities(B).length === 0);

  // ── relatório ──
  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} studio-brief: ${passed}/${results.length} checks`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
