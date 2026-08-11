/**
 * TEST — PRD 3 F8 (§75/§34/§31/§24): Context Quality — a qualidade do contexto
 * como leitura RICA de 1ª classe. DB-backed, isolado por tmpDir. Determinístico:
 *
 *   - assessFromFacts (extraído do resolver, F3): cobertura + confiança (banda) +
 *     frescor (fresh/stale/unknown, freshnessOf) + conflitos (§31) + lacunas;
 *   - o resolver DELEGA (packet.quality == assessFromFacts) — 0 regressão;
 *   - coverageByItem (§34): disponibilidade por-fonte (available true/false);
 *   - conflictsDetailed (§31): conflito entre fontes REPORTADO (não só contagem);
 *   - evidenceSummary (§24): proveniência agregada por tipo, FUNDINDO RAG (F7);
 *   - assess(): relatório rico via a fachada (Engine.quality) — resolve o pacote;
 *   - ISOLAMENTO multi-tenant.
 *
 * Uso: npm run test:context-quality
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-ctx-quality-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-ctx-quality-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }
const uid = (p: string) => `${p}_${randomUUID().slice(0, 8)}`;

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { ContextQualityService: CQ } = await import("../src/server/ContextQualityService.js");
  const { ContextResolverService: R } = await import("../src/server/ContextResolverService.js");
  const { ContextEngineService: ENG } = await import("../src/server/ContextEngineService.js");

  const mkOrg = (name: string) => {
    const id = uid("org");
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, ?, 'active')`).run(randomUUID(), id, name);
    return id;
  };
  const orgA = mkOrg("Empresa A");
  const orgB = mkOrg("Empresa B");

  // Fatos sintéticos (contrato ContextFact) pra exercitar a matemática pura.
  const src = (svc: string) => ({ type: "INTERNAL_DB" as const, service: svc, reference: null });
  const mkFact = (subject: string, predicate: string, object: any, confidence: number, extra: any = {}) => ({
    subject, predicate, object, evidence: extra.evidence || [{ sourceType: "INTERNAL_DB", service: "test" }],
    confidence, factType: "OBSERVED" as const, source: extra.source || src("test"),
    observedAt: "observedAt" in extra ? extra.observedAt : new Date().toISOString(), validUntil: extra.validUntil ?? null,
  });

  // ═══════════════ 1. assessFromFacts (§75) ═══════════════
  const facts = [
    mkFact("customer:1", "has_debt", { amount: 100 }, 0.9),
    mkFact("customer:2", "churn_risk", "high", 0.6),
  ];
  const q = CQ.assessFromFacts(orgA, facts);
  check("1.1 confiança = média dos fatos (0.75) banda high", Math.abs(q.confidence.score - 0.75) < 1e-9 && q.confidence.band === "high");
  check("1.2 frescor conta todos os fatos (observedAt agora → fresh)", q.freshness.fresh === 2 && (q.freshness.fresh + q.freshness.stale + q.freshness.unknown) === facts.length);
  check("1.3 cobertura numérica ou null (dataQuality)", q.coveragePct === null || typeof q.coveragePct === "number");
  check("1.4 lacunas listadas (dados ausentes numa org vazia)", Array.isArray(q.gaps) && q.gaps.length > 0);
  check("1.5 sem conflito entre subjects distintos", q.conflicts === 0);

  // frescor: validUntil no passado → stale; observedAt ausente → unknown.
  const freshMix = CQ.assessFromFacts(orgA, [
    mkFact("x:1", "p", "a", 0.5, { validUntil: "2000-01-01T00:00:00Z" }),
    mkFact("x:2", "p", "b", 0.5, { observedAt: null }),
  ]);
  check("1.6 frescor: stale (validUntil passado) + unknown (sem observedAt)", freshMix.freshness.stale === 1 && freshMix.freshness.unknown === 1);

  // ═══════════════ 2. conflitos (§31) — reportados, não ocultos ═══════════════
  const conflicting = [
    mkFact("customer:9", "balance", { amount: 100 }, 0.8, { source: src("erp") }),
    mkFact("customer:9", "balance", { amount: 250 }, 0.7, { source: src("planilha") }),
  ];
  const qConf = CQ.assessFromFacts(orgA, conflicting);
  check("2.1 conflito contado no resumo", qConf.conflicts === 1);
  const details = CQ.conflictsDetailed(conflicting);
  check("2.2 conflito DETALHADO (campo + valores em disputa)", details.length === 1 && details[0].values.length === 2 && details[0].field === "customer:9|balance");
  check("2.3 conflito não é resolvido em silêncio (resolution null)", details[0].resolution == null);

  // ═══════════════ 3. cobertura por-fonte (§34) ═══════════════
  const cov = CQ.coverageByItem(orgA);
  check("3.1 itens de cobertura com available bool", cov.items.length > 0 && cov.items.every((i: any) => typeof i.available === "boolean"));
  check("3.2 org vazia → fontes indisponíveis (available:false presente)", cov.items.some((i: any) => i.available === false));

  // ═══════════════ 4. proveniência agregada (§24) + fusão de RAG (F7) ═══════════════
  const evNoRag = CQ.evidenceSummary(facts);
  check("4.1 conta evidência dos fatos por tipo (INTERNAL_DB)", evNoRag.total === 2 && evNoRag.bySourceType.INTERNAL_DB === 2);
  const ragHits = [{ documentId: "doc-1", chunkIndex: 0, title: "Política", text: "x", score: 0.9, observedAt: "2026-08-01T00:00:00Z" }];
  const evRag = CQ.evidenceSummary(facts, ragHits);
  check("4.2 funde RAG como APPROVED_DOCUMENT (F7)", evRag.total === 3 && evRag.bySourceType.APPROVED_DOCUMENT === 1 && evRag.bySourceType.INTERNAL_DB === 2);

  // ═══════════════ 5. resolver DELEGA (0 regressão) ═══════════════
  // publica um sinal e confere que packet.quality == assessFromFacts(packet.facts).
  const { BusinessSignalService: SIG } = await import("../src/server/BusinessSignalService.js");
  SIG.publish(orgA, { domain: "finance", signalType: "receivable_overdue", severity: "risk", basis: "fact", confidence: 0.9, subjectType: "customer", subjectId: "c1", sourceService: "t", evidence: {}, dedupeKey: "d1" });
  const pkt = R.resolve(orgA, { intent: "q" });
  const direct = CQ.assessFromFacts(orgA, pkt.facts);
  check("5.1 packet.quality == assessFromFacts (delegação)", JSON.stringify(pkt.quality) === JSON.stringify(direct));

  // ═══════════════ 6. assess() relatório rico via fachada ═══════════════
  const report = await ENG.quality(orgA, { intent: "q" }, { ragHits });
  check("6.1 relatório traz quality + coverage + conflicts + evidence", !!report.quality && Array.isArray(report.coverage.items) && Array.isArray(report.conflicts) && typeof report.evidence.total === "number");
  check("6.2 tenant + schemaVersion", report.tenantId === orgA && report.schemaVersion === 1);
  check("6.3 RAG fundido na proveniência do relatório", (report.evidence.bySourceType.APPROVED_DOCUMENT || 0) >= 1);

  // ═══════════════ 7. ISOLAMENTO multi-tenant ═══════════════
  const reportB = await ENG.quality(orgB, { intent: "q" });
  check("7.1 relatório de B é do tenant B", reportB.tenantId === orgB);
  check("7.2 B não vê o sinal de A (0 evidência de fato)", reportB.evidence.total === 0);

  console.log("\n=== TEST: Context Quality (PRD 3 F8) ===\n");
  for (const rr of results) console.log(`${rr.ok ? "✅" : "❌"} ${rr.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Context Quality (F8) OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
