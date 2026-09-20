/**
 * TESTE — RETIRADA de malote distinta do DEPÓSITO bancário (CASH-002).
 *
 * Caso Av. Brasil (pedido da dona, 20/09/2026): a loja NÃO deposita no banco —
 * o dono/portador pega o dinheiro em mão toda semana. Antes, sem registrar a
 * saída, o "em caixa a depositar" acumulava pra sempre. Agora a RETIRADA é
 * primeira classe: baixa o caixa IGUAL ao depósito, mas fica SEPARADA no
 * relatório (banco × mão), nunca misturada (RN-I-003).
 *
 * Uso:  npm run test:retail-cash-withdrawal
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-cashwd-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-cashwd-1234567890";

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

  // ===== 1. RETIRADA baixa o caixa igual ao depósito =====
  RetailClosingService.submitDetailed(A, store, "2026-08-02", { dinheiro: 100 });
  RetailClosingService.submitDetailed(A, store, "2026-08-06", { dinheiro: 50 });
  const ret = Cash.registerDeposit(A, store, { date: "2026-08-03", amount: 100, depositor: "Carlos", kind: "retirada" });
  check("1.1 retirada registrada com kind='retirada'", (ret as any)?.id && (ret as any)?.kind === "retirada", (ret as any)?.kind);
  const led = Cash.monthLedger(A, store, "2026-08");
  const byDate = new Map<string, any>(led.rows.map((r: any) => [r.date, r]));
  const d3: any = byDate.get("2026-08-03"), d6: any = byDate.get("2026-08-06");
  check("1.2 saldo dia 03 = 0 (100 entrou − 100 retirado)", near(d3.saldo, 0), `${d3?.saldo}`);
  check("1.3 a baixa aparece no dia 03 marcada como retirada", d3.deposits.length === 1 && d3.deposits[0].kind === "retirada" && near(d3.deposits[0].amount, 100));
  check("1.4 saldo dia 06 = 50 (0 + 50)", near(d6.saldo, 50), `${d6?.saldo}`);

  // ===== 2. totais SEPARADOS (banco × mão), nunca misturados =====
  check("2.1 totalDeposited = 0 (não houve depósito bancário)", near(led.totalDeposited, 0), `${led.totalDeposited}`);
  check("2.2 totalWithdrawn = 100 (a retirada)", near(led.totalWithdrawn, 100), `${led.totalWithdrawn}`);
  check("2.3 saldoFinal = 50 (150 entrou − 0 dep − 100 ret)", near(led.saldoFinal, 50), `${led.saldoFinal}`);

  // ===== 3. depósito e retirada CONVIVEM no mesmo mês, cada um no seu total ==
  Cash.registerDeposit(A, store, { date: "2026-08-06", amount: 30, depositor: "Bia", kind: "deposito" });
  const led2 = Cash.monthLedger(A, store, "2026-08");
  check("3.1 depósito soma só em totalDeposited", near(led2.totalDeposited, 30) && near(led2.totalWithdrawn, 100), `${led2.totalDeposited}/${led2.totalWithdrawn}`);
  check("3.2 saldoFinal = 20 (150 − 30 − 100)", near(led2.saldoFinal, 20), `${led2.saldoFinal}`);
  const d6b: any = led2.rows.find((r: any) => r.date === "2026-08-06");
  check("3.3 dia 06 tem as duas baixas (dep + nada retirada nesse dia)", d6b.deposits.length === 1 && d6b.deposits[0].kind === "deposito");

  // ===== 4. virada de mês: retirada também carrega o saldo inicial =====
  const led3 = Cash.monthLedger(A, store, "2026-09");
  check("4.1 saldo inicial de setembro = 20 (retirada baixou o acumulado)", near(led3.saldoInicial, 20), `${led3.saldoInicial}`);

  // ===== 5. kind default = 'deposito' (legado / sem passar kind) =====
  const store2 = RetailStoreService.create(A, { name: "Carioca", code: "2" }).id;
  RetailClosingService.submitDetailed(A, store2, "2026-08-02", { dinheiro: 200 });
  const legacy = Cash.registerDeposit(A, store2, { date: "2026-08-03", amount: 200 }); // sem kind
  check("5.1 sem kind → 'deposito' (0-regressão)", (legacy as any)?.kind === "deposito", (legacy as any)?.kind);
  const led5 = Cash.monthLedger(A, store2, "2026-08");
  check("5.2 loja só-depósito: totalWithdrawn = 0", near(led5.totalWithdrawn, 0), `${led5.totalWithdrawn}`);
  check("5.3 loja só-depósito: totalDeposited = 200", near(led5.totalDeposited, 200), `${led5.totalDeposited}`);

  // ===== 6. kind inválido cai pra 'deposito' (RN: só 2 valores) =====
  const bad = Cash.registerDeposit(A, store2, { date: "2026-08-04", amount: 10, kind: "xpto" as any });
  check("6.1 kind inválido normaliza pra 'deposito'", (bad as any)?.kind === "deposito", (bad as any)?.kind);

  // ===== 7. closeWeek separa o snapshot (banco × mão) =====
  const store3 = RetailStoreService.create(A, { name: "Grande Rio", code: "3" }).id;
  RetailClosingService.submitDetailed(A, store3, "2026-08-04", { dinheiro: 300 });
  Cash.registerDeposit(A, store3, { date: "2026-08-05", amount: 120, kind: "deposito" });
  Cash.registerDeposit(A, store3, { date: "2026-08-05", amount: 180, kind: "retirada" });
  const wk = Cash.closeWeek(A, store3, { weekStart: "2026-08-01", weekEnd: "2026-08-08", depositor: "Gerente" }) as any;
  check("7.1 snapshot dinheiro = 300", near(wk.total_cash, 300), `${wk?.total_cash}`);
  check("7.2 snapshot depositado = 120 (só banco)", near(wk.total_deposited, 120), `${wk?.total_deposited}`);
  check("7.3 snapshot retirado = 180 (só mão)", near(wk.total_withdrawn, 180), `${wk?.total_withdrawn}`);
  const lw = Cash.monthLedger(A, store3, "2026-08");
  check("7.4 weekClosings expõe totalWithdrawn", lw.weekClosings[0]?.totalWithdrawn != null && near(lw.weekClosings[0].totalWithdrawn, 180));

  // ===== 8. o cenário exato da dona: sem baixa, o caixa acumula; UMA retirada zera =
  const store4 = RetailStoreService.create(A, { name: "Loja acúmulo", code: "4" }).id;
  RetailClosingService.submitDetailed(A, store4, "2026-06-10", { dinheiro: 1000 }); // meses sem baixa
  RetailClosingService.submitDetailed(A, store4, "2026-07-10", { dinheiro: 1000 });
  RetailClosingService.submitDetailed(A, store4, "2026-08-10", { dinheiro: 500 });
  const acc = Cash.monthLedger(A, store4, "2026-08");
  check("8.1 sem baixa: em caixa acumula (2500)", near(acc.saldoFinal, 2500), `${acc.saldoFinal}`);
  // Registra a retirada do acumulado que o Carlos já levou → zera.
  Cash.registerDeposit(A, store4, { date: "2026-08-11", amount: 2500, depositor: "Carlos (acerto)", kind: "retirada" });
  const acc2 = Cash.monthLedger(A, store4, "2026-08");
  check("8.2 após a retirada do acumulado, em caixa = 0", near(acc2.saldoFinal, 0), `${acc2.saldoFinal}`);
  check("8.3 e a retirada aparece no total de mão (2500)", near(acc2.totalWithdrawn, 2500), `${acc2.totalWithdrawn}`);

  // ===== 9. isolamento multi-tenant =====
  const B = `org_B_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Y', 'active')`).run(randomUUID(), B);
  const storeB = RetailStoreService.create(B, { name: "Outra", code: "1" }).id;
  const ledB = Cash.monthLedger(B, storeB, "2026-08");
  check("9.1 org B não vê retirada de A", near(ledB.totalWithdrawn, 0) && near(ledB.saldoFinal, 0));

  console.log("\n=== TEST: Retirada de malote (mão) × depósito (banco) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
