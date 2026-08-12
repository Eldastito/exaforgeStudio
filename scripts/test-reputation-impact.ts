/**
 * TEST — Reputation Impact & KPI (PRD 5 / ADR-162 F13). DB-backed, det., isolado.
 * Prova (§51-55, D6):
 *   - KPI CENTRAL = problemas RESOLVIDOS (§55): resolvidos/abertos/total + taxa;
 *   - INFLUENCED (D6): 3º estado de atribuição no OutcomeMeasurement; fact/estimate/
 *     influenced NUNCA somados (§54); categorias (revenueRecovered/lossPrevented/
 *     costAvoided) NUNCA somadas entre si (§52);
 *   - §52/RN-CRR-7: valor só com realizedValue + evidência; sem lastro → recusa;
 *     só ação de recovery; multi-tenant.
 *
 * Uso: npm run test:reputation-impact
 */
import os from "os"; import path from "path"; import fs from "fs";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-rep-imp-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-rep-imp-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { ExternalSignalService: EXT } = await import("../src/server/ExternalSignalService.js");
  const { ReputationCaseService: CASE } = await import("../src/server/ReputationCaseService.js");
  const { ReputationClosureService: CLOSE } = await import("../src/server/ReputationClosureService.js");
  const { ReputationImpactService: IMP } = await import("../src/server/ReputationImpactService.js");
  const { OutcomeMeasurementService: OUT } = await import("../src/server/OutcomeMeasurementService.js");
  const { DecisionActionService: DA } = await import("../src/server/DecisionActionService.js");

  const A = "org_imp_A", B = "org_imp_B";
  const enableOrg = (org: string) => {
    db.prepare(`INSERT OR IGNORE INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(`os-${org}`, org);
    db.prepare(`UPDATE organization_settings SET radar_external_signals_enabled = 1 WHERE organization_id = ?`).run(org);
  };
  const mkContact = (org: string, id: string) =>
    db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, identifier, name, email) VALUES (?, ?, 'ch1', ?, ?, ?)`).run(id, org, `id-${id}`, id, `${id}@x.com`);
  enableOrg(A); enableOrg(B); mkContact(A, "C1");

  let n = 0;
  const complaint = (org: string) => {
    const externalId = `RA-${++n}`;
    const sid = EXT.ingest(org, { source: "reclame_aqui", externalId, domain: "reputation", signalType: "public_complaint", content: "meu pedido não chegou", basis: "estimate", verifiable: false, subjectType: "reputation_item", subjectId: externalId, rating: 2, ratingScale: 5 }).signalId!;
    CASE.resolveCase(org, sid, { contactId: "C1" });
    return sid;
  };
  const recoveryAction = (org: string) => DA.propose(org, { domain: "recovery", actionType: "refund", title: "Recuperação", commandType: "refund_request" }).id;

  // 2 reclamações; resolve 1 (F10) → taxa 50%.
  const s1 = complaint(A); complaint(A);
  CLOSE.close(A, s1, { resolution: "resolved" });

  // Valor atribuído em 3 bases distintas (nunca somadas).
  const aInf = recoveryAction(A), aFact = recoveryAction(A), aEst = recoveryAction(A);
  IMP.recordRecoveryValue(A, aInf, { realizedValue: 200, category: "revenueRecovered", evidence: { note: "cliente recomprou após recuperação" } }); // default influenced
  IMP.recordRecoveryValue(A, aFact, { realizedValue: 100, category: "lossPrevented", basis: "fact", evidence: { note: "reembolso confirmado" } });
  IMP.recordRecoveryValue(A, aEst, { realizedValue: 50, category: "costAvoided", basis: "estimate", evidence: { note: "custo evitado projetado" } });

  // ═══════════════ 1. KPI North Star ═══════════════
  const kpi = IMP.kpi(A, {});
  check("1.1 North Star = problemas resolvidos", kpi.northStar === "problems_resolved");
  check("1.2 resolvidos/abertos/total", kpi.problemsResolved === 1 && kpi.openProblems === 1 && kpi.totalProblems === 2);
  check("1.3 taxa de recuperação 50%", kpi.recoveryRatePct === 50);

  // ═══════════════ 2. INFLUENCED + separação por base (§54) ═══════════════
  check("2.1 INFLUENCED registrado (basis)", OUT.forAction(A, aInf)[0].basis === "influenced");
  check("2.2 byBasis separado (influenced 200, fact 100, estimate 50)", kpi.value.byBasis.influenced.realized === 200 && kpi.value.byBasis.fact.realized === 100 && kpi.value.byBasis.estimate.realized === 50);
  check("2.3 fact/estimate/influenced NUNCA somados (3 buckets distintos)", kpi.value.byBasis.influenced.realized !== (kpi.value.byBasis.fact.realized + kpi.value.byBasis.estimate.realized + kpi.value.byBasis.influenced.realized));

  // ═══════════════ 3. Categorias separadas (§52) ═══════════════
  check("3.1 categorias na sua própria interpretação (nunca somadas)", kpi.value.categories.revenueRecovered === 200 && kpi.value.categories.lossPrevented === 100 && kpi.value.categories.costAvoided === 50);

  // ledger genérico ganhou o bucket influenced (regressão D6)
  check("3.2 OutcomeMeasurement.ledger expõe bucket influenced", OUT.ledger(A, { domain: "recovery" }).totals.influenced.realized === 200);

  // ═══════════════ 4. §52/RN-CRR-7 — não inventa dinheiro ═══════════════
  const aGuard = recoveryAction(A);
  let noValue = false, noEvidence = false, badCat = false, notRecovery = false;
  try { IMP.recordRecoveryValue(A, aGuard, { realizedValue: undefined as any, category: "revenueRecovered", evidence: {} }); } catch (e: any) { noValue = /realizedValue/.test(String(e?.message || e)); }
  try { IMP.recordRecoveryValue(A, aGuard, { realizedValue: 10, category: "revenueRecovered", evidence: null }); } catch (e: any) { noEvidence = /evidence/.test(String(e?.message || e)); }
  try { IMP.recordRecoveryValue(A, aGuard, { realizedValue: 10, category: "foo", evidence: {} }); } catch (e: any) { badCat = /category/.test(String(e?.message || e)); }
  const aSales = DA.propose(A, { domain: "sales", actionType: "x", title: "y" }).id;
  try { IMP.recordRecoveryValue(A, aSales, { realizedValue: 10, category: "revenueRecovered", evidence: {} }); } catch (e: any) { notRecovery = /recovery/.test(String(e?.message || e)); }
  check("4.1 sem valor → recusa (§52)", noValue);
  check("4.2 sem evidência → recusa (§52)", noEvidence);
  check("4.3 categoria inválida → recusa", badCat);
  check("4.4 só ação de recovery", notRecovery);

  // ═══════════════ 5. multi-tenant ═══════════════
  check("5.1 KPI não cruza org (B vazio)", IMP.kpi(B, {}).totalProblems === 0 && IMP.kpi(B, {}).value.byBasis.influenced.realized === 0);

  // ── relatório ──
  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} reputation-impact: ${passed}/${results.length} checks`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
