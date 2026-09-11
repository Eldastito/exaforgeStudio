/**
 * TEST — Recovery Plan + sugestão de Missão (PRD-ZF-UNIFIED-GAP-CLOSURE-03 F3.13/F3.14, PR-9).
 * COMPÕE assessment/viability/priority/budget num plano ordenado + rascunho de missão.
 *
 * Cobre: estrutura do plano + 4 seções · corte (C/D) na seção estancar · dívidas na seção
 * renegociar · recebível vencido na seção recuperar · escalonamento profissional (legal alto)
 * · suggestMission rascunho (irf/65/system_proposed, sugere-nunca-cria) · dinheiro role-gated
 * · isolamento.
 *
 * Uso: npm run test:recovery-plan
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-plan-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-plan-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { RecoveryPlanService: P } = await import("../src/server/RecoveryPlanService.js");
  const { RecoveryDebtService: D } = await import("../src/server/RecoveryDebtService.js");
  const { FinancialLedgerService: L } = await import("../src/server/FinancialLedgerService.js");

  const A = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Loja', 'active')`).run(randomUUID(), A);

  // Dados: 1 dívida (renegociar), 1 conta cortável (estancar), 1 recebível vencido (recuperar).
  D.create(A, { creditor: "Banco", category: "loan", amountTotal: 40000, amountOverdue: 5000, monthlyPayment: 2000, negotiability: "high" }, "u1");
  L.addPayable(A, { description: "Assinatura software", amount: 300, dueDate: "2026-12-31", category: "software" }); // tier C
  L.addReceivable(A, { description: "Cliente atrasado", amount: 1500, dueDate: "2020-01-01" }); // vencido

  const plan = P.plan(A);
  const sec = (k: string) => plan.sections.find((s: any) => s.key === k);
  check("1.1 objetivo + disclaimer", /equilíbrio financeiro/.test(plan.objective) && !!plan.disclaimer);
  check("1.2 4 seções", plan.sections.length === 4);
  check("1.3 seções esperadas", ["estancar_saida", "renegociar_dividas", "recuperar_recebiveis", "melhorar_margem"].every((k) => !!sec(k)));
  check("1.4 crise presente + irf", !!plan.crisis && plan.irf !== undefined);

  check("2.1 estancar traz conta cortável (C)", sec("estancar_saida").items.some((i: any) => i.tier === "C" || i.tier === "D"));
  check("2.2 renegociar traz dívida priorizada", sec("renegociar_dividas").items.length >= 1);
  check("2.3 renegociar NÃO é ordem jurídica (caveat)", sec("renegociar_dividas").caveats.some((c: string) => /NÃO é uma ordem jurídica/.test(c)));
  check("2.4 recuperar recebíveis traz o vencido (fato)", sec("recuperar_recebiveis").items.some((i: any) => i.basis === "fact"));

  // ── 3. Escalonamento profissional: dívida com risco jurídico alto ──
  const B = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'B', 'active')`).run(randomUUID(), B);
  D.create(B, { creditor: "Fazenda", category: "tax", amountTotal: 10000, legalRisk: "high" }, "u1");
  check("3.1 legal alto → professionalReviewRecommended", P.plan(B).professionalReviewRecommended === true);
  check("3.2 org A (sem legal alto) → sem escalonamento forçado", P.plan(A).professionalReviewRecommended === false);

  // ── 4. Sugestão de missão (sugere, nunca cria) ──
  const ms = P.suggestMission(A);
  check("4.1 rascunho presente", !!ms.draft && ms.draft.targetMetric === "irf" && ms.draft.targetValue === 65);
  check("4.2 source system_proposed", ms.draft.source === "system_proposed");
  check("4.3 mission layer desligado por default (honesto)", ms.missionLayerEnabled === false);
  check("4.4 note: nunca cria sozinho", /nunca cria/.test(ms.note) && ms.basis === "hypothesis");
  check("4.5 title restaurar equilíbrio", /Restaurar equilíbrio/.test(ms.draft.title));

  // ── 5. Dinheiro role-gated ──
  const planR = P.plan(A, { includeMoney: false });
  check("5.1 plano redacted", planR.redacted === true);
  check("5.2 itens de corte com R$ redigido", planR.sections.find((s: any) => s.key === "estancar_saida").items.every((i: any) => i.amount === null));

  // ── 6. Isolamento ──
  const E = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'E', 'active')`).run(randomUUID(), E);
  const planE = P.plan(E);
  check("6.1 org vazia: renegociar/estancar sem itens", planE.sections.find((s: any) => s.key === "renegociar_dividas").items.length === 0 && planE.sections.find((s: any) => s.key === "estancar_saida").items.length === 0);

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} recovery-plan: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
