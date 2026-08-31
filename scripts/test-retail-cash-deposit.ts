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

  console.log("\n=== TEST: Malote / depósito do dinheiro ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
