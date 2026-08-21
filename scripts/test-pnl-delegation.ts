/**
 * TEST — LossMarginService delega ao reconciliador (ADR-182 F2). DB-backed, determinístico.
 * Prova: LossMarginService.monthlyRevenue === PnlReconciliationService.monthlyRevenueTotal
 * (fonte única) com ponte on E off; o indicador de perda (`indicator`) usa a base reconciliada;
 * 0-regressão numérica.
 *
 * Uso: npm run test:pnl-delegation
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-pnldeleg-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-pnldeleg-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { PnlReconciliationService: PNL } = await import("../src/server/PnlReconciliationService.js");
  const { LossMarginService: LOSS } = await import("../src/server/LossMarginService.js");

  const PERIOD = "2026-06";
  const A = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical) VALUES (?, ?, 'A', 'active', 'moda')`).run(randomUUID(), A);
  db.prepare(`INSERT INTO orders (id, organization_id, status, total_amount, created_at) VALUES (?, ?, 'pago', 1000, '2026-06-10 10:00:00')`).run(randomUUID(), A);
  db.prepare(`INSERT INTO comigo_orders (id, organization_id, status, total, created_at) VALUES (?, ?, 'paid', 200, '2026-06-11 10:00:00')`).run(randomUUID(), A);
  db.prepare(`INSERT INTO retail_daily_closings (id, organization_id, store_id, closing_date, status, system_total) VALUES (?, ?, 'loja1', '2026-06-12', 'approved', 500)`).run(randomUUID(), A);

  // 1. Ponte OFF — LossMargin.monthlyRevenue delega (== reconciliador == 1200).
  db.prepare(`UPDATE organization_settings SET retail_revenue_bridge = 0 WHERE organization_id = ?`).run(A);
  check("1.1 LossMargin == reconciliador (off)", LOSS.monthlyRevenue(A, PERIOD) === PNL.monthlyRevenueTotal(A, PERIOD));
  check("1.2 valor esperado 1200 (off)", LOSS.monthlyRevenue(A, PERIOD) === 1200);

  // 2. Ponte ON — delega e soma fechamentos (== 1700).
  db.prepare(`UPDATE organization_settings SET retail_revenue_bridge = 1 WHERE organization_id = ?`).run(A);
  check("2.1 LossMargin == reconciliador (on)", LOSS.monthlyRevenue(A, PERIOD) === PNL.monthlyRevenueTotal(A, PERIOD));
  check("2.2 valor esperado 1700 (on)", LOSS.monthlyRevenue(A, PERIOD) === 1700);

  // 3. O resumo de perda usa a base reconciliada (base === reconciliador).
  LOSS.recordLoss(A, { driver: "desconto", amount: 100, period: PERIOD });
  const sum = LOSS.monthlySummary(A, PERIOD);
  check("3.1 monthlySummary.base == reconciliador (on)", sum.base === PNL.monthlyRevenueTotal(A, PERIOD));
  check("3.2 lossPct coerente (100/1700)", Math.abs(sum.lossPct - (100 / 1700) * 100) < 0.01);

  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} pnl-delegation: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
