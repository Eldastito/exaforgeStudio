/**
 * TEST — ContextualFusionService (PRD 9 / ADR-166 F12). DB-backed, determinístico.
 *
 * Prova (§9, CA34/CA35, RN-EL-6/RN-EI-1):
 *   - funde interno + histórico (assured) + externo por tópico;
 *   - força CATEGÓRICA: assured + externo VIVO → strong; uma prova forte → moderate;
 *     só síntese/interno → weak;
 *   - NUNCA soma bases: assuredEffectiveness e confidence do externo ficam SEPARADOS;
 *   - procedência listada (assured_history / external_live / external_model / internal);
 *   - caveats honestos (external_is_model_synthesis, no_assured_learning);
 *   - isolamento multi-tenant.
 *
 * Uso: npm run test:contextual-fusion
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-fus-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-fus-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const dbMod = await import("../src/server/db.js");
  const db = dbMod.default as any;
  const { PatternMemoryService: PM } = await import("../src/server/PatternMemoryService.js");
  const { VerticalIntelligenceService: VI } = await import("../src/server/VerticalIntelligenceService.js");
  const { ResearchBrokerService: BR } = await import("../src/server/ResearchBrokerService.js");
  const { ContextualFusionService: F } = await import("../src/server/ContextualFusionService.js");

  const mkOrg = (vertical: string) => { const id = `org_${randomUUID().slice(0, 8)}`; db.prepare("INSERT INTO organization_settings (id, organization_id, business_name, vertical, external_intelligence_enabled, status) VALUES (?,?,?,?,1,'active')").run(randomUUID(), id, "X", vertical); return id; };
  const assuredPattern = (org: string, id: string, domain: string) => {
    db.prepare("INSERT INTO business_patterns (id, organization_id, domain, pattern_type, pattern_key, description, confidence, status, occurrences) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(id, org, domain, `${domain}_type`, id + "-k", "p", 0.6, "validated", 3);
    PM.recordOutcome(org, id, { outcome: "worked", eventKey: id + "-w1", source: "assured" });
    PM.recordOutcome(org, id, { outcome: "worked", eventKey: id + "-w2", source: "assured" });
  };
  const extIntel = (org: string, topic: string, mode: string) => {
    VI.publish({ userId: "admin", organizationId: null }, { vertical: "padaria", topic, content: { summary: `mercado de ${topic}`, drivers: ["x"], evidenceMode: mode, sourceEvidence: mode === "live" ? [{ url: "https://a.com/1", tier: "B", retrievedAt: "2026-08-12T00:00:00Z" }] : [] }, sources: [], confidence: 0.7, provider: mode === "live" ? "live" : "stub" });
    BR.resolve(org, { vertical: "padaria", topic }); // cria a contextualização por-org (L3→L2)
  };

  const ORG = mkOrg("padaria");
  // procurement: assured + externo VIVO → strong
  assuredPattern(ORG, "p-proc", "procurement");
  extIntel(ORG, "insumos e fornecedores", "live");
  // sales: assured, SEM externo → moderate
  assuredPattern(ORG, "p-sales", "sales");
  // marketing: assured + externo model_knowledge → moderate + caveat
  assuredPattern(ORG, "p-mkt", "marketing");
  extIntel(ORG, "aquisição e mídia", "model_knowledge");

  const fused = F.fuse(ORG);
  const byDomain = (d: string) => fused.topics.find((t: any) => t.domain === d);

  // ═══════════════ 1. procurement: strong (assured + live) ═══════════════
  const proc = byDomain("procurement");
  check("1.1 procurement presente com tópico canônico", !!proc && proc.topic === "insumos e fornecedores");
  check("1.2 historical assured + external live", proc.historical?.hasAssured === true && proc.external?.evidenceMode === "live");
  check("1.3 força strong", proc.strength === "strong");
  check("1.4 procedência lista assured_history + external_live", proc.provenance.includes("assured_history") && proc.provenance.includes("external_live"));

  // ═══════════════ 2. NÃO soma bases (CA35) ═══════════════
  check("2.1 assuredEffectiveness e confidence do externo SEPARADOS", proc.historical.assuredEffectiveness === 1 && proc.external.confidence === 0.7);
  check("2.2 sem campo de score combinado", !("combinedScore" in proc) && !("fusedConfidence" in proc));

  // ═══════════════ 3. sales: só assured → moderate, sem externo ═══════════════
  const sales = byDomain("sales");
  check("3.1 sales moderate (uma prova forte)", sales.strength === "moderate" && sales.external === null);

  // ═══════════════ 4. marketing: assured + model_knowledge → moderate + caveat ═══════════════
  const mkt = byDomain("marketing");
  check("4.1 marketing external model_knowledge", mkt.external?.evidenceMode === "model_knowledge");
  check("4.2 moderate (model não é prova forte)", mkt.strength === "moderate");
  check("4.3 caveat external_is_model_synthesis", mkt.caveats.includes("external_is_model_synthesis"));
  check("4.4 procedência usa external_model (não external_live)", mkt.provenance.includes("external_model") && !mkt.provenance.includes("external_live"));

  // ═══════════════ 5. ordenação (mais facetas/força primeiro) ═══════════════
  check("5.1 procurement (strong, 2+ facetas) vem antes de sales", fused.topics.findIndex((t: any) => t.domain === "procurement") < fused.topics.findIndex((t: any) => t.domain === "sales"));

  // ═══════════════ 6. isolamento multi-tenant ═══════════════
  const OTHER = mkOrg("padaria");
  assuredPattern(OTHER, "p-o", "finance");
  const fusedOther = F.fuse(OTHER);
  // A chave de domínio pode existir (categoria do snapshot é genérica); o que NÃO pode
  // vazar são os DADOS do ORG. OTHER: finance tem assured; procurement (se listado pelo
  // snapshot) NÃO carrega histórico/externo do ORG.
  const otherProc = fusedOther.topics.find((t: any) => t.domain === "procurement");
  check("6.1 OTHER finance tem assured próprio", fusedOther.topics.some((t: any) => t.domain === "finance" && t.historical?.hasAssured === true));
  check("6.2 dados do ORG não vazam pro OTHER (procurement sem assured/externo)", !otherProc || (otherProc.historical === null && otherProc.external === null));

  // ── relatório ──
  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} contextual-fusion: ${passed}/${results.length} checks`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
