/**
 * TEST — gates de curadoria 2.0 (PRD 9 / ADR-166 F9). Unidade pura sobre assessQuality.
 *
 * Prova (§53/§54, RN-EI-5):
 *   - GROUNDING: live sem sourceEvidence → BLOQUEIA (ungrounded_live);
 *   - live COM fonte → passa; model_knowledge não exige fonte (0-regressão);
 *   - vazio / confiança baixa seguem bloqueando;
 *   - avisos NÃO bloqueiam: model_knowledge_only, low_source_diversity, stale_sources,
 *     high_churn_vs_prior (contradição vs base anterior);
 *   - diversidade real (hosts distintos) não gera aviso.
 *
 * Uso: npm run test:research-curation-gates
 */
import os from "os"; import path from "path"; import fs from "fs";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-cur2-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-cur2-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { ResearchCuratorService: C } = await import("../src/server/ResearchCuratorService.js");
  const mk = (over: any = {}) => ({ content: { summary: "Panorama do nicho", drivers: ["a", "b"], ...(over.content || {}) }, confidence: over.confidence ?? 0.6, evidenceMode: over.evidenceMode ?? "model_knowledge", sourceEvidence: over.sourceEvidence ?? [] });

  // ═══════════════ 1. bloqueios ═══════════════
  check("1.1 vazio → bloqueia empty", C.assessQuality({ content: {}, confidence: 0.9 }).reasons.includes("empty"));
  check("1.2 confiança baixa → bloqueia", C.assessQuality(mk({ confidence: 0.05 })).reasons.includes("low_confidence"));

  // ═══════════════ 2. GROUNDING (RN-EI-5) ═══════════════
  const liveNoSrc = C.assessQuality(mk({ evidenceMode: "live", sourceEvidence: [] }));
  check("2.1 live sem fonte → ungrounded_live + ok false", liveNoSrc.reasons.includes("ungrounded_live") && liveNoSrc.ok === false);
  const liveSrc = C.assessQuality(mk({ evidenceMode: "live", sourceEvidence: [{ url: "https://a.com/1", freshness: "2026-07" }, { url: "https://b.com/2", freshness: "2026-08" }] }));
  check("2.2 live com fontes diversas+frescas → ok, sem avisos de fonte", liveSrc.ok === true && !liveSrc.warnings.includes("ungrounded_live") && !liveSrc.warnings.includes("low_source_diversity") && !liveSrc.warnings.includes("stale_sources"));
  check("2.3 model_knowledge NÃO exige fonte (0-regressão)", C.assessQuality(mk({ evidenceMode: "model_knowledge", sourceEvidence: [] })).ok === true);

  // ═══════════════ 3. avisos não bloqueiam ═══════════════
  check("3.1 model_knowledge → warning model_knowledge_only, ok true", (() => { const q = C.assessQuality(mk({})); return q.ok === true && q.warnings.includes("model_knowledge_only"); })());
  const sameHost = C.assessQuality(mk({ evidenceMode: "live", sourceEvidence: [{ url: "https://x.com/1", freshness: "2026-07" }, { url: "https://www.x.com/2", freshness: "2026-07" }] }));
  check("3.2 mesmas origens → low_source_diversity (aviso), mas ok true", sameHost.warnings.includes("low_source_diversity") && sameHost.ok === true);
  const stale = C.assessQuality(mk({ evidenceMode: "live", sourceEvidence: [{ url: "https://a.com/1" }, { url: "https://b.com/2" }] }));
  check("3.3 fontes sem frescor → stale_sources (aviso)", stale.warnings.includes("stale_sources") && stale.ok === true);

  // ═══════════════ 4. contradição vs base anterior ═══════════════
  const prev = { drivers: ["farinha", "energia", "aluguel", "mão de obra"] };
  const churn = C.assessQuality(mk({ content: { summary: "novo", drivers: ["logística", "câmbio"] } }), undefined, { prev });
  check("4.1 maioria dos drivers antigos sumiu → high_churn_vs_prior (aviso)", churn.warnings.includes("high_churn_vs_prior") && churn.ok === true);
  const stable = C.assessQuality(mk({ content: { summary: "s", drivers: ["farinha", "energia", "aluguel"] } }), undefined, { prev });
  check("4.2 base estável → sem high_churn", !stable.warnings.includes("high_churn_vs_prior"));

  // ═══════════════ 5. metadados expostos ═══════════════
  const q5 = C.assessQuality(mk({ evidenceMode: "live", sourceEvidence: [{ url: "https://a.com/1", freshness: "2026-07" }] }));
  check("5.1 expõe evidenceMode + sourceCount", q5.evidenceMode === "live" && q5.sourceCount === 1);

  // ── relatório ──
  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} research-curation-gates: ${passed}/${results.length} checks`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
