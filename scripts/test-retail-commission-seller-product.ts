/**
 * TESTE — Comissão por VENDEDOR e por PRODUTO (ADR-083 Fase G + ADR-143).
 *
 * A base de vendedor/produto vem das VENDAS DO ZAPPFLOW (orders faturados),
 * não dos fechamentos (que só têm total por loja). Prova:
 *   - regra scope=seller: apura por vendedor (só pedidos com seller_user_id);
 *   - regra scope=product: apura por produto (itens dos pedidos faturados);
 *   - quota_bonus por vendedor usa a cota da regra (config.quota);
 *   - os itens gravam seller_user_id / product_service_id; isolado por org.
 *
 * Uso:  npm run test:retail-commission-seller-product
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-comm-sp-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-comm-seller-product-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

const P0 = "2000-01-01", P1 = "2100-01-01"; // janela ampla (pega tudo)

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { OrdersService } = await import("../src/server/OrdersService.js");
  const { RetailCommissionService } = await import("../src/server/RetailCommissionService.js");

  const A = `org_A_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'A', 'active')`).run(randomUUID(), A);
  const U1 = randomUUID(), U2 = randomUUID();
  db.prepare(`INSERT INTO users (id, organization_id, name, email) VALUES (?, ?, 'Ana', ?)`).run(U1, A, `ana_${U1.slice(0, 6)}@x.com`);
  db.prepare(`INSERT INTO users (id, organization_id, name, email) VALUES (?, ?, 'Bruno', ?)`).run(U2, A, `bruno_${U2.slice(0, 6)}@x.com`);
  const PA = randomUUID(), PB = randomUUID();
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name, price, active, stock_control_enabled) VALUES (?, ?, 'product', 'Camisa', 100, 1, 0)`).run(PA, A);
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name, price, active, stock_control_enabled) VALUES (?, ?, 'product', 'Calça', 300, 1, 0)`).run(PB, A);

  const sell = (sellerUserId: string | undefined, productId: string, qty: number) =>
    OrdersService.createOrder(A, { items: [{ productId, name: "x", unitPrice: 0, quantity: qty }], sellerUserId, autoClose: true });

  sell(U1, PA, 2); // Ana: Camisa 2×100 = 200
  sell(U1, PA, 1); // Ana: Camisa 1×100 = 100  → Ana total 300
  sell(U2, PB, 1); // Bruno: Calça 1×300 = 300
  sell(undefined, PA, 5); // sem vendedor: Camisa 5×100 = 500 (fora do vendedor; entra no produto)

  // Bases esperadas: Ana 300, Bruno 300; Camisa 800, Calça 300.
  const bySeller = RetailCommissionService.onlineSalesBySeller(A, P0, P1);
  check("vendas por vendedor: Ana 300 / Bruno 300 (sem-vendedor fora)", bySeller.length === 2 && bySeller.find(x => x.sellerUserId === U1)?.sales === 300 && bySeller.find(x => x.sellerUserId === U2)?.sales === 300, JSON.stringify(bySeller));
  check("nome do vendedor resolvido (Ana)", bySeller.find(x => x.sellerUserId === U1)?.sellerName === "Ana");
  const byProd = RetailCommissionService.onlineSalesByProduct(A, P0, P1);
  check("vendas por produto: Camisa 800 / Calça 300", byProd.find(x => x.productId === PA)?.sales === 800 && byProd.find(x => x.productId === PB)?.sales === 300, JSON.stringify(byProd));

  // ===== Regra por VENDEDOR (percent 10%) =====
  const rSeller = RetailCommissionService.createRule(A, { name: "Vendedor 10%", scope: "seller", calculationType: "percent_sales", config: { percent: 10 } });
  const runA = RetailCommissionService.createRun(A, P0, P1);
  const sellerItems = runA.items.filter((i: any) => i.seller_user_id);
  check("run vendedor: 2 itens com seller_user_id", sellerItems.length === 2, JSON.stringify(runA.items.map((i: any) => ({ s: i.seller_user_id, c: i.commission_amount }))));
  check("Ana 10% de 300 = 30", Number(sellerItems.find((i: any) => i.seller_user_id === U1)?.commission_amount) === 30);
  check("Bruno 10% de 300 = 30", Number(sellerItems.find((i: any) => i.seller_user_id === U2)?.commission_amount) === 30);

  // ===== Regra por PRODUTO (percent 5%) — desliga a de vendedor =====
  RetailCommissionService.setRuleActive(A, rSeller.id, false);
  RetailCommissionService.createRule(A, { name: "Produto 5%", scope: "product", calculationType: "percent_sales", config: { percent: 5 } });
  const runB = RetailCommissionService.createRun(A, P0, P1);
  const prodItems = runB.items.filter((i: any) => i.product_service_id);
  check("run produto: 2 itens com product_service_id", prodItems.length === 2, JSON.stringify(runB.items.map((i: any) => ({ p: i.product_service_id, c: i.commission_amount }))));
  check("Camisa 5% de 800 = 40", Number(prodItems.find((i: any) => i.product_service_id === PA)?.commission_amount) === 40);
  check("Calça 5% de 300 = 15", Number(prodItems.find((i: any) => i.product_service_id === PB)?.commission_amount) === 15);
  check("nenhum item de vendedor no run de produto", runB.items.filter((i: any) => i.seller_user_id).length === 0);

  // ===== quota_bonus por vendedor (cota da regra) =====
  RetailCommissionService.createRule(A, { name: "Bônus vendedor", scope: "seller", calculationType: "quota_bonus", config: { quota: 250, bonus: 50 } });
  const runC = RetailCommissionService.createRun(A, P0, P1);
  const bonusItems = runC.items.filter((i: any) => i.seller_user_id);
  check("quota_bonus: Ana e Bruno (300 ≥ 250) ganham 50", bonusItems.every((i: any) => Number(i.commission_amount) === 50) && bonusItems.length === 2, JSON.stringify(bonusItems.map((i: any) => i.commission_amount)));

  // ===== Isolamento =====
  const B = `org_B_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'B', 'active')`).run(randomUUID(), B);
  check("isolamento: org B sem vendas por vendedor", RetailCommissionService.onlineSalesBySeller(B, P0, P1).length === 0);

  console.log("\n=== Comissão por vendedor/produto (ADR-083 Fase G) ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
