/**
 * TESTE — Retail Ops Fase H: dashboard + acumulado mensal + export (ADR-083)
 * ------------------------------------------------------------------------
 * Prova, offline, a visão que amarra A–G:
 *   - painel do DIA: cota/realizado/desvio, lojas acima/abaixo, pendências,
 *     estoque negativo;
 *   - acumulado do MÊS: total, por loja, estimativa de premiação;
 *   - linhas de export do mês (header + fechamentos); isolamento por org.
 *
 * Uso:  npm run test:retail-dashboard
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-retail-h-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-retail-h-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { RetailStoreService } = await import("../src/server/RetailStoreService.js");
  const { RetailQuotaService, RetailTaskService } = await import("../src/server/RetailOpsService.js");
  const { RetailInventoryService } = await import("../src/server/RetailInventoryService.js");
  const { RetailCommissionService } = await import("../src/server/RetailCommissionService.js");
  const { RetailDashboardService } = await import("../src/server/RetailDashboardService.js");

  const A = `org_A_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'A', 'active')`).run(randomUUID(), A);
  db.prepare(`UPDATE organization_settings SET retail_daily_closing_enabled=1, retail_daily_closing_due_hour=21 WHERE organization_id=?`).run(A);
  const s1 = RetailStoreService.create(A, { name: "Loja 1" });
  const s2 = RetailStoreService.create(A, { name: "Loja 2" });
  const DAY = "2026-07-10";

  RetailQuotaService.set(A, { storeId: s1.id, quotaDate: DAY, quotaAmount: 8000 });
  RetailQuotaService.set(A, { storeId: s2.id, quotaDate: DAY, quotaAmount: 5000 });
  const closing = (store: string, date: string, quota: number, informed: number) =>
    db.prepare(`INSERT INTO retail_daily_closings (id, organization_id, store_id, closing_date, status, quota_amount, informed_total, variance_amount) VALUES (?, ?, ?, ?, 'approved', ?, ?, ?)`)
      .run(randomUUID(), A, store, date, quota, informed, informed - quota);
  closing(s1.id, DAY, 8000, 9000);  // acima
  closing(s2.id, DAY, 5000, 4000);  // abaixo
  closing(s1.id, "2026-07-20", 0, 6000);
  RetailTaskService.generateDay(A, DAY);            // 2 tarefas 'fechamento' pendentes
  RetailInventoryService.setQuantity(A, s1.id, randomUUID(), null, -3); // 1 estoque negativo
  RetailCommissionService.createRule(A, { name: "5%", scope: "store", calculationType: "percent_sales", config: { percent: 5 } }, "u1");

  // ---- 1. Painel do dia ----
  const d = RetailDashboardService.daily(A, DAY);
  check("Cota total do dia", d.quotaTotal === 13000);
  check("Realizado do dia", d.realized === 13000);
  check("Desvio do dia", d.variance === 0);
  check("Lojas acima/abaixo da cota", d.storesAbove === 1 && d.storesBelow === 1);
  check("Fechamentos pendentes (checklist)", d.pendingClosings === 2);
  check("Estoque negativo contabilizado", d.negativeStock === 1);

  // ---- 2. Acumulado do mês ----
  const m = RetailDashboardService.monthly(A, "2026-07");
  check("Total de vendas do mês", m.totalSales === 19000);
  check("Quebra por loja (Loja 1 lidera com 15000)", m.perStore[0].store_name === "Loja 1" && m.perStore[0].sales === 15000);
  check("Estimativa de premiação do mês (5% de 19000 = 950)", m.commissionEstimate === 950);

  // ---- 3. Export do mês ----
  const rows = RetailDashboardService.monthlyClosingRows(A, "2026-07");
  check("Export traz header + 3 fechamentos", rows.length === 4 && rows[0][0] === "Data");

  // ---- 4. Isolamento ----
  const B = `org_B_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'B', 'active')`).run(randomUUID(), B);
  const db2 = RetailDashboardService.daily(B, DAY);
  check("Isolamento: painel de B vem zerado", db2.quotaTotal === 0 && db2.realized === 0 && db2.negativeStock === 0);

  console.log("\n=== Retail Ops — Fase H: dashboard + mensal + export (ADR-083) ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
