/**
 * TESTE — Relatório de comissão do período (ADR-083 Fase G).
 *
 * Consolida, só-leitura, a comissão por VENDEDOR / PRODUTO / LOJA aplicando as
 * regras ativas. Prova os agregados, contagens e totais; regra inativa zera a
 * comissão daquela dimensão (mas as vendas continuam aparecendo).
 *
 * Uso:  npm run test:retail-commission-report
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-comm-report-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-comm-report-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

const P0 = "2000-01-01", P1 = "2100-01-01";

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { OrdersService } = await import("../src/server/OrdersService.js");
  const { RetailStoreService } = await import("../src/server/RetailStoreService.js");
  const { RetailCommissionService } = await import("../src/server/RetailCommissionService.js");

  const A = `org_A_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'A', 'active')`).run(randomUUID(), A);
  const U1 = randomUUID(), U2 = randomUUID();
  db.prepare(`INSERT INTO users (id, organization_id, name, email) VALUES (?, ?, 'Ana', ?)`).run(U1, A, `a_${U1.slice(0, 6)}@x.com`);
  db.prepare(`INSERT INTO users (id, organization_id, name, email) VALUES (?, ?, 'Bruno', ?)`).run(U2, A, `b_${U2.slice(0, 6)}@x.com`);
  const PA = randomUUID(), PB = randomUUID();
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name, price, active, stock_control_enabled) VALUES (?, ?, 'product', 'Camisa', 100, 1, 0)`).run(PA, A);
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name, price, active, stock_control_enabled) VALUES (?, ?, 'product', 'Calça', 300, 1, 0)`).run(PB, A);
  const store = RetailStoreService.create(A, { name: "Loja 1", code: "1" });
  db.prepare(`INSERT INTO retail_daily_closings (id, organization_id, store_id, closing_date, status, informed_total) VALUES (?, ?, ?, '2026-07-15', 'approved', 1000)`).run(randomUUID(), A, store.id);

  const sell = (sellerUserId: string | undefined, productId: string, qty: number) =>
    OrdersService.createOrder(A, { items: [{ productId, name: "x", unitPrice: 0, quantity: qty }], sellerUserId, autoClose: true });
  sell(U1, PA, 2); sell(U1, PA, 1); sell(U2, PB, 1); sell(undefined, PA, 5);
  // Ana 300 (2 pedidos); Bruno 300 (1). Camisa 800 (3); Calça 300 (1).

  RetailCommissionService.createRule(A, { name: "V 10%", scope: "seller", calculationType: "percent_sales", config: { percent: 10 } });
  RetailCommissionService.createRule(A, { name: "P 5%", scope: "product", calculationType: "percent_sales", config: { percent: 5 } });
  const storeRule = RetailCommissionService.createRule(A, { name: "L 2%", scope: "store", calculationType: "percent_sales", config: { percent: 2 } });

  const rep = RetailCommissionService.report(A, P0, P1);
  const ana = rep.bySeller.find((x: any) => x.sellerUserId === U1);
  check("por vendedor: Ana 300, 2 pedidos, comissão 30", ana?.sales === 300 && ana?.orders === 2 && ana?.commission === 30, JSON.stringify(ana));
  check("totais vendedor = 60", rep.totals.sellerCommission === 60, JSON.stringify(rep.totals));
  const cam = rep.byProduct.find((x: any) => x.productId === PA);
  check("por produto: Camisa 800, 3 pedidos, comissão 40", cam?.sales === 800 && cam?.orders === 3 && cam?.commission === 40, JSON.stringify(cam));
  check("totais produto = 55", rep.totals.productCommission === 55);
  const lj = rep.byStore.find((x: any) => x.storeId === store.id);
  check("por loja: vendas 1000, comissão 20", lj?.sales === 1000 && lj?.commission === 20, JSON.stringify(lj));
  check("total geral = 135 (60+55+20)", rep.totals.totalCommission === 135, JSON.stringify(rep.totals));
  check("hasRules: seller/product/store true, global false", rep.hasRules.seller && rep.hasRules.product && rep.hasRules.store && !rep.hasRules.global);

  // Regra de loja inativa → comissão da loja zera, mas as vendas continuam.
  RetailCommissionService.setRuleActive(A, storeRule.id, false);
  const rep2 = RetailCommissionService.report(A, P0, P1);
  const lj2 = rep2.byStore.find((x: any) => x.storeId === store.id);
  check("regra inativa: loja comissão 0, vendas 1000 mantêm", lj2?.commission === 0 && lj2?.sales === 1000);
  check("total cai p/ 115 sem a regra de loja", rep2.totals.totalCommission === 115, JSON.stringify(rep2.totals));

  // Isolamento.
  const B = `org_B_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'B', 'active')`).run(randomUUID(), B);
  const repB = RetailCommissionService.report(B, P0, P1);
  check("isolamento: org B relatório vazio", repB.bySeller.length === 0 && repB.totals.totalCommission === 0);

  console.log("\n=== Relatório de comissão (ADR-083 Fase G) ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
