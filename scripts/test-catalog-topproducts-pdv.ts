/**
 * TESTE — Catálogo "mais vendidos" reflete o PDV (Alterdata) com a ponte ligada.
 * ------------------------------------------------------------------------------
 * O relatório /api/products/sales-analytics agregava vendas SÓ de order_items.
 * Para uma rede que vende no PDV isso fica vazio. Agora o `productSalesSubquery`
 * une, quando a ponte `retail_revenue_bridge` está ligada, as vendas do PDV
 * (retail_pdv_sale_items) por produto — unidades + receita, custo 0.
 *
 * Prova, offline, o fragmento de SQL exportado:
 *   - ponte OFF → só pedidos próprios (produto do PDV fica com 0 unidades);
 *   - ponte ON  → soma as unidades/receita do PDV ao produto resolvido;
 *   - respeita a janela de dias e o isolamento por organização.
 *
 * Uso:  npm run test:catalog-topproducts-pdv
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-catalog-pdv-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-catalog-pdv-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { productSalesSubquery } = await import("../src/server/routes/products.js");

  const A = `org_A_${randomUUID().slice(0, 6)}`;
  const B = `org_B_${randomUUID().slice(0, 6)}`;
  for (const org of [A, B]) db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), org);

  // Produto do PDV (só vende no caixa) e produto de pedido próprio.
  const pPdv = randomUUID(), pOrder = randomUUID();
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name, price, active) VALUES (?, ?, 'product', 'Vestido PDV', 199.9, 1)`).run(pPdv, A);
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name, price, active) VALUES (?, ?, 'product', 'Kit Online', 50, 1)`).run(pOrder, A);

  const today = new Date().toISOString().slice(0, 10);
  // 5 peças do Vestido no PDV hoje (resolvido para o produto pPdv).
  const pdvItem = (boleta: string, seq: number, qtd: number, valor: number) =>
    db.prepare(`INSERT INTO retail_pdv_sale_items (id, organization_id, filial, boleta, sale_date, item_seq, produto, product_service_id, quantidade, valor) VALUES (?, ?, '01', ?, ?, ?, '2971', ?, ?, ?)`)
      .run(randomUUID(), A, boleta, today, seq, pPdv, qtd, valor);
  pdvItem("100", 1, 3, 599.7);
  pdvItem("101", 1, 2, 399.8); // total 5 peças / 999.5

  // 1 pedido próprio faturado (2 un do Kit).
  const order = randomUUID();
  db.prepare(`INSERT INTO orders (id, organization_id, status, total_amount, created_at) VALUES (?, ?, 'pago', 100, datetime('now'))`).run(order, A);
  db.prepare(`INSERT INTO order_items (id, organization_id, order_id, product_service_id, name_snapshot, quantity, line_total, unit_cost) VALUES (?, ?, ?, ?, 'Kit Online', 2, 100, 20)`).run(randomUUID(), A, order, pOrder);

  const runReport = (retailOn: boolean, org: string) => db.prepare(`
    SELECT ps.id, ps.name, COALESCE(s.units,0) AS units_sold, COALESCE(s.revenue,0) AS revenue, COALESCE(s.cost_total,0) AS cost_total
      FROM products_services ps
      LEFT JOIN (${productSalesSubquery(retailOn)}) s ON s.product_service_id = ps.id
     WHERE ps.organization_id = @org AND ps.type='product' AND ps.active=1
     ORDER BY units_sold DESC`).all({ org, since: "-30 days" }) as any[];

  // ===== 1. Ponte OFF: PDV não conta =====
  const off = runReport(false, A);
  const offPdv = off.find((r) => r.id === pPdv);
  check("ponte OFF: Vestido do PDV fica com 0 unidades", offPdv?.units_sold === 0, `units=${offPdv?.units_sold}`);
  check("ponte OFF: Kit (pedido próprio) mantém 2 unidades", off.find((r) => r.id === pOrder)?.units_sold === 2);

  // ===== 2. Ponte ON: PDV soma =====
  const on = runReport(true, A);
  const onPdv = on.find((r) => r.id === pPdv);
  check("ponte ON: Vestido do PDV soma 5 unidades", onPdv?.units_sold === 5, `units=${onPdv?.units_sold}`);
  check("ponte ON: receita do PDV = 999.5", Math.round(Number(onPdv?.revenue) * 100) / 100 === 999.5, `rev=${onPdv?.revenue}`);
  check("ponte ON: custo do PDV fica 0 (ERP não manda CMV por item)", Number(onPdv?.cost_total) === 0);
  check("ponte ON: Vestido é o mais vendido (5 > 2)", on[0]?.id === pPdv);

  // ===== 3. Isolamento =====
  check("Isolamento: org B não vê o PDV de A", runReport(true, B).every((r) => r.units_sold === 0));

  console.log("\n=== Catálogo mais vendidos reflete o PDV com a ponte ligada ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
