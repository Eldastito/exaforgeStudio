/**
 * TEST — Recovery Scenario Engine + "quanto prometer?" + Negociação (PRD-ZF-UNIFIED-GAP-
 * CLOSURE-03 F3.9/F3.10/F3.11, PR-8). Determinístico, compõe a projeção de 13 semanas.
 *
 * Cobre: simulação de alavancas (fato ≠ hipótese: baseline×factOnly×scenario) · caveat de
 * hipótese · commitment compatível/incompatível (nunca "aceite") · negociação propõe parcela
 * que cabe + rascunho · em ruptura → não promete parcela · dinheiro role-gated · isolamento.
 *
 * Uso: npm run test:recovery-scenario
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-scen-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-scen-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

function seedCash(db: any, orgId: string, balance: number) {
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Loja', 'active')`).run(randomUUID(), orgId);
  db.prepare(`INSERT INTO cash_accounts (id, organization_id, name, type, opening_balance, current_balance, active) VALUES (?, ?, 'Caixa', 'caixa', ?, ?, 1)`).run(randomUUID(), orgId, balance, balance);
}

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { RecoveryScenarioService: S } = await import("../src/server/RecoveryScenarioService.js");
  const { FinancialLedgerService: L } = await import("../src/server/FinancialLedgerService.js");

  // ── Org A: saudável (R$ 50.000, sem contas) ──
  const A = `org_${randomUUID().slice(0, 8)}`;
  seedCash(db, A, 50000);

  // 1. Simulação: 1 alavanca FATO (recuperar vencido, entrada única) + 1 HIPÓTESE (aumento receita)
  const sim = S.simulate(A, {
    minCash: 0,
    levers: [
      { kind: "recover_overdue", label: "Recuperar vencido", basis: "fact", oneTime: [{ week: 1, inflow: 2000 }] },
      { kind: "increase_revenue", label: "Campanha (aposta)", basis: "hypothesis", monthlyInflowDelta: 4000 },
    ],
  });
  check("1.1 baseline minEnding = 50000 (saudável)", sim.baseline.minEnding === 50000);
  check("1.2 containsHypothesis true", sim.containsHypothesis === true);
  check("1.3 factOnly > baseline no saldo final (só o fato de +2000)", sim.factOnly.endEnding > sim.baseline.endEnding);
  check("1.4 scenario > factOnly (hipótese soma por cima, separada)", sim.scenario.endEnding > sim.factOnly.endEnding);
  check("1.5 caveat separa hipótese de fato", sim.caveats.some((c: string) => /HIPÓTESE/.test(c)));
  check("1.6 levers rotulam basis", sim.levers.find((l: any) => l.kind === "recover_overdue")?.basis === "fact");

  // 2. Commitment: acordo pequeno compatível × acordo enorme incompatível
  const ok = S.commitmentAffordability(A, { downPayment: 10000, monthlyAmount: 5000, installments: 6, minCash: 0 });
  check("2.1 acordo pequeno compatível", ok.compatible === true && /COMPATÍVEL/.test(ok.verdict));
  const bad = S.commitmentAffordability(A, { downPayment: 0, monthlyAmount: 30000, installments: 6, minCash: 0 });
  check("2.2 acordo grande incompatível", bad.compatible === false && /INCOMPATÍVEL/.test(bad.verdict));
  check("2.3 nunca diz 'aceite'", !/aceite/i.test(ok.verdict) && !/aceite/i.test(bad.verdict));
  check("2.4 caveat: decisão humana, não assina", ok.caveats.some((c: string) => /não aceita nem assina/.test(c)));

  // 3. Negociação: propõe parcela que cabe + rascunho
  const neg = S.negotiationProposal(A, { debtTotal: 60000, maxInstallments: 12, minCash: 0 });
  check("3.1 feasible com folga de caixa", neg.feasible === true && neg.affordableMonthly > 0);
  check("3.2 installments > 0", neg.installments > 0);
  check("3.3 rascunho de mensagem cita parcelas", /x de R\$/.test(neg.messageDraft));
  check("3.4 caveat: não renegocia sozinho", neg.caveats.some((c: string) => /não aceita\/assina|não renegocia sozinho|não aceita/.test(c)));

  // ── Org B: em ruptura (R$ 1.000, conta de R$ 5.000 vencida) ──
  const B = `org_${randomUUID().slice(0, 8)}`;
  seedCash(db, B, 1000);
  L.addPayable(B, { description: "Fornecedor vencido", amount: 5000, dueDate: "2020-01-01", category: "fornecedor" });
  const negB = S.negotiationProposal(B, { debtTotal: 20000, maxInstallments: 12, minCash: 0 });
  check("4.1 em ruptura → não promete parcela", negB.feasible === false && negB.affordableMonthly === 0);
  check("4.2 risco alto + recomenda alongamento/carência", negB.risk === "high" && /carência|alongamento/i.test(negB.note));
  const simB = S.simulate(B, { minCash: 0, levers: [] });
  check("4.3 baseline de B fura o mínimo", (simB.baseline.minEnding as number) < 0 && !!simB.baseline.firstRisk);

  // ── 5. Dinheiro role-gated ──
  const simR = S.simulate(A, { minCash: 0, levers: [], includeMoney: false });
  check("5.1 valores redigidos", simR.baseline.minEnding === null && simR.redacted === true);
  const okR = S.commitmentAffordability(A, { downPayment: 10000, monthlyAmount: 5000, installments: 6, minCash: 0, includeMoney: false });
  check("5.2 commitment: veredito preservado, R$ redigido", okR.compatible === true && okR.resultingMinEnding === null);
  const negR = S.negotiationProposal(A, { debtTotal: 60000, minCash: 0, includeMoney: false });
  check("5.3 negociação: feasible/installments preservados, R$ redigido", negR.feasible === true && negR.affordableMonthly === null && typeof negR.installments === "number");

  // ── 6. Isolamento ──
  const simIso = S.simulate(`org_${randomUUID().slice(0, 8)}`, { minCash: 0, levers: [] });
  check("6.1 org sem caixa → baseline 0, sem vazamento de A", simIso.baseline.minEnding === 0);

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} recovery-scenario: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
