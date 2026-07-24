/**
 * TESTE — Ponte Fechamento → Faturamento (Operação da Rede → Motor de Caixa).
 * ----------------------------------------------------------------------------
 * Prova, offline, que os fechamentos diários de loja viram caixa/receita SÓ
 * quando a flag opt-in `retail_revenue_bridge` está ligada:
 *   - OFF (default): não posta caixa; faturamento do mês ignora os fechamentos;
 *   - ON: fechamentos elegíveis (approved/reconciled/divergent, valor > 0) viram
 *     ENTRADA de caixa (source_type='retail_closing') e entram na receita mensal;
 *   - prefere system_total (PDV) quando houver, senão informed_total;
 *   - pending/rejected NÃO contam;
 *   - idempotente (re-sync não duplica); isolado por organização.
 *
 * Uso:  npm run test:retail-revenue-bridge
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-retail-bridge-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-retail-bridge-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { RetailStoreService } = await import("../src/server/RetailStoreService.js");
  const { RetailRevenueBridgeService } = await import("../src/server/RetailRevenueBridgeService.js");
  const { FinancialLedgerService } = await import("../src/server/FinancialLedgerService.js");
  const { LossMarginService } = await import("../src/server/LossMarginService.js");

  const A = `org_A_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'A', 'active')`).run(randomUUID(), A);
  const store = RetailStoreService.create(A, { name: "Toulon 1079", code: "1079" });

  // Fechamentos do mês 2026-07, um por dia (todos da mesma loja):
  const mk = (date: string, status: string, informed: number, system: number) =>
    db.prepare(`INSERT INTO retail_daily_closings (id, organization_id, store_id, closing_date, status, informed_total, system_total) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(randomUUID(), A, store.id, date, status, informed, system);
  mk("2026-07-01", "approved", 1000, 0);      // elegível → 1000 (usa informado)
  mk("2026-07-02", "reconciled", 2000, 1900); // elegível → 1900 (prefere sistema/PDV)
  mk("2026-07-03", "divergent", 500, 480);    // elegível → 480 (prefere sistema)
  mk("2026-07-04", "pending", 999, 0);        // NÃO elegível
  mk("2026-07-05", "rejected", 777, 0);       // NÃO elegível
  const ELIGIBLE_TOTAL = 1000 + 1900 + 480;   // 3380

  // ===== 1. Flag OFF (default) — nada de caixa/receita =====
  check("flag nasce desligada (default off)", RetailRevenueBridgeService.isEnabled(A) === false);
  FinancialLedgerService.summary(A); // dispara syncFromSales (não deve postar nada de loja)
  const offEvents = (db.prepare(`SELECT COUNT(*) c FROM cash_events WHERE organization_id=? AND source_type='retail_closing'`).get(A) as any).c;
  check("OFF: nenhum cash_event de fechamento", offEvents === 0, `viu ${offEvents}`);
  check("OFF: faturamento do mês ignora fechamentos", LossMarginService.monthlyRevenue(A, "2026-07") === 0);

  // ===== 2. Liga a ponte =====
  RetailRevenueBridgeService.setEnabled(A, true);
  check("liga a flag", RetailRevenueBridgeService.isEnabled(A) === true);
  check("elegíveis: 3 fechamentos (approved/reconciled/divergent)", RetailRevenueBridgeService.eligibleClosings(A).length === 3);

  FinancialLedgerService.summary(A); // agora posta os elegíveis como entrada de caixa
  const onEvents = db.prepare(`SELECT amount FROM cash_events WHERE organization_id=? AND source_type='retail_closing' ORDER BY event_date`).all(A) as any[];
  check("ON: 3 cash_events de fechamento", onEvents.length === 3, `viu ${onEvents.length}`);
  check("ON: prefere system_total (1900, não 2000)", onEvents.some((e) => Number(e.amount) === 1900) && !onEvents.some((e) => Number(e.amount) === 2000));
  const inflow = FinancialLedgerService.realizedCash(A, "2026-07-01", "2026-07-31").inflow;
  check("ON: caixa realizado do mês = 3380", inflow === ELIGIBLE_TOTAL, `viu ${inflow}`);
  check("ON: faturamento do mês = 3380", LossMarginService.monthlyRevenue(A, "2026-07") === ELIGIBLE_TOTAL, `viu ${LossMarginService.monthlyRevenue(A, "2026-07")}`);

  // ===== 3. Idempotência (re-sync não duplica) =====
  FinancialLedgerService.summary(A);
  FinancialLedgerService.summary(A);
  const dupCount = (db.prepare(`SELECT COUNT(*) c FROM cash_events WHERE organization_id=? AND source_type='retail_closing'`).get(A) as any).c;
  check("idempotente: re-sync mantém 3 eventos", dupCount === 3, `viu ${dupCount}`);
  check("idempotente: caixa ainda = 3380", FinancialLedgerService.realizedCash(A, "2026-07-01", "2026-07-31").inflow === ELIGIBLE_TOTAL);

  // ===== 4. Desligar volta a receita a 0 (gate do faturamento) =====
  RetailRevenueBridgeService.setEnabled(A, false);
  check("OFF de novo: faturamento volta a 0", LossMarginService.monthlyRevenue(A, "2026-07") === 0);

  // ===== 5. Isolamento por organização =====
  const B = `org_B_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'B', 'active')`).run(randomUUID(), B);
  RetailRevenueBridgeService.setEnabled(B, true);
  check("isolamento: org B sem fechamentos → 0 elegíveis", RetailRevenueBridgeService.eligibleClosings(B).length === 0);
  FinancialLedgerService.summary(B);
  check("isolamento: org B sem cash_event de fechamento", (db.prepare(`SELECT COUNT(*) c FROM cash_events WHERE organization_id=? AND source_type='retail_closing'`).get(B) as any).c === 0);

  console.log("\n=== Ponte Fechamento → Faturamento (Operação da Rede → Caixa) ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
