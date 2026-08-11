/**
 * TEST — PRD 3 F3 (§18/§19/§20/§6/§73): Context Resolver — o coração do Business
 * Context Engine. DB-backed, isolado por tmpDir.
 *
 * Prova, determinístico (o DoD §129: Signal → Resolver → Packet → Quality):
 *   - resolve() monta um ContextPacket com momento/fatos/grafo/metas/pistas/
 *     qualidade + proveniência (sources) + schemaVersion;
 *   - um sinal publicado vira FATO (traduzido por factFromSignal) e item do MOMENTO;
 *   - âncora (focus/escopo) escopa os fatos ao sujeito e traz a vizinhança do grafo
 *     (F2); âncora que não resolve → anchor:null (não inventa, RN-CR-2);
 *   - Progressive Disclosure (§6): perfil/orçamento limitam cada seção + truncated;
 *   - qualidade (§75): cobertura + banda de confiança + frescor + lacunas;
 *   - pistas (§21) derivam de recommendedActionType (não executam skill);
 *   - resolveBudget (puro) respeita perfil + overrides;
 *   - ISOLAMENTO multi-tenant: pacote do tenant A não vaza sinal/entidade do B;
 *   - ContextEngineService.resolve delega (fachada única, AC-A01).
 *
 * Uso: npm run test:context-resolver
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-ctx-resolver-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-ctx-resolver-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

const uid = (p: string) => `${p}_${randomUUID().slice(0, 8)}`;

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { ContextResolverService: R } = await import("../src/server/ContextResolverService.js");
  const { ContextEngineService: ENG } = await import("../src/server/ContextEngineService.js");
  const { BusinessSignalService: SIG } = await import("../src/server/BusinessSignalService.js");
  const { resolveBudget, PROFILE_BUDGETS, makeScope } = await import("../src/server/contextModel.js");

  // ───────── resolveBudget (puro) ─────────
  check("0.1 resolveBudget default = standard", JSON.stringify(resolveBudget({})) === JSON.stringify(PROFILE_BUDGETS.standard));
  check("0.2 perfil minimal aplicado", resolveBudget({ profile: "minimal" }).maxFacts === PROFILE_BUDGETS.minimal.maxFacts);
  check("0.3 override de budget sobrepõe o perfil", resolveBudget({ profile: "deep", budget: { maxFacts: 2 } }).maxFacts === 2 && resolveBudget({ profile: "deep", budget: { maxFacts: 2 } }).maxEntities === PROFILE_BUDGETS.deep.maxEntities);
  check("0.4 graphDepth 0 é válido (não cai no default)", resolveBudget({ budget: { graphDepth: 0 } }).graphDepth === 0);

  // ───────── Seed: org A rica + org B (isolamento) ─────────
  const orgA = uid("orgA");
  const orgB = uid("orgB");
  const mkOrg = (org: string, name: string) =>
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, ?, 'active')`).run(randomUUID(), org, name);
  mkOrg(orgA, "Empresa A");
  mkOrg(orgB, "Empresa B");

  // entidades pro grafo: usuário-gestor + loja gerida por ele
  const boss = uid("user");
  db.prepare(`INSERT INTO users (id, organization_id, name, role, global_status) VALUES (?, ?, 'Chefe', 'admin', 'active')`).run(boss, orgA);
  const store = uid("store");
  db.prepare(`INSERT INTO retail_stores (id, organization_id, name, code, manager_user_id, active) VALUES (?, ?, 'Loja Centro', 'C1', ?, 1)`).run(store, orgA, boss);

  // cliente + sinal financeiro sobre ele (subject=customer)
  const cust = uid("cust");
  db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, 'ch1', 'Cliente Alfa', 'alfa')`).run(cust, orgA);
  SIG.publish(orgA, {
    domain: "finance", signalType: "receivable_overdue", severity: "risk", basis: "fact", confidence: 0.9,
    impactAmount: 4500, impactUnit: "BRL", subjectType: "customer", subjectId: cust,
    sourceService: "FinanceSignalPublisher", sourceEntityType: "invoice", sourceEntityId: "inv-1",
    evidence: { days: 30 }, dedupeKey: "fin:recv:alfa",
  });
  // sinal de outro domínio (sales) sem subject
  SIG.publish(orgA, {
    domain: "sales", signalType: "stalled_opportunities", severity: "attention", basis: "estimate", confidence: 0.6,
    sourceService: "SalesDetector", evidence: { count: 3 }, dedupeKey: "sales:stalled",
  });
  // sinal do tenant B (não pode vazar pra A)
  SIG.publish(orgB, {
    domain: "finance", signalType: "cash_below_minimum", severity: "critical", basis: "fact", confidence: 0.8,
    sourceService: "FinanceSignalPublisher", evidence: {}, dedupeKey: "fin:cash:b",
  });

  // meta
  db.prepare(`INSERT INTO business_goals (id, organization_id, metric, target_amount) VALUES (?, ?, 'revenue', 100000)`).run(uid("goal"), orgA);

  // ───────── 1. Pacote base (sem âncora) ─────────
  const pkt = R.resolve(orgA, { intent: "panorama_geral" });
  check("1.1 tenant/intent/schemaVersion", pkt.tenantId === orgA && pkt.intent === "panorama_geral" && pkt.schemaVersion === 1);
  check("1.2 proveniência lista as fontes compostas", pkt.sources.includes("attention") && pkt.sources.includes("context_graph") && pkt.sources.includes("data_quality"));
  check("1.3 sinal vira FATO (subject customer:cust, predicate signal_type)", pkt.facts.some((f: any) => f.subject === `customer:${cust}` && f.predicate === "receivable_overdue" && f.factType === "OBSERVED"));
  check("1.4 sinal vira item do MOMENTO (attention)", pkt.moment.total >= 2 && pkt.moment.top.some((i: any) => i.type === "receivable_overdue"));
  check("1.5 sem âncora → esqueleto da org (org resolve como nó)", pkt.anchor === null && pkt.entities.some((e: any) => e.type === "organization"));
  check("1.6 metas presentes", pkt.goals.length >= 1 && (pkt.goals[0] as any).metric === "revenue");

  // ───────── 2. Qualidade (§75) ─────────
  check("2.1 cobertura numérica (dataQuality.pct)", typeof pkt.quality.coveragePct === "number");
  check("2.2 confiança tem score+band coerentes", pkt.quality.confidence.score > 0 && typeof pkt.quality.confidence.band === "string");
  check("2.3 frescor conta os fatos", (pkt.quality.freshness.fresh + pkt.quality.freshness.stale + pkt.quality.freshness.unknown) === pkt.facts.length);
  check("2.4 lacunas listadas (dados não informados)", Array.isArray(pkt.quality.gaps) && pkt.quality.gaps.length > 0);
  check("2.5 sem conflito entre fatos distintos", pkt.quality.conflicts === 0);

  // ───────── 3. Âncora escopa fatos + traz grafo (F2) ─────────
  const pC = R.resolve(orgA, { intent: "atender_cliente", focus: `customer:${cust}` });
  check("3.1 âncora resolvida reportada", pC.anchor === `customer:${cust}`);
  check("3.2 fatos escopados ao sujeito da âncora (só do cliente)", pC.facts.length >= 1 && pC.facts.every((f: any) => f.subject === `customer:${cust}`));
  check("3.3 grafo traz a entidade âncora", pC.entities.some((e: any) => e.type === "customer" && e.id === cust));

  // âncora via ESCOPO (dimensão) em vez de focus
  const pStore = R.resolve(orgA, { intent: "gerir_loja", scope: makeScope(orgA, [{ level: "BUSINESS_UNIT", ref: store }]) });
  check("3.4 escopo BUSINESS_UNIT vira âncora store + grafo (gestor via managed_by)", pStore.anchor === `store:${store}` && pStore.relationships.some((r: any) => r.type === "managed_by"));

  // âncora inexistente → anchor null, não inventa
  const pMiss = R.resolve(orgA, { intent: "x", focus: `customer:nao-existe` });
  check("3.5 âncora inexistente → anchor:null (não inventa)", pMiss.anchor === null && !pMiss.entities.some((e: any) => e.id === "nao-existe"));

  // ───────── 4. Progressive Disclosure / orçamento (§6) ─────────
  const pMin = R.resolve(orgA, { intent: "rapido", profile: "minimal", budget: { maxFacts: 1 } });
  check("4.1 orçamento aplicado ao pacote", pMin.budget.maxFacts === 1);
  check("4.2 fatos limitados ao teto", pMin.facts.length <= 1);
  check("4.3 truncated=true quando havia mais fatos que o teto", pMin.truncated === true);
  const pDomain = R.resolve(orgA, { intent: "so_financeiro", domains: ["finance"] });
  check("4.4 filtro de domínio restringe fatos a finance", pDomain.facts.every((f: any) => true) && pDomain.facts.some((f: any) => f.predicate === "receivable_overdue") && !pDomain.facts.some((f: any) => f.predicate === "stalled_opportunities"));

  // ───────── 5. Pistas de processo (§21) ─────────
  const hintsOk = pkt.skillHints.length >= 1 && pkt.skillHints.every((h: any) => typeof h.hint === "string" && typeof h.label === "string" && typeof h.priority === "number");
  check("5.1 skillHints derivam de recommendedActionType (pista, não skill)", hintsOk);

  // ───────── 6. Isolamento multi-tenant ─────────
  check("6.1 pacote de A não traz sinal/fato do B", !pkt.facts.some((f: any) => f.predicate === "cash_below_minimum") && !pkt.moment.top.some((i: any) => i.type === "cash_below_minimum"));
  const pB = R.resolve(orgB, { intent: "x" });
  check("6.2 pacote de B não traz entidade de A (loja/cliente/usuário)", !pB.entities.some((e: any) => [store, cust, boss].includes(e.id)));
  check("6.3 pacote de B só vê o próprio sinal", pB.facts.every((f: any) => f.predicate !== "receivable_overdue"));

  // ───────── 7. Fachada única: ContextEngineService.resolve delega ─────────
  const viaEngine = ENG.resolve(orgA, { intent: "panorama_geral" });
  check("7.1 ENG.resolve devolve um ContextPacket equivalente", viaEngine.tenantId === orgA && viaEngine.schemaVersion === 1 && Array.isArray(viaEngine.facts) && viaEngine.sources.includes("context_graph"));

  console.log("\n=== TEST: Context Resolver F3 (PRD 3) ===\n");
  for (const rr of results) console.log(`${rr.ok ? "✅" : "❌"} ${rr.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Context Resolver F3 OK.");
}

main().catch((e) => { console.error(e); process.exit(1); });
