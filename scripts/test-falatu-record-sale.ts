/**
 * TEST — Fala Tu registra VENDA por comando GOVERNADO (F6, opção a).
 * "registra a venda de R$500" NÃO escreve direto: proposta governada
 * (awaiting_approval) → aprovação + execução → ENTRADA de caixa (cash_events).
 *   - classify detecta venda por VERBO (vendi/faturei/"registra a venda") + valor;
 *     NÃO confunde com a pergunta "quanto vendi em dinheiro..." (cash_on_day) nem
 *     "quanto foi o faturamento..." (sales_on_day) — pergunta nunca vira registro.
 *   - converse(owner) → propõe finance/falatu_record_sale, nada em cash_events.
 *   - approve → execute → cash_event 'in' + saldo do caixa sobe.
 *   - sem valor → não propõe; RBAC colaborador barrado; isolamento.
 *
 * Uso: npm run test:falatu-record-sale
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-falatu-sale-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-falatu-sale-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { FalaTuAskService } = await import("../src/server/FalaTuAskService.js");
  const { FalaTuService } = await import("../src/server/FalaTuService.js");
  const { FinancialLedgerService } = await import("../src/server/FinancialLedgerService.js");
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
  const cashEventsIn = (org: string) => Number((db.prepare(`SELECT COUNT(*) AS n FROM cash_events WHERE organization_id = ? AND direction='in'`).get(org) as any)?.n || 0);

  // ── 1. classify ──
  check("1.1 'registra a venda de R$500' → record_sale", FalaTuAskService.classify("registra a venda de R$500", "2026-09-08").kind === "record_sale");
  check("1.2 'vendi 1200 hoje' → record_sale", FalaTuAskService.classify("vendi 1200 hoje", "2026-09-08").kind === "record_sale");
  check("1.3 pergunta 'quanto vendi em dinheiro no dia 31 de agosto de 2025?' → cash_on_day (não venda)", FalaTuAskService.classify("quanto vendi em dinheiro no dia 31 de agosto de 2025?", "2026-09-08").kind === "cash_on_day");
  check("1.4 pergunta 'quanto foi o faturamento do dia 31/08?' → sales_on_day (não venda)", FalaTuAskService.classify("quanto foi o faturamento do dia 31/08?", "2026-09-08").kind === "sales_on_day");
  check("1.5 venda needsMoney=true", FalaTuAskService.classify("vendi R$500", "2026-09-08").needsMoney === true);

  // ── 2. converse(owner) → proposta governada ──
  const r1 = await FalaTuAskService.converse(A, owner, "registra a venda de R$500 hoje");
  check("2.1 kind record_sale", r1.kind === "record_sale");
  check("2.2 actionId + awaitingApproval", !!r1.data?.actionId && r1.data?.awaitingApproval === true);
  const action = DecisionActionService.get(A, r1.data!.actionId);
  check("2.3 awaiting_approval (não grava sozinho)", action?.status === "awaiting_approval");
  check("2.4 finance / falatu_record_sale", action?.domain === "finance" && action?.action_type === "falatu_record_sale");
  check("2.5 payload valor 500", action?.command_payload?.amount === 500);
  check("2.6 NADA em cash_events ainda", cashEventsIn(A) === 0);

  // ── 3. approve → execute → entrada de caixa ──
  DecisionActionService.approve(A, r1.data!.actionId, owner.userId, { reason: "ok" });
  check("3.1 aprovada", DecisionActionService.get(A, r1.data!.actionId)?.status === "approved");
  const cashBefore = FinancialLedgerService.cashOnHand(A);
  await CommandExecutorService.execute(A, r1.data!.actionId);
  const ev = db.prepare(`SELECT * FROM cash_events WHERE organization_id = ? AND direction='in'`).get(A) as any;
  check("3.2 cash_event 'in' criado", cashEventsIn(A) === 1);
  check("3.3 valor 500, source falatu_sale", ev && Math.round(ev.amount * 100) / 100 === 500 && ev.source_type === "falatu_sale");
  check("3.4 saldo do caixa subiu 500", Math.round((FinancialLedgerService.cashOnHand(A) - cashBefore) * 100) / 100 === 500);

  // ── 4. sem valor → não propõe ──
  const r2 = await FalaTuAskService.converse(A, owner, "registra a venda de uns reais");
  check("4.1 sem valor → pede o valor, não propõe", r2.kind === "record_sale" && !r2.data?.actionId && /não peguei o valor/i.test(r2.answer));

  // ── 5. RBAC §73 — colaborador não registra venda ──
  const vend = { userId: randomUUID(), role: "agent", organizationId: A };
  const r3 = await FalaTuAskService.converse(A, vend, "vendi R$300 agora");
  check("5.1 colaborador → restrito", r3.moneyRestricted === true);
  check("5.2 colaborador não criou cash_event", cashEventsIn(A) === 1);

  // ── 6. isolamento ──
  const B = mkOrg();
  const ownerB = { userId: randomUUID(), role: "owner", organizationId: B };
  await FalaTuAskService.converse(B, ownerB, "registra a venda de R$99");
  check("6.1 org B não tocou o caixa de A", cashEventsIn(A) === 1);
  check("6.2 org B ainda não executou (só proposta)", cashEventsIn(B) === 0);

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} falatu-record-sale: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
