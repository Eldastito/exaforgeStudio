/**
 * TEST — PRD 3 F11 (§55/§120): Observability do Context Engine. DB-backed, isolado
 * por tmpDir. Determinístico. Prova as métricas DERIVADAS (RN-004, 0 tabela nova):
 *
 *   forPacket (PURO): tamanho (facts/entities/…), truncated, cobertura/confiança,
 *     utilização do orçamento (0..1), proveniência por tipo + atalho de RAG (F8/F7).
 *   snapshot (org): resolve pacote representativo + momento do business_signals
 *     (por domínio/severidade) + token economy do ai_usage_log (janela sinceDays);
 *     fachada Engine.metrics delega.
 *   ISOLAMENTO multi-tenant: signals/ai_usage de A não vazam pra B.
 *
 * Uso: npm run test:context-metrics
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-ctx-metrics-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-ctx-metrics-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { ContextMetricsService: M } = await import("../src/server/ContextMetricsService.js");
  const { ContextEngineService: ENG } = await import("../src/server/ContextEngineService.js");
  const { BusinessSignalService: SIG } = await import("../src/server/BusinessSignalService.js");

  const mkOrg = () => {
    const id = `org_${randomUUID().slice(0, 8)}`;
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), id);
    return id;
  };
  const orgA = mkOrg();
  const orgB = mkOrg();

  // ═══════════════ 1. forPacket (PURO) ═══════════════
  const pkt: any = {
    tenantId: orgA, intent: "q", scope: {}, anchor: null,
    moment: { total: 7, bySeverity: {}, byDomain: {}, top: [{}, {}, {}] },
    facts: [
      { subject: "s1", predicate: "p", object: 1, evidence: [{ sourceType: "INTERNAL_DB", service: "t" }, { sourceType: "APPROVED_DOCUMENT", service: "geminiRAG" }], confidence: 0.8, factType: "OBSERVED", source: { type: "INTERNAL_DB", service: "t", reference: null }, observedAt: null, validUntil: null },
      { subject: "s2", predicate: "p", object: 2, evidence: [{ sourceType: "INTERNAL_DB", service: "t" }], confidence: 0.8, factType: "OBSERVED", source: { type: "INTERNAL_DB", service: "t", reference: null }, observedAt: null, validUntil: null },
    ],
    entities: [{}, {}, {}], relationships: [{}], goals: [{}], constraints: [{}, {}], skillHints: [{}],
    quality: { coveragePct: 60, confidence: { score: 0.8, band: "high" }, freshness: { fresh: 2, stale: 0, unknown: 0 }, conflicts: 1, gaps: ["x", "y"] },
    sources: ["a", "b"], truncated: true,
    budget: { maxFacts: 4, maxEntities: 6, maxSignals: 6, graphDepth: 2, maxGoals: 2 },
    generatedAt: "", schemaVersion: 1,
  };
  const m = M.forPacket(pkt);
  check("1.1 conta tamanhos do pacote", m.facts === 2 && m.entities === 3 && m.constraints === 2 && m.skillHints === 1 && m.sources === 2);
  check("1.2 momento + truncated + cobertura/confiança", m.momentTotal === 7 && m.truncated === true && m.coveragePct === 60 && m.confidenceScore === 0.8 && m.confidenceBand === "high");
  check("1.3 conflitos + lacunas", m.conflicts === 1 && m.gaps === 2);
  check("1.4 utilização do orçamento (0..1)", Math.abs(m.budgetUtilization.facts - 0.5) < 1e-9 && Math.abs(m.budgetUtilization.entities - 0.5) < 1e-9 && Math.abs(m.budgetUtilization.signals - 0.5) < 1e-9 && m.budgetUtilization.goals === 0.5);
  check("1.5 proveniência por tipo (reusa F8)", m.evidenceBySourceType.INTERNAL_DB === 2 && m.evidenceBySourceType.APPROVED_DOCUMENT === 1);
  check("1.6 atalho de RAG (APPROVED_DOCUMENT)", m.ragEvidence === 1);
  // utilização nunca passa de 1 mesmo estourando (defensivo).
  const over: any = { ...pkt, facts: [pkt.facts[0], pkt.facts[1], {}, {}, {}], budget: { ...pkt.budget, maxFacts: 2 } };
  check("1.7 utilização clampada em 1", M.forPacket(over).budgetUtilization.facts === 1);

  // ═══════════════ 2. snapshot (org) — momento do ledger + ai_usage ═══════════════
  SIG.publish(orgA, { domain: "sales", signalType: "s_a1", severity: "risk", basis: "fact", confidence: 0.9, subjectType: "customer", subjectId: "c1", sourceService: "t", evidence: {}, dedupeKey: "a1" });
  SIG.publish(orgA, { domain: "sales", signalType: "s_a2", severity: "info", basis: "fact", confidence: 0.9, subjectType: "customer", subjectId: "c2", sourceService: "t", evidence: {}, dedupeKey: "a2" });
  SIG.publish(orgA, { domain: "finance", signalType: "s_a3", severity: "risk", basis: "fact", confidence: 0.9, subjectType: "customer", subjectId: "c3", sourceService: "t", evidence: {}, dedupeKey: "a3" });
  // ai_usage_log — token economy (§55).
  db.prepare(`INSERT INTO ai_usage_log (id, organization_id, model, kind, input_tokens, output_tokens, total_tokens, cost_usd, cost_brl) VALUES (?, ?, 'm', 'embed', 100, 0, 100, 0.001, 0.005)`).run(randomUUID(), orgA);
  db.prepare(`INSERT INTO ai_usage_log (id, organization_id, model, kind, input_tokens, output_tokens, total_tokens, cost_usd, cost_brl) VALUES (?, ?, 'm', 'chat', 200, 50, 250, 0.01, 0.05)`).run(randomUUID(), orgA);

  const snap = M.snapshot(orgA);
  check("2.1 signals: open total do ledger", snap.signals.open === 3);
  check("2.2 signals por domínio", snap.signals.byDomain.sales === 2 && snap.signals.byDomain.finance === 1);
  check("2.3 signals por severidade", snap.signals.bySeverity.risk === 2 && snap.signals.bySeverity.info === 1);
  check("2.4 ai_usage: tokens + custo agregados", snap.aiUsage.totalTokens === 350 && Math.abs(snap.aiUsage.costBrl - 0.055) < 1e-9);
  check("2.5 ai_usage por kind", snap.aiUsage.byKind.embed.tokens === 100 && snap.aiUsage.byKind.chat.tokens === 250);
  check("2.6 snapshot inclui métricas do pacote resolvido", typeof snap.packet.facts === "number" && typeof snap.packet.truncated === "boolean");
  check("2.7 fachada Engine.metrics delega", ENG.metrics(orgA).signals.open === 3);

  // janela sinceDays limita a leitura de ai_usage.
  db.prepare(`INSERT INTO ai_usage_log (id, organization_id, model, kind, input_tokens, output_tokens, total_tokens, cost_usd, cost_brl, created_at) VALUES (?, ?, 'm', 'old', 0, 0, 999, 0, 9, '2000-01-01T00:00:00Z')`).run(randomUUID(), orgA);
  check("2.8 janela sinceDays exclui uso antigo", M.snapshot(orgA, { sinceDays: 30 }).aiUsage.totalTokens === 350);

  // ═══════════════ 3. ISOLAMENTO multi-tenant ═══════════════
  const snapB = M.snapshot(orgB);
  check("3.1 org B: 0 signals (isolado)", snapB.signals.open === 0);
  check("3.2 org B: 0 uso de IA (isolado)", snapB.aiUsage.totalTokens === 0);
  check("3.3 snapshot de B é do tenant B", snapB.orgId === orgB);

  console.log("\n=== TEST: Context Metrics (PRD 3 F11) ===\n");
  for (const rr of results) console.log(`${rr.ok ? "✅" : "❌"} ${rr.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Context Metrics (F11) OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
