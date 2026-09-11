/**
 * TEST — Professional Escalation + Recovery Data Room (PRD-ZF-UNIFIED-GAP-CLOSURE-03
 * F3.17/F3.19, PR-10). Escalonamento por gatilhos determinísticos (sinaliza, nunca parecer)
 * + Data Room que compõe os read-models de recuperação (sem storage paralelo).
 *
 * Cobre: gatilhos (folha vencida/tributo/judicial/múltiplas/garantia/insolvência) · required
 * quando há gatilho alto · mensagem padrão + disclaimer (nunca recomenda falência) · org
 * saudável não escala · Data Room compõe todas as seções · dinheiro role-gated (itens +
 * caixa 13s) · isolamento.
 *
 * Uso: npm run test:recovery-escalation-dataroom
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-esc-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-esc-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { ProfessionalEscalationService: E } = await import("../src/server/ProfessionalEscalationService.js");
  const { RecoveryDataRoomService: R } = await import("../src/server/RecoveryDataRoomService.js");
  const { RecoveryDebtService: D } = await import("../src/server/RecoveryDebtService.js");

  // ── Org A: vários gatilhos ──
  const A = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Loja', 'active')`).run(randomUUID(), A);
  D.create(A, { creditor: "Funcionários", category: "payroll", amountTotal: 8000, amountOverdue: 8000 }, "u1"); // salário atrasado
  D.create(A, { creditor: "Receita", category: "tax", amountTotal: 20000, amountOverdue: 20000 }, "u1");        // tributo
  D.create(A, { creditor: "Ação 1", category: "judicial", amountTotal: 10000 }, "u1");                          // judicial
  D.create(A, { creditor: "Ação 2", category: "judicial", amountTotal: 5000 }, "u1");                           // judicial 2
  D.create(A, { creditor: "Banco garantido", category: "loan", amountTotal: 30000, secured: true }, "u1");      // garantia real

  const esc = E.assess(A);
  const t = (k: string) => esc.triggers.find((x) => x.key === k)!;
  check("1.1 salário atrasado presente", t("salary_arrears").present === true);
  check("1.2 tributo presente", t("tax_debt").present === true);
  check("1.3 judicial presente", t("judicial").present === true);
  check("1.4 múltiplas ações (2 judiciais)", t("multiple_actions").present === true);
  check("1.5 garantia real presente", t("secured_guarantees").present === true);
  check("1.6 professionalReviewRequired", esc.professionalReviewRequired === true);
  check("1.7 mensagem padrão presente", !!esc.message && /profissional jurídico habilitado/.test(esc.message!));
  check("1.8 disclaimer: nunca recomenda falência automaticamente", /nunca recomenda automaticamente falência/.test(esc.disclaimer));
  check("1.9 sinaliza, não dá parecer (judicial = 'a confirmar')", /natureza a confirmar/.test(t("judicial").evidence));

  // ── Org saudável: sem gatilho alto ──
  const H = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Sã', 'active')`).run(randomUUID(), H);
  const escH = E.assess(H);
  check("2.1 org sem dívida → não escala", escH.professionalReviewRequired === false && escH.message === null);

  // ── Data Room compõe todas as seções ──
  const dr = R.assemble(A);
  check("3.1 audience presente", Array.isArray(dr.audience) && dr.audience.includes("contador"));
  const s = dr.sections;
  check("3.2 seções compostas", !!s.financial && !!s.viability && !!s.debtMap && !!s.debtPriority && !!s.survivalBudget && !!s.plan && !!s.escalation);
  check("3.3 debtMap traz as dívidas cadastradas", s.debtMap.items.length === 5);
  check("3.4 escalation dentro do data room reflete required", s.escalation.professionalReviewRequired === true);
  check("3.5 cash13Weeks presente (reusa CashForecast)", !!s.cash13Weeks);
  check("3.6 disclaimer + exportNote (sem storage paralelo)", /não é laudo/.test(dr.disclaimer) && /infra de documento/.test(dr.exportNote));

  // ── Dinheiro role-gated ──
  const drR = R.assemble(A, { includeMoney: false });
  check("4.1 redacted", drR.redacted === true);
  check("4.2 itens da dívida com R$ redigido", drR.sections.debtMap.items.every((d: any) => d.amount_total === null) && drR.sections.debtMap.items.some((d: any) => d.creditor));
  check("4.3 summary da dívida redigido", drR.sections.debtMap.summary.totalKnown === null);
  check("4.4 caixa 13s sem valores (só semana/risco)", drR.sections.cash13Weeks == null || drR.sections.cash13Weeks.weeks.every((w: any) => w.ending === undefined));

  // ── Isolamento ──
  const B = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'B', 'active')`).run(randomUUID(), B);
  check("5.1 org B não vê dívidas de A", R.assemble(B).sections.debtMap.items.length === 0 && E.assess(B).professionalReviewRequired === false);

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} recovery-escalation-dataroom: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
