/**
 * TEST — Fala Tu → Recuperação Financeira (FalaTuAskService, porta pro F3,
 * PRD-ZF-UNIFIED-GAP-CLOSURE-03). Prova a 2ª PORTA do Financial Recovery OS: o dono
 * descreve a crise em linguagem natural e o Fala Tu responde com o diagnóstico do F3.
 *
 * Cobre:
 *  - classify() PURO reconhece a crise ("no vermelho", "muita dívida", "recuperar a
 *    empresa", "quanto tempo aguento") → financial_recovery, needsMoney=false.
 *  - REGRESSÃO DURA: a porta só rouba do open_question — venda/folga/faturamento e os
 *    registros (venda/despesa) seguem classificando igual; "por que caí?"/"como estão
 *    minhas finanças?" seguem open_question (não viram recovery).
 *  - answer() com módulo ON: resposta ATERRADA no RecoveryPlanService (IRF + faixa +
 *    diagnóstico de crise + ordem do plano), grounded, TEXTO sem R$ (dinheiro só no data).
 *  - dinheiro role-gated (§73) por REDAÇÃO, não bloqueio: owner vê R$ no data; vendedor
 *    recebe o MESMO diagnóstico com data.plan.redacted=true (IRF/crise no texto, R$ nulo).
 *  - módulo OFF (default): a porta NÃO responde — delega ao Diretor IA (advisor), provado
 *    pelo throw de OPENAI_API_KEY em CI (a porta determinística do F3 nunca lançaria).
 *  - isolamento multi-tenant.
 *
 * Uso: npm run test:falatu-ask-recovery
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-falatu-ask-rec-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-falatu-ask-rec-123456";
delete process.env.OPENAI_API_KEY; // garante o throw honesto no fallback do módulo OFF

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { FalaTuAskService } = await import("../src/server/FalaTuAskService.js");
  const { RecoveryAssessmentService } = await import("../src/server/RecoveryAssessmentService.js");
  const { RecoveryDebtService } = await import("../src/server/RecoveryDebtService.js");

  const mkOrg = () => {
    const o = `org_${randomUUID().slice(0, 8)}`;
    db.prepare(`INSERT INTO organization_settings (organization_id, business_name, status, vertical) VALUES (?, 'Toulon', 'active', 'moda')`).run(o);
    return o;
  };
  const owner = (org: string) => ({ userId: randomUUID(), email: "dono@toulon.com", role: "owner", organizationId: org });
  const TODAY = "2026-09-11";

  // ── 1. classify PURO reconhece a crise ──
  const cl = (t: string) => FalaTuAskService.classify(t, TODAY);
  check("1.1 'tô no vermelho, e agora?' → financial_recovery", cl("tô no vermelho, e agora?").kind === "financial_recovery");
  check("1.2 'tenho muita dívida atrasada' → financial_recovery", cl("tenho muita dívida atrasada").kind === "financial_recovery");
  check("1.3 'como faço pra recuperar a empresa?' → financial_recovery", cl("como faço pra recuperar a empresa?").kind === "financial_recovery");
  check("1.4 'quanto tempo eu aguento com esse caixa?' → financial_recovery", cl("quanto tempo eu aguento com esse caixa?").kind === "financial_recovery");
  check("1.5 'tô quebrando' → financial_recovery", cl("acho que tô quebrando").kind === "financial_recovery");
  check("1.6 recovery needsMoney=false (não hard-block; redige no answer)", cl("tô no vermelho").needsMoney === false);

  // ── 2. REGRESSÃO: a porta só rouba do open_question ──
  check("2.1 'quanto vendi em dinheiro no dia 31/08/2025' segue cash_on_day", cl("quanto vendi em dinheiro no dia 31/08/2025?").kind === "cash_on_day");
  check("2.2 'faturamento total de ontem' segue sales_on_day", cl("qual o faturamento total de ontem?").kind === "sales_on_day");
  check("2.3 'quem está de folga amanhã' segue who_is_off", cl("quem está de folga amanhã?").kind === "who_is_off");
  check("2.4 'registra a venda de R$500' segue record_sale", cl("registra a venda de R$500").kind === "record_sale");
  check("2.5 'lança a despesa de R$200 com fornecedor' segue record_expense", cl("lança a despesa de R$200 com o fornecedor").kind === "record_expense");
  check("2.6 'por que minhas vendas caíram?' segue open_question (não recovery)", cl("por que minhas vendas caíram esse mês?").kind === "open_question");
  check("2.7 'como estão minhas finanças?' segue open_question (não recovery)", cl("como estão minhas finanças?").kind === "open_question");

  // ── 3. answer() com módulo ON — aterrado no RecoveryPlanService ──
  const ON = mkOrg();
  RecoveryAssessmentService.setEnabled(ON, true);
  RecoveryDebtService.create(ON, { creditor: "Banco X", category: "loan", amountTotal: 50000, amountOverdue: 10000, monthlyPayment: 3000, negotiability: "medium", legalRisk: "high" });

  const rOn = await FalaTuAskService.answer(ON, owner(ON), "tô endividado, como recupero a empresa?");
  check("3.1 ON: kind financial_recovery, grounded", rOn.kind === "financial_recovery" && rOn.grounded === true);
  check("3.2 ON: cita o IRF (n/100)", /IRF/.test(rOn.answer) && /\d+(?:\.\d+)?\/100/.test(rOn.answer));
  check("3.3 ON: cita diagnóstico de crise", /Diagnóstico:/.test(rOn.answer));
  check("3.4 ON: cita o plano ordenado", /plano prioriza/i.test(rOn.answer));
  check("3.5 ON: TEXTO sem R$ (dinheiro só no data)", !/R\$/.test(rOn.answer));
  check("3.6 ON: data.plan presente", !!rOn.data?.plan);
  check("3.7 ON: owner não é restrito (redação, não bloqueio)", rOn.moneyRestricted === false);

  // ── 4. org vazia ON — diagnóstico honesto de baixa confiança (não inventa) ──
  const EMPTY = mkOrg();
  RecoveryAssessmentService.setEnabled(EMPTY, true);
  const rEmpty = await FalaTuAskService.answer(EMPTY, owner(EMPTY), "tô apertado, e agora?");
  check("4.1 vazia: kind financial_recovery, grounded", rEmpty.kind === "financial_recovery" && rEmpty.grounded === true);
  check("4.2 vazia: faixa indefinido (honesto, sem dados)", /indefinido/i.test(rEmpty.answer));
  check("4.3 vazia: sem R$ fabricado no texto", !/R\$/.test(rEmpty.answer));

  // ── 5. dinheiro role-gated (§73) por REDAÇÃO, não bloqueio ──
  check("5.1 owner: data.plan NÃO redigido (vê R$)", rOn.data?.plan?.redacted !== true);
  const vend = { userId: randomUUID(), email: "vend@toulon.com", role: "agent", organizationId: ON };
  const rVend = await FalaTuAskService.answer(ON, vend, "tô endividado, como recupero a empresa?");
  check("5.2 vendedor: MESMO diagnóstico (não bloqueado)", rVend.kind === "financial_recovery" && rVend.moneyRestricted === false);
  check("5.3 vendedor: data.plan REDIGIDO (R$ oculto)", rVend.data?.plan?.redacted === true);
  check("5.4 vendedor: IRF continua visível (diagnóstico não é dinheiro)", /IRF/.test(rVend.answer));
  check("5.5 vendedor: aviso de valores ocultos", /ocultos pelo seu perfil/i.test(rVend.answer));

  // ── 6. módulo OFF (default) → delega ao Diretor IA, NÃO à porta determinística ──
  // (o advisor captura a falta de chave de IA e devolve fallback; a delegação se
  // prova pelo kind retornado = open_question, nunca financial_recovery.)
  const OFF = mkOrg(); // sem setEnabled → flag 0
  check("6.1 OFF: módulo desligado por default", RecoveryAssessmentService.isEnabled(OFF) === false);
  const rOff = await FalaTuAskService.answer(OFF, owner(OFF), "tô no vermelho, como recupero?");
  check("6.2 OFF: delega ao advisor (kind open_question, NÃO a porta F3)", rOff.kind === "open_question");

  // ── 7. isolamento multi-tenant ──
  const B = mkOrg();
  RecoveryAssessmentService.setEnabled(B, true);
  const rB = await FalaTuAskService.answer(B, owner(B), "tô endividado, como recupero?");
  check("7.1 org B não vê a dívida de ON", (rB.data?.plan ? true : false) && !/50\.000/.test(rB.answer));

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} falatu-ask-recovery: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
