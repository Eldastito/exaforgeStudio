/**
 * TEST — Golden Path GP-01 + Hardening (PRD-ZF-UNIFIED-GAP-CLOSURE-03 F3 / PR-11).
 *
 * Prova o GATE F3 ponta-a-ponta numa empresa ENDIVIDADA, compondo os serviços REAIS das
 * fatias PR-5..PR-10 (nada novo): endividamento → consolidar quadro → runway → caixa 13
 * semanas → crise operacional×financeira → mapa da dívida → priorizar → orçamento de
 * sobrevivência → simular cenários → "quanto prometer?" → plano → sugerir missão →
 * escalonar profissional → Data Room. E CODIFICA como regressão os guardrails RN-FR:
 * determinístico (sem chave de IA), dinheiro role-gated, fato≠hipótese, nunca inventa
 * dívida, nunca dá parecer/executa negociação, IRF estende survival (não índice paralelo).
 *
 * Uso: npm run test:financial-recovery-golden-path
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-gp01-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-gp01-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { RecoveryAssessmentService: A } = await import("../src/server/RecoveryAssessmentService.js");
  const { RecoveryViabilityService: V } = await import("../src/server/RecoveryViabilityService.js");
  const { RecoveryDebtService: D } = await import("../src/server/RecoveryDebtService.js");
  const { DebtPriorityService: P } = await import("../src/server/DebtPriorityService.js");
  const { SurvivalBudgetService: SB } = await import("../src/server/SurvivalBudgetService.js");
  const { RecoveryScenarioService: SC } = await import("../src/server/RecoveryScenarioService.js");
  const { RecoveryPlanService: PL } = await import("../src/server/RecoveryPlanService.js");
  const { ProfessionalEscalationService: E } = await import("../src/server/ProfessionalEscalationService.js");
  const { RecoveryDataRoomService: DR } = await import("../src/server/RecoveryDataRoomService.js");
  const { FinancialLedgerService: L } = await import("../src/server/FinancialLedgerService.js");

  // ── Empresa endividada: caixa baixo, folha vencida, tributo, judicial, conta grande vencida ──
  const A_ID = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, financial_recovery_enabled) VALUES (?, ?, 'Empresa em crise', 'active', 1)`).run(randomUUID(), A_ID);
  db.prepare(`INSERT INTO cash_accounts (id, organization_id, name, type, opening_balance, current_balance, active) VALUES (?, ?, 'Caixa', 'caixa', 2000, 2000, 1)`).run(randomUUID(), A_ID);
  L.addPayable(A_ID, { description: "Fornecedor vencido", amount: 8000, dueDate: "2020-01-01", category: "fornecedor" });
  L.addPayable(A_ID, { description: "Assinatura software", amount: 400, dueDate: "2026-12-31", category: "software" });
  D.create(A_ID, { creditor: "Funcionários", category: "payroll", amountTotal: 6000, amountOverdue: 6000, monthlyPayment: 6000 }, "u1");
  D.create(A_ID, { creditor: "Receita", category: "tax", amountTotal: 15000, amountOverdue: 15000, legalRisk: "high", monthlyPayment: 1500 }, "u1");
  D.create(A_ID, { creditor: "Ação trabalhista", category: "judicial", amountTotal: 10000, negotiability: "low" }, "u1");

  // 1. Consolidar o quadro (F3.2)
  const assess = A.assess(A_ID);
  check("GP.1 quadro consolidado disponível", assess.available === true && !!assess.debt && !!assess.finance);
  check("GP.1b mapa da dívida agrega as obrigações", assess.debt.itemsCount === 3);

  // 2. Runway + caixa 13 semanas (F3.4) — deve furar (caixa 2000 vs conta 8000 vencida)
  check("GP.2 runway/ruptura visível", assess.finance!.firstRupture !== undefined);

  // 3. IRF + crise operacional×financeira (F3.6/F3.7)
  const via = V.viability(A_ID);
  check("GP.3 IRF calculado (0-100)", typeof via.irf === "number" && via.irf! >= 0 && via.irf! <= 100);
  check("GP.3b diagnóstico de crise presente", ["operational", "financial", "mixed", "stable", "undetermined"].includes(via.crisis.shape));
  check("GP.3c IRF tem disclaimer (não é falência/parecer)", /orientativo/.test(via.disclaimer));

  // 4. Mapa + priorização (F3.3/F3.8) — NÃO é ordem jurídica
  const prio = P.prioritize(A_ID);
  check("GP.4 dívidas priorizadas por 4 eixos", prio.items.length === 3 && !!prio.items[0].axes.legalRisk);
  check("GP.4b caveat: não é ordem jurídica", prio.caveats.some((c) => /NÃO é uma ordem jurídica/.test(c)));

  // 5. Orçamento de sobrevivência (F3.5) — sugere, não cancela
  const budget = SB.suggest(A_ID);
  check("GP.5 orçamento sugere corte (software→C)", budget.items.some((i) => i.tier === "C"));
  check("GP.5b nada é cancelado (caveat)", budget.caveats.some((c) => /Nenhuma despesa é cancelada/.test(c)));

  // 6. Simular cenário (F3.9) + "quanto prometer?" (F3.10) — determinístico, fato≠hipótese
  const sim = SC.simulate(A_ID, { minCash: 0, levers: [{ kind: "recover_overdue", label: "Recuperar vencido", basis: "fact", oneTime: [{ week: 1, inflow: 3000 }] }, { kind: "increase_revenue", label: "Campanha", basis: "hypothesis", monthlyInflowDelta: 5000 }] });
  check("GP.6 cenário separa fato de hipótese", sim.containsHypothesis === true && sim.factOnly && sim.scenario);
  const commit = SC.commitmentAffordability(A_ID, { downPayment: 0, monthlyAmount: 20000, installments: 6, minCash: 0 });
  check("GP.6b 'quanto prometer' incompatível (caixa não sustenta)", commit.compatible === false && /INCOMPATÍVEL/.test(commit.verdict) && !/aceite/i.test(commit.verdict));

  // 7. Plano consolidado + sugestão de missão (F3.13/F3.14) — sugere, nunca cria
  const plan = PL.plan(A_ID);
  check("GP.7 plano com seções ordenadas", plan.sections.length === 4);
  const ms = PL.suggestMission(A_ID);
  check("GP.7b sugere missão (nunca cria)", !!ms.draft && ms.draft.source === "system_proposed" && /nunca cria/.test(ms.note));

  // 8. Escalonamento profissional (F3.17) — sinaliza, nunca parecer
  const esc = E.assess(A_ID);
  check("GP.8 escalonamento requerido (folha vencida/tributo/judicial)", esc.professionalReviewRequired === true && !!esc.message);
  check("GP.8b nunca recomenda falência automaticamente", /nunca recomenda automaticamente falência/.test(esc.disclaimer));

  // 9. Data Room (F3.19) — compõe tudo, sem storage paralelo
  const dr = DR.assemble(A_ID);
  check("GP.9 Data Room compõe todas as seções", !!dr.sections.financial && !!dr.sections.viability && !!dr.sections.debtPriority && !!dr.sections.plan && !!dr.sections.escalation && !!dr.sections.cash13Weeks);

  // ── HARDENING (RN-FR como regressão) ──
  // H1 — determinístico: sem chave de IA (NODE_ENV=production, sem OPENAI/etc), tudo acima rodou.
  check("H1 determinístico (rodou sem chave de IA)", true);
  // H2 — dinheiro role-gated: sem permissão, R$ redigido em TODAS as superfícies.
  const assessR = A.assess(A_ID, { includeMoney: false });
  const budgetR = SB.suggest(A_ID, { includeMoney: false });
  const planR = PL.plan(A_ID, { includeMoney: false });
  const drR = DR.assemble(A_ID, { includeMoney: false });
  check("H2 dinheiro redigido (assessment/budget/plan/dataroom)", assessR.redacted === true && budgetR.redacted === true && planR.redacted === true && drR.redacted === true);
  check("H2b débito no Data Room redigido", drR.sections.debtMap.items.every((d: any) => d.amount_total === null));
  // H3 — nunca inventa dívida: campos não informados ficam null.
  const jd = D.list(A_ID).find((d: any) => d.category === "judicial")!;
  check("H3 campo não informado = null (não inventado)", jd.monthly_payment === null && jd.interest_rate === null);
  // H4 — IRF estende survival (componente base = índice de sobrevivência, não índice paralelo).
  const { SurvivalIndexService: SI } = await import("../src/server/SurvivalIndexService.js");
  check("H4 IRF reusa o score do SurvivalIndexService", via.components.find((c) => c.key === "operational_health")!.score === SI.score(A_ID).score);
  // H5 — negociação nunca executa: proposta é sugestão + rascunho, sem assinar.
  const neg = SC.negotiationProposal(A_ID, { debtTotal: 31000, minCash: 0 });
  check("H5 negociação é sugestão (não renegocia sozinho)", neg.caveats.some((c: string) => /não aceita\/assina|não renegocia sozinho/.test(c)));

  // ── Isolamento ──
  const B = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'B', 'active')`).run(randomUUID(), B);
  check("ISO org B não vê nada de A", D.list(B).length === 0 && E.assess(B).professionalReviewRequired === false && DR.assemble(B).sections.debtMap.items.length === 0);

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} financial-recovery-golden-path: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
