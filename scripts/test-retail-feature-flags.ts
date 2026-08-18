/**
 * TESTE — Kill-switches de runtime (PDR TOULON, Fase 6B).
 * ---------------------------------------------------------------------------
 * Prova, offline:
 *   - defaults LIGADOS (comportamento novo) — 0-regressão;
 *   - retail_business_date_v1 OFF → data comercial volta ao UTC (pré-1A):
 *     às 23h30 SP (02h30 UTC do dia seguinte), ON = dia SP, OFF = dia UTC;
 *   - retail_analytics_resolved_products_v1 OFF → analíticas (CMV/precificar)
 *     resolvem por LIKE, com o MESMO número do caminho resolvido (equivalência);
 *   - set() persiste e status() reflete; isolamento multi-tenant.
 *
 * Uso:  npm run test:retail-feature-flags
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-retail-flags-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-retail-flags-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }
const near = (a: number, b: number, eps = 0.011) => Math.abs(a - b) < eps;

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { RetailFeatureFlagService: F } = await import("../src/server/RetailFeatureFlagService.js");
  const { BusinessTimeService } = await import("../src/server/BusinessTimeService.js");
  const { RetailStoreService } = await import("../src/server/RetailStoreService.js");
  const { RetailStoreCostService } = await import("../src/server/RetailStoreCostService.js");
  const { RetailPricingService } = await import("../src/server/RetailPricingService.js");

  const A = `org_A_${randomUUID().slice(0, 6)}`;
  const B = `org_B_${randomUUID().slice(0, 6)}`;
  for (const org of [A, B]) db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, timezone) VALUES (?, ?, 'X', 'active', 'America/Sao_Paulo')`).run(randomUUID(), org);

  // ===== 1. defaults LIGADOS =====
  check("default: business_date ligado", F.businessDateV1(A) === true);
  check("default: resolved_products ligado", F.resolvedProductsV1(A) === true);
  check("status() reflete os dois ligados", F.status(A).business_date === true && F.status(A).resolved_products === true);

  // ===== 2. kill-switch data comercial =====
  // 23h30 no Rio (UTC-3) = 02h30 UTC do dia SEGUINTE.
  const instant = new Date("2026-08-19T02:30:00.000Z");
  check("ON: businessDate = dia SP (18)", BusinessTimeService.businessDate(A, instant) === "2026-08-18");
  F.set(A, "business_date", false);
  check("OFF persistiu", F.businessDateV1(A) === false);
  check("OFF: businessDate volta ao UTC (19)", BusinessTimeService.businessDate(A, instant) === "2026-08-19");
  check("writeDay herda o kill-switch (UTC 19)", BusinessTimeService.writeDay(A, instant) === "2026-08-19");
  F.set(A, "business_date", true);
  check("religar volta pro dia SP (18)", BusinessTimeService.businessDate(A, instant) === "2026-08-18");

  // ===== 3. kill-switch analíticas: equivalência resolvido × LIKE =====
  const loja = RetailStoreService.create(A, { name: "Loja", code: "10" });
  RetailStoreService.update(A, loja.id, { grossMarginPercent: 50 });
  const prod = randomUUID();
  db.prepare(`INSERT INTO products_services (id, organization_id, name, type, active, external_ref) VALUES (?, ?, 'Camisa', 'product', 1, 'CAM01')`).run(prod, A);
  db.prepare(`INSERT INTO inventory_items (id, organization_id, product_service_id, quantity_available, avg_cost) VALUES (?, ?, ?, 0, 30)`).run(randomUUID(), A, prod);
  // Item cujo `produto` casa por código ('CAM01') E está resolvido (product_service_id):
  // os dois caminhos (coluna e LIKE) devem dar o MESMO CMV.
  db.prepare(`INSERT INTO retail_pdv_sale_items (id, organization_id, filial, boleta, sale_date, item_seq, produto, quantidade, valor, product_service_id, catalog_match_status, catalog_resolved_at) VALUES (?, ?, '10', 'B1', '2026-08-05', 1, 'CAM01', 2, 200, ?, 'exact', '2026-08-05 10:00:00')`).run(randomUUID(), A, prod);
  db.prepare(`INSERT INTO retail_daily_closings (id, organization_id, store_id, closing_date, status, informed_total, system_total) VALUES (?, ?, ?, '2026-08-05', 'approved', 200, 200)`).run(randomUUID(), A, loja.id);
  const period = "2026-08";

  const cmvOn = RetailStoreCostService.monthlyCogsBreakdownAll(A, period).get(loja.id);
  check("ON: CMV via coluna = 60 (2×30)", !!cmvOn && near(cmvOn.cmvReal, 60), String(cmvOn?.cmvReal));
  const priceOn = RetailPricingService.listProducts(A, { limit: 50 }).items.find((i: any) => i.productId === prod);
  check("ON: precificar vê 2 unidades vendidas", !!priceOn && priceOn.unitsSoldMonth === 2, String(priceOn?.unitsSoldMonth));

  F.set(A, "resolved_products", false);
  const cmvOff = RetailStoreCostService.monthlyCogsBreakdownAll(A, period).get(loja.id);
  check("OFF (LIKE): CMV IDÊNTICO = 60 (equivalência)", !!cmvOff && near(cmvOff.cmvReal, 60), String(cmvOff?.cmvReal));
  const priceOff = RetailPricingService.listProducts(A, { limit: 50 }).items.find((i: any) => i.productId === prod);
  check("OFF (LIKE): precificar IDÊNTICO = 2 unidades", !!priceOff && priceOff.unitsSoldMonth === 2, String(priceOff?.unitsSoldMonth));
  F.set(A, "resolved_products", true);

  // ===== 4. isolamento =====
  check("org B mantém defaults (A não vazou)", F.businessDateV1(B) === true && F.resolvedProductsV1(B) === true);

  console.log("\n=== TEST: Kill-switches de runtime (Fase 6B) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
