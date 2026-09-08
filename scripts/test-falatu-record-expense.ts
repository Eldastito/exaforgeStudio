/**
 * TEST — Fala Tu registra DESPESA por comando GOVERNADO (F5, opção a).
 * Prova que "lança a despesa de R$X com fornecedor Y" NÃO escreve direto: vira
 * proposta governada (awaiting_approval) e só grava no `payables` após aprovação
 * + execução (DecisionAction → ApprovalPolicy → CommandExecutor).
 *   - classify detecta despesa (palavra + pista de valor); não confunde com
 *     pergunta ("quanto gastei?") nem com dia solto ("conta a pagar do dia 5").
 *   - parseAmountBRL: R$, milhar pt-BR, decimal.
 *   - converse(owner) → propõe finance/falatu_record_expense awaiting_approval,
 *     payload correto, e NADA em payables ainda.
 *   - approve → execute → payable criado (amount/supplier/status open).
 *   - despesa sem valor → não propõe (não inventa).
 *   - RBAC §73: colaborador não propõe despesa (moneyRestricted).
 *   - isolamento multi-tenant.
 *
 * Uso: npm run test:falatu-record-expense
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-falatu-exp-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-falatu-exp-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { FalaTuAskService } = await import("../src/server/FalaTuAskService.js");
  const { FalatuRecordService, parseAmountBRL } = await import("../src/server/FalatuRecordService.js");
  const { FalaTuService } = await import("../src/server/FalaTuService.js");
  const { DecisionActionService } = await import("../src/server/DecisionActionService.js");
  const { CommandExecutorService } = await import("../src/server/CommandExecutorService.js");

  const mkOrg = () => {
    const o = `org_${randomUUID().slice(0, 8)}`;
    db.prepare(`INSERT INTO organization_settings (organization_id, business_name, status, vertical) VALUES (?, 'Toulon', 'active', 'moda')`).run(o);
    FalaTuService.setOrgEnabled(o, true);
    return o;
  };
  const A = mkOrg();
  const owner = { userId: randomUUID(), email: "dono@toulon.com", role: "owner", organizationId: A };
  const payablesCount = (org: string) => Number((db.prepare(`SELECT COUNT(*) AS n FROM payables WHERE organization_id = ?`).get(org) as any)?.n || 0);

  // ── 1. classify ──
  check("1.1 despesa c/ valor → record_expense", FalaTuAskService.classify("lança a despesa de R$200 com fornecedor Padaria", "2026-09-08").kind === "record_expense");
  check("1.2 'quanto gastei?' NÃO é record_expense", FalaTuAskService.classify("quanto gastei esse mês?", "2026-09-08").kind !== "record_expense");
  check("1.3 'conta a pagar do dia 5' NÃO é record_expense (dígito solto)", FalaTuAskService.classify("conta a pagar do dia 5", "2026-09-08").kind !== "record_expense");
  check("1.4 despesa needsMoney=true", FalaTuAskService.classify("paguei R$50 de luz", "2026-09-08").needsMoney === true);

  // ── 2. parseAmountBRL ──
  check("2.1 R$200 → 200", parseAmountBRL("lança a despesa de R$200") === 200);
  check("2.2 R$ 1.500,50 → 1500.5", parseAmountBRL("despesa de R$ 1.500,50") === 1500.5);
  check("2.3 1500,50 → 1500.5", parseAmountBRL("gastei 1500,50 na feira") === 1500.5);
  check("2.4 R$ 1.500 → 1500 (milhar)", parseAmountBRL("despesa de R$ 1.500 com fornecedor") === 1500);
  check("2.5 sem valor → null", parseAmountBRL("lança a despesa com a padaria") === null);

  // ── 3. converse(owner) → proposta governada ──
  const r1 = await FalaTuAskService.converse(A, owner, "lança a despesa de R$1.500,50 com o fornecedor Padaria Central");
  check("3.1 kind record_expense", r1.kind === "record_expense");
  check("3.2 devolve actionId + awaitingApproval", !!r1.data?.actionId && r1.data?.awaitingApproval === true);
  const action = DecisionActionService.get(A, r1.data!.actionId);
  check("3.3 ação awaiting_approval (não grava sozinho)", action?.status === "awaiting_approval");
  check("3.4 domain finance / action_type falatu_record_expense", action?.domain === "finance" && action?.action_type === "falatu_record_expense");
  check("3.5 payload: valor 1500.5", action?.command_payload?.amount === 1500.5);
  check("3.6 payload: fornecedor capturado", /Padaria/.test(String(action?.command_payload?.supplierName || "")));
  check("3.7 NADA em payables ainda", payablesCount(A) === 0);

  // ── 4. approve → execute → payable criado ──
  DecisionActionService.approve(A, r1.data!.actionId, owner.userId, { reason: "ok" });
  check("4.1 ação aprovada", DecisionActionService.get(A, r1.data!.actionId)?.status === "approved");
  await CommandExecutorService.execute(A, r1.data!.actionId);
  const pay = db.prepare(`SELECT * FROM payables WHERE organization_id = ?`).get(A) as any;
  check("4.2 payable criado", payablesCount(A) === 1);
  check("4.3 payable valor 1500.5, status open", pay && Math.round(pay.amount * 100) / 100 === 1500.5 && pay.status === "open");
  check("4.4 payable fornecedor gravado", /Padaria/.test(String(pay?.supplier_name || "")));

  // ── 5. despesa sem valor → não propõe ──
  const before = payablesCount(A);
  const r2 = await FalaTuAskService.converse(A, owner, "lança a despesa de uns reais com a padaria");
  check("5.1 sem valor → não propõe, pede o valor", r2.kind === "record_expense" && !r2.data?.actionId && /não peguei o valor/i.test(r2.answer));
  check("5.2 nada gravado nem proposto a mais", payablesCount(A) === before);

  // ── 6. RBAC §73 — colaborador não propõe despesa ──
  const vend = { userId: randomUUID(), role: "agent", organizationId: A };
  const openBefore = Number((db.prepare(`SELECT COUNT(*) AS n FROM decision_actions WHERE organization_id = ? AND action_type='falatu_record_expense'`).get(A) as any).n);
  const r3 = await FalaTuAskService.converse(A, vend, "lança a despesa de R$200 com a padaria");
  check("6.1 colaborador → restrito (não vaza/lança)", r3.moneyRestricted === true);
  check("6.2 colaborador não criou ação", Number((db.prepare(`SELECT COUNT(*) AS n FROM decision_actions WHERE organization_id = ? AND action_type='falatu_record_expense'`).get(A) as any).n) === openBefore);

  // ── 7. isolamento ──
  const B = mkOrg();
  const ownerB = { userId: randomUUID(), role: "owner", organizationId: B };
  await FalaTuAskService.converse(B, ownerB, "lança a despesa de R$50 com fornecedor X");
  check("7.1 org B não tocou payables de A", payablesCount(A) === 1);
  check("7.2 org B tem sua própria ação (isolada, ainda não executada)", payablesCount(B) === 0);

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} falatu-record-expense: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
