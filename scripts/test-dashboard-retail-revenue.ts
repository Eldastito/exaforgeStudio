/**
 * TESTE — Dashboard reflete o varejo (Alterdata/PDV) quando a ponte está ligada.
 * ------------------------------------------------------------------------------
 * Prova, offline, que AnalyticsService.getMetrics:
 *   - com a ponte (retail_revenue_bridge) DESLIGADA → ignora fechamentos/vendas
 *     do PDV (comportamento atual, empresas comuns não mudam);
 *   - com a ponte LIGADA → soma o faturamento das lojas (fechamentos elegíveis)
 *     em paidRevenue e as vendas do PDV em salesCount;
 *   - respeita a janela de período (mês) e o isolamento por organização.
 *
 * Uso:  npm run test:dashboard-retail-revenue
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-dash-retail-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-dash-retail-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { RetailStoreService } = await import("../src/server/RetailStoreService.js");
  const { RetailRevenueBridgeService } = await import("../src/server/RetailRevenueBridgeService.js");
  const { AnalyticsService } = await import("../src/server/AnalyticsService.js");

  const A = `org_A_${randomUUID().slice(0, 6)}`;
  const B = `org_B_${randomUUID().slice(0, 6)}`;
  for (const org of [A, B]) db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), org);
  const s1 = RetailStoreService.create(A, { name: "Loja 1" });
  const s2 = RetailStoreService.create(A, { name: "Loja 2" });

  // Fechamentos elegíveis (approved) HOJE — total do sistema (PDV) = 2300 + 1000.
  const today = new Date().toISOString().slice(0, 10);
  const closing = (store: string, sys: number) =>
    db.prepare(`INSERT INTO retail_daily_closings (id, organization_id, store_id, closing_date, status, informed_total, system_total, divergence_status) VALUES (?, ?, ?, ?, 'approved', ?, ?, 'ok')`)
      .run(randomUUID(), A, store, today, sys, sys);
  closing(s1.id, 2300);
  closing(s2.id, 1000); // 2 lojas fecham hoje → 3300

  // 3 vendas do PDV hoje.
  const sale = (boleta: string) =>
    db.prepare(`INSERT INTO retail_pdv_sales (id, organization_id, filial, boleta, sale_date) VALUES (?, ?, '01', ?, ?)`)
      .run(randomUUID(), A, boleta, today);
  sale("100"); sale("101"); sale("102");

  // ===== 1. Ponte DESLIGADA (default) → Dashboard não vê o varejo =====
  const off = AnalyticsService.getMetrics(A, { period: "month" } as any);
  check("ponte OFF: paidRevenue não inclui as lojas (0)", off.paidRevenue === 0, `paidRevenue=${off.paidRevenue}`);
  check("ponte OFF: salesCount não inclui o PDV (0)", off.salesCount === 0, `salesCount=${off.salesCount}`);

  // ===== 2. Ponte LIGADA → Dashboard soma o varejo =====
  RetailRevenueBridgeService.setEnabled(A, true);
  const on = AnalyticsService.getMetrics(A, { period: "month" } as any);
  check("ponte ON: paidRevenue soma os fechamentos (3300)", on.paidRevenue === 3300, `paidRevenue=${on.paidRevenue}`);
  check("ponte ON: salesCount soma as vendas do PDV (3)", on.salesCount === 3, `salesCount=${on.salesCount}`);

  // ===== 3. Isolamento — org B (sem dados, ponte ligada) vem zerada =====
  RetailRevenueBridgeService.setEnabled(B, true);
  const bMetrics = AnalyticsService.getMetrics(B, { period: "month" } as any);
  check("Isolamento: org B não vê o varejo de A", bMetrics.paidRevenue === 0 && bMetrics.salesCount === 0);

  console.log("\n=== Dashboard reflete o varejo com a ponte ligada ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
