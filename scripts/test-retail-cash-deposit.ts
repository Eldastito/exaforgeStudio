/**
 * TESTE — Malote / controle de depósito do dinheiro (CASH-001).
 *
 * Pedido do lojista: cada loja acumula o DINHEIRO do dia (que vem do
 * fechamento) e o gerente deposita no banco, registrando valor/data/quem +
 * comprovante. O dono confere: entrou × depositado, saldo em caixa a depositar.
 *
 * Uso:  npm run test:retail-cash-deposit
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-cash-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-cash-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }
const near = (a: any, b: number) => Math.abs(Number(a) - b) < 0.02;

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { RetailStoreService } = await import("../src/server/RetailStoreService.js");
  const { RetailClosingService } = await import("../src/server/RetailOpsService.js");
  const { RetailCashDepositService: Cash } = await import("../src/server/RetailCashDepositService.js");
  const { RetailStoreScopeService } = await import("../src/server/RetailStoreScopeService.js");

  const A = `org_A_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), A);
  const store = RetailStoreService.create(A, { name: "Av Brasil", code: "1" }).id;

  // Dinheiro do dia vem do fechamento (item 'dinheiro'): dia 02 = 79,90; 06 = 89,90.
  RetailClosingService.submitDetailed(A, store, "2026-08-02", { dinheiro: 79.90 });
  RetailClosingService.submitDetailed(A, store, "2026-08-06", { dinheiro: 89.90 });

  // Depósito no dia 03 (o gerente depositou os 79,90 → 80,00) com comprovante.
  const dep = Cash.registerDeposit(A, store, { date: "2026-08-03", amount: 80, depositor: "Arthur", receiptUrl: "/media/x.jpg" });
  check("0.1 depósito registrado", !!(dep as any)?.id);

  const led = Cash.monthLedger(A, store, "2026-08");
  const byDate = new Map<string, any>(led.rows.map((r: any) => [r.date, r]));
  const d2: any = byDate.get("2026-08-02"), d3: any = byDate.get("2026-08-03"), d6: any = byDate.get("2026-08-06");

  // ===== 1. dinheiro do dia (do fechamento) =====
  check("1.1 dia 02 dinheiro = 79,90 (do fechamento)", near(d2.cash, 79.90) && d2.cashSource === "fechamento", `${d2?.cash}/${d2?.cashSource}`);
  check("1.2 dia 06 dinheiro = 89,90", near(d6.cash, 89.90));
  check("1.3 dia sem fechamento → 0", near(byDate.get("2026-08-05")?.cash, 0));

  // ===== 2. saldo corrente (em caixa a depositar) =====
  check("2.1 saldo dia 02 = 79,90", near(d2.saldo, 79.90), `${d2?.saldo}`);
  check("2.2 saldo dia 03 = -0,10 (79,90 - 80 depositado)", near(d3.saldo, -0.10), `${d3?.saldo}`);
  check("2.3 depósito aparece no dia 03", d3.deposits.length === 1 && near(d3.deposits[0].amount, 80) && d3.deposits[0].receiptUrl === "/media/x.jpg");
  check("2.4 saldo dia 06 = 89,80 (-0,10 + 89,90)", near(d6.saldo, 89.80), `${d6?.saldo}`);

  // ===== 3. conferência (totais do mês) =====
  check("3.1 total entrou = 169,80", near(led.totalCash, 169.80), `${led.totalCash}`);
  check("3.2 total depositado = 80", near(led.totalDeposited, 80), `${led.totalDeposited}`);
  check("3.3 saldo final (em caixa a depositar) = 89,80", near(led.saldoFinal, 89.80), `${led.saldoFinal}`);
  check("3.4 lista de depósitos do mês = 1", led.deposits.length === 1);

  // ===== 4. ajuste manual do dia (override) =====
  Cash.setDayOverride(A, store, "2026-08-02", 100);
  const led2 = Cash.monthLedger(A, store, "2026-08");
  const d2b: any = led2.rows.find((r: any) => r.date === "2026-08-02");
  check("4.1 override: dia 02 vira 100 (source ajuste)", near(d2b.cash, 100) && d2b.cashSource === "ajuste", `${d2b?.cash}/${d2b?.cashSource}`);
  check("4.2 override muda o total entrou = 189,90", near(led2.totalCash, 189.90), `${led2.totalCash}`);
  Cash.setDayOverride(A, store, "2026-08-02", null); // limpa
  check("4.3 limpar override volta pro fechamento (79,90)", near(Cash.monthLedger(A, store, "2026-08").totalCash, 169.80));

  // ===== 5. virada de mês: saldo inicial carrega o mês anterior =====
  RetailClosingService.submitDetailed(A, store, "2026-07-20", { dinheiro: 50 }); // julho, sem depósito
  const led3 = Cash.monthLedger(A, store, "2026-08");
  check("5.1 saldo inicial de agosto = 50 (dinheiro de julho não depositado)", near(led3.saldoInicial, 50), `${led3.saldoInicial}`);
  check("5.2 saldo final de agosto = 139,80 (50 + 169,80 - 80)", near(led3.saldoFinal, 139.80), `${led3.saldoFinal}`);

  // ===== 6. excluir depósito =====
  check("6.1 remove depósito", Cash.removeDeposit(A, (dep as any).id) === true);
  check("6.2 depósito sumiu do mês", Cash.monthLedger(A, store, "2026-08").deposits.length === 0);
  check("6.3 remove de id inexistente → false", Cash.removeDeposit(A, randomUUID()) === false);

  // ===== 7. FECHAMENTO SEMANAL travado (Fatia 4) =====
  const store2 = RetailStoreService.create(A, { name: "Loja 2", code: "9" }).id;
  RetailClosingService.submitDetailed(A, store2, "2026-08-04", { dinheiro: 100 });
  RetailClosingService.submitDetailed(A, store2, "2026-08-05", { dinheiro: 50 });
  const dep2 = Cash.registerDeposit(A, store2, { date: "2026-08-05", amount: 120, depositor: "Bia" });
  check("7.1 antes de fechar: semana NÃO está travada", Cash.isWeekClosed(A, store2, "2026-08-04") === false);
  const wk = Cash.closeWeek(A, store2, { weekStart: "2026-08-01", weekEnd: "2026-08-08", depositor: "Bia" }) as any;
  check("7.2 fecha a semana com snapshot: dinheiro 150", near(wk.total_cash, 150), `${wk?.total_cash}`);
  check("7.3 snapshot depositado = 120", near(wk.total_deposited, 120), `${wk?.total_deposited}`);
  check("7.4 dia dentro da semana fica travado", Cash.isWeekClosed(A, store2, "2026-08-04") === true);
  check("7.5 dia fora da semana NÃO trava", Cash.isWeekClosed(A, store2, "2026-08-10") === false);
  let threw = false; try { Cash.setDayOverride(A, store2, "2026-08-04", 999); } catch (e: any) { threw = e?.message === "week_closed"; }
  check("7.6 ajuste de dia em semana fechada é BLOQUEADO", threw);
  threw = false; try { Cash.registerDeposit(A, store2, { date: "2026-08-06", amount: 10 }); } catch (e: any) { threw = e?.message === "week_closed"; }
  check("7.7 novo depósito em semana fechada é BLOQUEADO", threw);
  threw = false; try { Cash.removeDeposit(A, (dep2 as any).id); } catch (e: any) { threw = e?.message === "week_closed"; }
  check("7.8 excluir depósito de semana fechada é BLOQUEADO", threw);
  threw = false; try { Cash.closeWeek(A, store2, { weekStart: "2026-08-01", weekEnd: "2026-08-08" }); } catch (e: any) { threw = e?.message === "week_already_closed"; }
  check("7.9 refechar a MESMA semana é BLOQUEADO (idempotência dura)", threw);
  const lw = Cash.monthLedger(A, store2, "2026-08");
  check("7.10 ledger marca o dia como locked", lw.rows.find((r: any) => r.date === "2026-08-04")?.locked === true);
  check("7.11 ledger: dia fora da semana não locked", lw.rows.find((r: any) => r.date === "2026-08-10")?.locked === false);
  check("7.12 ledger expõe as semanas fechadas", Array.isArray(lw.weekClosings) && lw.weekClosings.length === 1 && lw.weekClosings[0].weekStart === "2026-08-01");
  check("7.13 reabrir a semana (dono) destrava", Cash.reopenWeek(A, store2, "2026-08-01") === true);
  check("7.14 após reabrir, semana NÃO está travada", Cash.isWeekClosed(A, store2, "2026-08-04") === false);
  let ok2 = true; try { Cash.setDayOverride(A, store2, "2026-08-04", 999); } catch { ok2 = false; }
  check("7.15 após reabrir, ajuste volta a funcionar", ok2);
  check("7.16 reabrir semana inexistente → false", Cash.reopenWeek(A, store2, "2026-01-01") === false);
  // Isolamento: fechar a semana da loja 1 não afeta a loja 2.
  Cash.closeWeek(A, store, { weekStart: "2026-08-01", weekEnd: "2026-08-08" });
  check("7.17 isolamento por loja: loja 2 segue destravada", Cash.isWeekClosed(A, store2, "2026-08-04") === false && Cash.isWeekClosed(A, store, "2026-08-04") === true);

  // ===== 8. permissão: gerente = lotado na loja (user_stores) =====
  const ger = randomUUID(); // um "gerente" (userId)
  RetailStoreScopeService.setForUser(A, ger, [store2]);
  check("8.1 gerente lotado é reconhecido na SUA loja", RetailStoreScopeService.isAssignedTo(A, ger, store2) === true);
  check("8.2 gerente NÃO gerencia loja de que não é lotado", RetailStoreScopeService.isAssignedTo(A, ger, store) === false);
  check("8.3 gerente tem alguma lotação", RetailStoreScopeService.hasAnyAssignment(A, ger) === true);
  check("8.4 usuário sem lotação → não é gerente de nada", RetailStoreScopeService.hasAnyAssignment(A, randomUUID()) === false);

  // ===== 9. MALOTE AUTOMÁTICO: despesas descontam do dinheiro (MAL-001) =====
  // O caso do áudio da cliente: R$ 200 em dinheiro, despesa de água/passagem
  // R$ 32 → o malote do dia é 168 SEM ajuste manual. E 159,90 − 158,80 = 1,10.
  const store3 = RetailStoreService.create(A, { name: "Carioca", code: "3" }).id;
  RetailClosingService.submitDetailed(A, store3, "2026-08-12", { dinheiro: 200, despesas: [{ descricao: "água", valor: 20 }, { descricao: "passagem", valor: 12 }] });
  RetailClosingService.submitDetailed(A, store3, "2026-08-13", { dinheiro: 159.90, despesas: [{ descricao: "cartucho e água", valor: 158.80 }] });
  const led9 = Cash.monthLedger(A, store3, "2026-08");
  const d12: any = led9.rows.find((r: any) => r.date === "2026-08-12");
  const d13: any = led9.rows.find((r: any) => r.date === "2026-08-13");
  check("9.1 dia 12: dinheiro líquido = 168 (200 − 32 de despesas)", near(d12.cash, 168), `${d12?.cash}`);
  check("9.2 dia 12 expõe a conta: bruto 200 / despesas 32", near(d12.cashGross, 200) && near(d12.cashDespesas, 32), `${d12?.cashGross}/${d12?.cashDespesas}`);
  check("9.3 dia 13: 159,90 − 158,80 = 1,10", near(d13.cash, 1.10), `${d13?.cash}`);
  check("9.4 total entrou do mês já é líquido = 169,10", near(led9.totalCash, 169.10), `${led9.totalCash}`);
  check("9.5 saldo dia 13 = 169,10 (nada depositado)", near(d13.saldo, 169.10), `${d13?.saldo}`);
  // derived: a conta automática gravada no fechamento + gap da folha divergente
  const c12 = RetailClosingService.listByDate(A, "2026-08-12").find((c: any) => c.store_id === store3);
  const det12 = JSON.parse((c12 as any).details_json);
  check("9.6 derived.maloteEsperado = 168", near(det12?.derived?.maloteEsperado, 168), `${det12?.derived?.maloteEsperado}`);
  RetailClosingService.submitDetailed(A, store3, "2026-08-14", { dinheiro: 100, despesas: [{ descricao: "x", valor: 40 }], malote: "50,00" });
  const c14 = RetailClosingService.listByDate(A, "2026-08-14").find((c: any) => c.store_id === store3);
  const det14 = JSON.parse((c14 as any).details_json);
  check("9.7 maloteGap acusa folha divergente (50 − 60 = −10)", near(det14?.derived?.maloteGap, -10), `${det14?.derived?.maloteGap}`);
  // virada de mês: o saldo inicial carrega o LÍQUIDO acumulado
  check("9.8 saldo inicial de setembro = líquido de agosto (229,10)", near(Cash.monthLedger(A, store3, "2026-09").saldoInicial, 229.10), `${Cash.monthLedger(A, store3, "2026-09").saldoInicial}`);
  // override continua mandando — substitui o líquido do dia
  Cash.setDayOverride(A, store3, "2026-08-12", 170);
  check("9.9 override substitui o líquido do dia (170)", near(Cash.monthLedger(A, store3, "2026-08").rows.find((r: any) => r.date === "2026-08-12")?.cash, 170));
  check("9.10 virada com override: saldo inicial de setembro = 231,10", near(Cash.monthLedger(A, store3, "2026-09").saldoInicial, 231.10), `${Cash.monthLedger(A, store3, "2026-09").saldoInicial}`);
  Cash.setDayOverride(A, store3, "2026-08-12", null);
  // fechamento semanal congela o snapshot já com o líquido
  const wk9 = Cash.closeWeek(A, store3, { weekStart: "2026-08-10", weekEnd: "2026-08-16", depositor: "Gerente" }) as any;
  check("9.11 snapshot da semana fechada = dinheiro líquido (229,10)", near(wk9?.total_cash, 229.10), `${wk9?.total_cash}`);

  console.log("\n=== TEST: Malote / depósito do dinheiro ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
