/**
 * TESTE — 20/09/2026: fechamento de PERÍODO livre no Malote.
 * -----------------------------------------------------------------------------
 * Caso real Toulon: o malote da loja vai ao banco uma vez por semana num DIA
 * VARIÁVEL (ex.: depósito no dia 8 cobre do dia 1 ao 8) — a semana fixa de
 * calendário não representa o ciclo real. O `closeWeek` já aceitava intervalo
 * arbitrário; o que faltava era a UI e a garantia de que períodos não se
 * SOBREPÕEM (reabrir é por week_start; sobreposição deixaria dia meio-travado).
 *
 * Uso: npm run test:retail-cash-period-close
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-period-close-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-period-close-1234567890";
process.env.ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { RetailStoreService } = await import("../src/server/RetailStoreService.js");
  const { RetailClosingService } = await import("../src/server/RetailOpsService.js");
  const { RetailCashDepositService: Cash } = await import("../src/server/RetailCashDepositService.js");

  const A = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'A', 'active')`).run(randomUUID(), A);
  const store = RetailStoreService.create(A, { name: "Av. Brasil", code: "1082" }).id;

  // Movimento: dinheiro nos dias 2 e 5, depósito no dia 8 (o ciclo real).
  RetailClosingService.submitDetailed(A, store, "2026-08-02", { dinheiro: 300 });
  RetailClosingService.submitDetailed(A, store, "2026-08-05", { dinheiro: 200 });
  Cash.registerDeposit(A, store, { date: "2026-08-08", amount: 500, depositor: "Bia" });

  // ── 1) Período LIVRE (dia 1 → dia 8, não é semana de calendário). ──
  const p1 = Cash.closeWeek(A, store, { weekStart: "2026-08-01", weekEnd: "2026-08-08", depositor: "Bia" }) as any;
  check("1.1 fecha o período 01→08 com snapshot (dinheiro 500)", Number(p1?.total_cash) === 500, String(p1?.total_cash));
  check("1.2 snapshot do depositado (500)", Number(p1?.total_deposited) === 500, String(p1?.total_deposited));
  check("1.3 dia DENTRO do período fica travado", Cash.isWeekClosed(A, store, "2026-08-05") === true);
  check("1.4 dia FORA segue livre", Cash.isWeekClosed(A, store, "2026-08-09") === false);

  // ── 2) Sobreposição é recusada (um dia nunca pertence a DOIS fechamentos). ──
  let err = "";
  try { Cash.closeWeek(A, store, { weekStart: "2026-08-05", weekEnd: "2026-08-12" }); } catch (e: any) { err = e.message; }
  check("2.1 período que ENCOSTA no fechado é recusado", err.includes("sobrep"), err);
  err = "";
  try { Cash.closeWeek(A, store, { weekStart: "2026-08-01", weekEnd: "2026-08-08" }); } catch (e: any) { err = e.message; }
  check("2.2 refechar o MESMO período mantém o erro antigo", err === "week_already_closed", err);
  err = "";
  try { Cash.closeWeek(A, store, { weekStart: "2026-07-28", weekEnd: "2026-08-03" }); } catch (e: any) { err = e.message; }
  check("2.3 sobreposição parcial por trás também é recusada", err.includes("sobrep"), err);

  // ── 3) Período ADJACENTE (09→15) fecha normal — ciclo contínuo sem buraco. ──
  const p2 = Cash.closeWeek(A, store, { weekStart: "2026-08-09", weekEnd: "2026-08-15" }) as any;
  check("3.1 período seguinte (09→15) fecha sem conflito", !!p2?.id);
  check("3.2 ledger expõe os DOIS períodos", (Cash.monthLedger(A, store, "2026-08").weekClosings || []).length === 2);

  // ── 4) Depósito/ajuste no período fechado seguem bloqueados (invariante). ──
  err = "";
  try { Cash.registerDeposit(A, store, { date: "2026-08-03", amount: 10 }); } catch (e: any) { err = e.message; }
  check("4.1 depósito dentro do período fechado é bloqueado", err === "week_closed", err);
  const depOk = Cash.registerDeposit(A, store, { date: "2026-08-20", amount: 10 });
  check("4.2 depósito fora dos períodos fechados funciona", !!(depOk as any)?.id);

  // ── 5) Reabrir o período personalizado destrava e permite refechar certo. ──
  check("5.1 reabrir o 01→08 destrava", Cash.reopenWeek(A, store, "2026-08-01") === true);
  check("5.2 dia 05 destravado", Cash.isWeekClosed(A, store, "2026-08-05") === false);
  const p3 = Cash.closeWeek(A, store, { weekStart: "2026-08-01", weekEnd: "2026-08-07" }) as any;
  check("5.3 refechar com o intervalo corrigido (01→07) funciona", !!p3?.id);

  // ── 6) Isolamento multi-tenant/loja. ──
  const B = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'B', 'active')`).run(randomUUID(), B);
  const storeB = RetailStoreService.create(B, { name: "Outra", code: "1082" }).id;
  check("6.1 org B com mesmo código segue destravada", Cash.isWeekClosed(B, storeB, "2026-08-05") === false);
  const okB = Cash.closeWeek(B, storeB, { weekStart: "2026-08-01", weekEnd: "2026-08-08" }) as any;
  check("6.2 org B fecha o mesmo intervalo sem conflito (isolado)", !!okB?.id);

  console.log("\n=== TEST: Fechamento de período livre no Malote ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
