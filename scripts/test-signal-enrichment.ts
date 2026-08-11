/**
 * TEST — PRD 3 F5 (§38/§39): Signal Context Enrichment. DB-backed, isolado por
 * tmpDir. Prova, determinístico, a ponte PERCEPÇÃO → CONTEXTO (o Maestro consome):
 *
 *   - enrich() lê um sinal do ledger e monta seu contexto: âncora no SUJEITO do
 *     sinal (quando resolve no grafo F2), pacote do resolver (F3) escopado ao
 *     domínio, lente de prioridade (scoreOne — score/impactLevel/ação recomendada),
 *     meta AMEAÇADA (affectedGoal), restrições aplicáveis (F4) e correlatos do
 *     mesmo sujeito;
 *   - o sinal vira ContextFact (subject=subjectType:subjectId, factType do basis);
 *   - âncora que NÃO tem casa no grafo (opportunity/ticket) → anchor:null, mas o
 *     fato do sinal segue presente e o pacote degrada pra org+domínio (não inventa);
 *   - sinal fechado → found:true mas priority:null (só sinal vivo tem lente);
 *   - ISOLAMENTO multi-tenant: enrich(orgA, sinalDoB) → found:false (não vaza);
 *   - not-found → found:false;
 *   - enrichRow() = enrich() (paridade).
 *
 * Uso: npm run test:signal-enrichment
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-signal-enrich-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-signal-enrich-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }
const uid = (p: string) => `${p}_${randomUUID().slice(0, 8)}`;

// asOf no meio do mês → a meta de receita (realizado 0 sem snapshot) fica "behind"
// e goalGapsByDomain devolve gap>0 → affectedGoal populado deterministicamente.
const ASOF = "2026-08-20";

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { SignalEnrichmentService: SE } = await import("../src/server/SignalEnrichmentService.js");
  const { BusinessSignalService: SIG } = await import("../src/server/BusinessSignalService.js");
  const { BusinessGoalService: GOALS } = await import("../src/server/BusinessGoalService.js");
  const { BusinessConstraintService: CONS } = await import("../src/server/BusinessConstraintService.js");

  const mkOrg = (name: string) => {
    const id = uid("org");
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, ?, 'active')`).run(randomUUID(), id, name);
    return id;
  };

  const orgA = mkOrg("Empresa A");
  const orgB = mkOrg("Empresa B");

  // cliente resolvível no grafo (contacts) — vira a âncora do sinal.
  const cust = uid("cust");
  db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, 'ch1', 'Cliente Alfa', 'alfa')`).run(cust, orgA);

  // meta de receita (ameaçada: realizado 0 sem snapshot, meio do mês → behind).
  db.prepare(`INSERT INTO business_goals (id, organization_id, metric, target_amount, status) VALUES (?, ?, 'revenue', 100000, 'active')`).run(uid("goal"), orgA);

  // restrições: uma global + uma escopada ao cliente-âncora.
  CONS.create(orgA, { kind: "discount_ceiling", name: "Desconto máximo", operator: "lte", valueNum: 15, valueUnit: "%", scopeType: null, scopeRef: null });
  CONS.create(orgA, { kind: "payment_term_max", name: "Prazo Alfa", operator: "lte", valueNum: 30, valueUnit: "dias", scopeType: "customer", scopeRef: cust });

  // sinal PRIMÁRIO — receivable_overdue sobre o cliente (subject=customer).
  const primary = SIG.publish(orgA, {
    domain: "finance", signalType: "receivable_overdue", severity: "risk", basis: "fact", confidence: 0.9,
    impactAmount: 4500, impactUnit: "BRL", subjectType: "customer", subjectId: cust,
    sourceService: "FinanceSignalPublisher", sourceEntityType: "invoice", sourceEntityId: "inv-1",
    evidence: { days: 30 }, dedupeKey: "fin:recv:alfa",
  });
  // segundo sinal do MESMO sujeito (pra correlatos).
  const sibling = SIG.publish(orgA, {
    domain: "sales", signalType: "stalled_opportunities", severity: "attention", basis: "estimate", confidence: 0.6,
    subjectType: "customer", subjectId: cust, sourceService: "SalesDetector", evidence: { count: 2 }, dedupeKey: "sales:stalled:alfa",
  });
  // sinal com sujeito SEM casa no grafo (opportunity) — não deve inventar âncora.
  const opp = SIG.publish(orgA, {
    domain: "sales", signalType: "deal_at_risk", severity: "attention", basis: "estimate", confidence: 0.5,
    subjectType: "opportunity", subjectId: "opp-1", sourceService: "SalesDetector", evidence: {}, dedupeKey: "sales:deal:opp1",
  });
  // sinal do tenant B (não pode vazar pra A).
  const bSig = SIG.publish(orgB, {
    domain: "finance", signalType: "cash_below_minimum", severity: "critical", basis: "fact", confidence: 0.8,
    sourceService: "FinanceSignalPublisher", evidence: {}, dedupeKey: "fin:cash:b",
  });

  // ═══════════════ 1. Enriquecimento base (âncora resolvida) ═══════════════
  const e = SE.enrich(orgA, primary.id, { asOf: ASOF });
  check("1.1 found + identidade do sinal", e.found === true && e.signalId === primary.id && e.domain === "finance" && e.signalType === "receivable_overdue");
  check("1.2 subject reportado", !!e.subject && e.subject.type === "customer" && e.subject.id === cust);
  check("1.3 âncora resolve no grafo (customer:cust)", e.anchor === `customer:${cust}`);
  check("1.4 sinal vira ContextFact (subject/predicate/factType)", !!e.fact && e.fact.subject === `customer:${cust}` && e.fact.predicate === "receivable_overdue" && e.fact.factType === "OBSERVED");
  check("1.5 frescor derivado", !!e.freshness && typeof e.freshness.status === "string");
  check("1.6 correlationId presente", !!e.correlationId);

  // ═══════════════ 2. Pacote de contexto ancorado (F3) ═══════════════
  check("2.1 context packet presente e ancorado", !!e.context && e.context.anchor === `customer:${cust}` && e.context.intent === "enrich_signal:receivable_overdue");
  check("2.2 pacote escopado ao domínio do sinal (só finance nos fatos)", !!e.context && e.context.facts.every((f: any) => f.subject === `customer:${cust}`));
  check("2.3 entidade âncora no grafo do pacote", !!e.context && e.context.entities.some((n: any) => n.id === cust && n.type === "customer"));

  // ═══════════════ 3. Lente de prioridade (scoreOne) ═══════════════
  check("3.1 priority presente (mesmo cálculo do feed)", !!e.priority && typeof (e.priority as any).score === "number" && (e.priority as any).signalId === primary.id);
  check("3.2 impactLevel + ação recomendada", !!e.priority && typeof (e.priority as any).impactLevel === "string" && typeof (e.priority as any).recommendedAction === "string");

  // ═══════════════ 4. Meta ameaçada (affectedGoal) ═══════════════
  check("4.1 meta de receita ameaçada surfada", !!e.threatenedGoal && e.threatenedGoal.metric === "revenue" && e.threatenedGoal.gapPct > 0);

  // ═══════════════ 5. Restrições aplicáveis (F4) ═══════════════
  check("5.1 restrição global aplicável", e.constraints.some((c: any) => !c.scopeType && c.kind === "discount_ceiling"));
  check("5.2 restrição escopada ao cliente-âncora aplicável", e.constraints.some((c: any) => c.scopeType === "customer" && c.scopeRef === cust && c.kind === "payment_term_max"));

  // ═══════════════ 6. Correlatos do mesmo sujeito (§39) ═══════════════
  check("6.1 sinal irmão do mesmo sujeito presente", e.relatedSignals.some((r: any) => r.id === sibling.id));
  check("6.2 correlatos NÃO incluem o próprio sinal", e.relatedSignals.every((r: any) => r.id !== primary.id));

  // ═══════════════ 7. Sujeito sem casa no grafo → não inventa âncora ═══════════════
  const eo = SE.enrich(orgA, opp.id, { asOf: ASOF });
  check("7.1 opportunity não resolve → anchor null", eo.found === true && eo.anchor === null);
  check("7.2 mas o fato do sinal segue presente (subject opportunity:opp-1)", !!eo.fact && eo.fact.subject === "opportunity:opp-1");
  check("7.3 pacote degrada pra org+domínio (context presente, anchor null)", !!eo.context && eo.context.anchor === null);

  // ═══════════════ 8. Sinal fechado → found mas sem lente ═══════════════
  SIG.resolve(orgA, sibling.id); // fecha o irmão
  const ec = SE.enrich(orgA, sibling.id, { asOf: ASOF });
  check("8.1 sinal fechado → found:true, fato presente", ec.found === true && !!ec.fact);
  check("8.2 sinal fechado → priority null (só sinal vivo pontua)", ec.priority === null);
  // e agora ele não aparece mais como correlato do primário (fechou).
  const e2 = SE.enrich(orgA, primary.id, { asOf: ASOF });
  check("8.3 correlato fechado sai da situação", e2.relatedSignals.every((r: any) => r.id !== sibling.id));

  // ═══════════════ 9. Not-found + isolamento multi-tenant ═══════════════
  check("9.1 sinal inexistente → found:false", SE.enrich(orgA, "nao-existe").found === false);
  check("9.2 sinal do tenant B não enriquece sob A (isolamento)", SE.enrich(orgA, bSig.id).found === false);
  check("9.3 o mesmo sinal enriquece sob o próprio tenant B", SE.enrich(orgB, bSig.id).found === true);

  // ═══════════════ 10. Paridade enrichRow == enrich ═══════════════
  const row = db.prepare("SELECT * FROM business_signals WHERE id = ? AND organization_id = ?").get(primary.id, orgA);
  const er = SE.enrichRow(orgA, row, { asOf: ASOF });
  check("10.1 enrichRow reproduz enrich (âncora + fato + meta)", er.anchor === e2.anchor && er.fact?.subject === e2.fact?.subject && er.threatenedGoal?.metric === e2.threatenedGoal?.metric);

  console.log("\n=== TEST: Signal Context Enrichment (PRD 3 F5) ===\n");
  for (const rr of results) console.log(`${rr.ok ? "✅" : "❌"} ${rr.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Signal Context Enrichment (F5) OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
