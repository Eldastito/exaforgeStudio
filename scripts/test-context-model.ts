/**
 * TEST — PRD 3 F1 (§8/§10-12/§24/§26-28/§30-31/§72): Core Context Model. Os
 * contratos estáveis do Business Context Engine (o que o PRD 4 consome) —
 * puros/determinísticos, sem DB nem LLM. Cobre validação, bandas, frescor,
 * precedência de fonte, conflito, e a TRADUÇÃO sinal→ContextFact (equivalência).
 *
 * Uso: npm run test:context-model
 */
import {
  CONTEXT_SCOPE_LEVELS, makeScope, scopeRef, isScopeLevel,
  SOURCE_PRIORITY, higherPrioritySource,
  factTypeFromBasis, confidenceBand, clampConfidence,
  freshnessOf, FRESHNESS_POLICY_MS,
  detectConflict, resolveConflictByPriority,
  factFromSignal, evidenceFromSignal, freshnessFromSignal,
  ContextConflictValue,
} from "../src/server/contextModel.js";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  // ===== 1. Scope (§8) =====
  check("1.1 23 níveis de escopo definidos", CONTEXT_SCOPE_LEVELS.length === 23 && isScopeLevel("TIME_WINDOW") && !isScopeLevel("BOGUS"));
  const scope = makeScope("org1", [{ level: "ORGANIZATION", ref: "org1" }, { level: "BUSINESS_UNIT", ref: "store-9" }, { level: "BOGUS" as any, ref: "x" }]);
  check("1.2 makeScope filtra níveis inválidos", scope.dimensions.length === 2 && scope.tenantId === "org1");
  check("1.3 scopeRef acha e devolve null quando ausente", scopeRef(scope, "BUSINESS_UNIT") === "store-9" && scopeRef(scope, "CUSTOMER") === null);

  // ===== 2. Source priority (§30/§72) =====
  check("2.1 system_of_record > user_declaration > inferred", SOURCE_PRIORITY.SYSTEM_OF_RECORD < SOURCE_PRIORITY.USER_DECLARATION && SOURCE_PRIORITY.USER_DECLARATION < SOURCE_PRIORITY.INFERRED);
  check("2.2 higherPrioritySource escolhe a de maior precedência", higherPrioritySource({ type: "USER_DECLARATION" }, { type: "SYSTEM_OF_RECORD" }).type === "SYSTEM_OF_RECORD");

  // ===== 3. Fact type (§26) — dado × interpretação =====
  check("3.1 fact→OBSERVED, estimate→CALCULATED, hypothesis→INFERRED", factTypeFromBasis("fact") === "OBSERVED" && factTypeFromBasis("estimate") === "CALCULATED" && factTypeFromBasis("hypothesis") === "INFERRED");
  check("3.2 basis desconhecido → INFERRED (não presume medição)", factTypeFromBasis("wat") === "INFERRED" && factTypeFromBasis(null) === "INFERRED");

  // ===== 4. Confidence bands (§27) =====
  check("4.1 bandas nos limites", confidenceBand(0.95) === "very_high" && confidenceBand(0.80) === "high" && confidenceBand(0.60) === "medium" && confidenceBand(0.40) === "low" && confidenceBand(0.10) === "unreliable");
  check("4.2 clampConfidence 0..1", clampConfidence(1.5) === 1 && clampConfidence(-1) === 0 && clampConfidence(0.7) === 0.7);

  // ===== 5. Freshness (§28/§29) =====
  const now = 1_000_000_000_000;
  const past = new Date(now - 3600_000).toISOString();
  const future = new Date(now + 3600_000).toISOString();
  check("5.1 validUntil no passado → stale", freshnessOf({ validUntil: past }, now).status === "stale");
  check("5.2 validUntil no futuro → fresh", freshnessOf({ validUntil: future }, now).status === "fresh");
  check("5.3 sem observedAt nem validUntil → unknown (não presume atual §25)", freshnessOf({}, now).status === "unknown");
  check("5.4 observedAt sem TTL → fresh + ageMs calculado", (() => { const f = freshnessOf({ observedAt: past }, now); return f.status === "fresh" && f.ageMs === 3600_000; })());
  check("5.5 política de frescor documentada (bank<inventory<address)", FRESHNESS_POLICY_MS.bank_balance < FRESHNESS_POLICY_MS.inventory && FRESHNESS_POLICY_MS.inventory < FRESHNESS_POLICY_MS.company_address);

  // ===== 6. Conflito (§31) — nunca resolve em silêncio =====
  const cands: ContextConflictValue[] = [
    { source: { type: "TRUSTED_INTEGRATION", service: "ERP" }, value: "active" },
    { source: { type: "INTERNAL_DB", service: "CRM" }, value: "inactive" },
  ];
  check("6.1 valores divergentes → conflito explicitado", (() => { const c = detectConflict("customer_status", cands); return !!c && c.values.length === 2 && c.resolution == null; })());
  check("6.2 valores iguais → sem conflito (null)", detectConflict("x", [{ source: { type: "ERP" as any }, value: 1 }, { source: { type: "CRM" as any }, value: 1 }]) === null);
  check("6.3 <2 candidatos → null", detectConflict("x", [{ source: { type: "INTERNAL_DB" }, value: 1 }]) === null);
  const resolved = resolveConflictByPriority(detectConflict("customer_status", cands)!);
  check("6.4 resolução por precedência escolhe ERP (trusted>internal), preserva values", resolved.resolution === "auto" && resolved.resolvedValue === "active" && resolved.resolvedBy?.service === "ERP" && resolved.values.length === 2);

  // ===== 7. Tradução sinal → ContextFact (§11) — equivalência, não duplicação =====
  const sig = {
    id: "sig1", domain: "finance", signal_type: "receivable_overdue", basis: "fact", confidence: 0.9,
    subject_type: "customer", subject_id: "123", source_service: "FinanceSignalPublisher", source_entity_id: "inv-77",
    impact_amount: 4500, impact_unit: "BRL", occurred_at: past, expires_at: future,
  };
  const fact = factFromSignal(sig, now);
  check("7.1 subject=subjectType:subjectId, predicate=signal_type", fact.subject === "customer:123" && fact.predicate === "receivable_overdue");
  check("7.2 object carrega impacto; factType do basis (fact→OBSERVED)", (fact.object as any).amount === 4500 && (fact.object as any).unit === "BRL" && fact.factType === "OBSERVED");
  check("7.3 confidence clampado; source interno com service/reference", fact.confidence === 0.9 && fact.source.type === "INTERNAL_DB" && fact.source.service === "FinanceSignalPublisher" && fact.source.reference === "inv-77");
  check("7.4 evidence-reference sustenta o fato (field=signal_type, observedAt)", fact.evidence.length === 1 && fact.evidence[0].field === "receivable_overdue" && fact.evidence[0].observedAt === past);
  check("7.5 frescor derivado do expires_at (futuro → fresh)", freshnessFromSignal(sig, now).status === "fresh");

  // ===== 8. Não inventa (§25) + aceita camelCase =====
  const bare = { domain: "sales", signalType: "stalled_opportunities", confidence: 0.6 };
  const f2 = factFromSignal(bare, now);
  check("8.1 sem subject → subject=domain:signalType; sem impacto/evidence → object null", f2.subject === "sales:stalled_opportunities" && f2.object === null);
  check("8.2 sem basis → INFERRED (não vira fato); sem datas → observedAt null", f2.factType === "INFERRED" && f2.observedAt === null && freshnessOf({}, now).status === "unknown");
  check("8.3 evidenceFromSignal camelCase ok", evidenceFromSignal(bare).field === "stalled_opportunities");

  console.log("\n=== TEST: Core Context Model F1 (PRD 3) ===\n");
  for (const rr of results) console.log(`${rr.ok ? "✅" : "❌"} ${rr.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Core Context Model F1 OK.");
}

main().catch((e) => { console.error(e); process.exit(1); });
