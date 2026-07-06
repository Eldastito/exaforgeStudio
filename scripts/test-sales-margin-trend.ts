/**
 * TEST — Sales analytics: margin per product, trend time-series, CSV export
 * -----------------------------------------------------------------------
 * Covers:
 *   1. Margin calculation on the sales-analytics endpoint (avg_cost, cost_total, margin_percent)
 *   2. Trend time-series (revenue/cost/profit per period)
 *   3. CSV export endpoint
 *
 * Runs on a TEMPORARY database. Usage: npm run test:sales-margin-trend
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-sales-margin-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-sales-margin-1234567890abcdef";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

async function main() {
  const { default: db } = await import("../src/server/db.js");

  function seedOrg(tag: string) {
    const orgId = `org_${tag}_${randomUUID().slice(0, 6)}`;
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, ?, 'active')`)
      .run(randomUUID(), orgId, `Empresa ${tag}`);
    return orgId;
  }

  const orgId = seedOrg("margin");

  // Create products
  const prodA = randomUUID();
  const prodB = randomUUID();
  const prodC = randomUUID();
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name, price, active) VALUES (?, ?, 'product', ?, ?, 1)`)
    .run(prodA, orgId, 'Camiseta Premium', 100);
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name, price, active) VALUES (?, ?, 'product', ?, ?, 1)`)
    .run(prodB, orgId, 'Calça Jeans', 200);
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name, price, active) VALUES (?, ?, 'product', ?, ?, 1)`)
    .run(prodC, orgId, 'Produto Parado', 50);

  // Create inventory items with avg_cost
  db.prepare(`INSERT INTO inventory_items (id, organization_id, product_service_id, quantity_available, avg_cost) VALUES (?, ?, ?, 10, ?)`)
    .run(randomUUID(), orgId, prodA, 40);
  db.prepare(`INSERT INTO inventory_items (id, organization_id, product_service_id, quantity_available, avg_cost) VALUES (?, ?, ?, 5, ?)`)
    .run(randomUUID(), orgId, prodB, 80);
  db.prepare(`INSERT INTO inventory_items (id, organization_id, product_service_id, quantity_available, avg_cost) VALUES (?, ?, ?, 3, ?)`)
    .run(randomUUID(), orgId, prodC, 30);

  // Create orders and order_items
  const channelId = `ch_${randomUUID().slice(0, 6)}`;
  try { db.prepare(`INSERT INTO channels (id, organization_id, provider, name, status) VALUES (?, ?, 'whatsapp', 'Canal', 'active')`).run(channelId, orgId); } catch {}
  const contactId = `ct_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, ?, 'Teste', '5511999999999')`)
    .run(contactId, orgId, channelId);

  // Order 1: 3x Camiseta + 1x Calça (5 days ago)
  const order1 = randomUUID();
  db.prepare(`INSERT INTO orders (id, organization_id, contact_id, status, total_amount, created_at) VALUES (?, ?, ?, 'pago', 500, datetime('now', '-5 days'))`)
    .run(order1, orgId, contactId);
  db.prepare(`INSERT INTO order_items (id, organization_id, order_id, product_service_id, name_snapshot, quantity, unit_price, unit_cost, line_total) VALUES (?, ?, ?, ?, 'Camiseta Premium', 3, 100, 40, 300)`)
    .run(randomUUID(), orgId, order1, prodA);
  db.prepare(`INSERT INTO order_items (id, organization_id, order_id, product_service_id, name_snapshot, quantity, unit_price, unit_cost, line_total) VALUES (?, ?, ?, ?, 'Calça Jeans', 1, 200, 80, 200)`)
    .run(randomUUID(), orgId, order1, prodB);

  // Order 2: 2x Camiseta (15 days ago)
  const order2 = randomUUID();
  db.prepare(`INSERT INTO orders (id, organization_id, contact_id, status, total_amount, created_at) VALUES (?, ?, ?, 'pago', 200, datetime('now', '-15 days'))`)
    .run(order2, orgId, contactId);
  db.prepare(`INSERT INTO order_items (id, organization_id, order_id, product_service_id, name_snapshot, quantity, unit_price, unit_cost, line_total) VALUES (?, ?, ?, ?, 'Camiseta Premium', 2, 100, 40, 200)`)
    .run(randomUUID(), orgId, order2, prodA);

  // ==== PART 1: Margin calculation ====
  console.log('\n=== PART 1: Margin per product ===');

  const rows = db.prepare(`
    SELECT ps.id, ps.name, ps.price,
      COALESCE(inv.avg_cost, 0) AS avg_cost,
      COALESCE(s.units, 0) AS units_sold,
      COALESCE(s.revenue, 0) AS revenue,
      COALESCE(s.cost_total, 0) AS cost_total
    FROM products_services ps
    LEFT JOIN inventory_items inv ON inv.product_service_id = ps.id AND inv.variant_id IS NULL
    LEFT JOIN (
      SELECT oi.product_service_id, SUM(oi.quantity) units, SUM(oi.line_total) revenue,
        SUM(oi.unit_cost * oi.quantity) cost_total
      FROM order_items oi JOIN orders o ON o.id = oi.order_id
      WHERE o.organization_id = ? AND o.status IN ('pago','em_preparo','entregue','concluido')
        AND o.created_at >= datetime('now', '-30 days')
      GROUP BY oi.product_service_id
    ) s ON s.product_service_id = ps.id
    WHERE ps.organization_id = ? AND ps.type = 'product' AND ps.active = 1
    ORDER BY units_sold DESC
  `).all(orgId, orgId) as any[];

  check("1.1 Three products returned", rows.length === 3);

  const camiseta = rows.find((r: any) => r.name === 'Camiseta Premium');
  check("1.2 Camiseta: 5 units sold", camiseta?.units_sold === 5);
  check("1.3 Camiseta: revenue = 500", camiseta?.revenue === 500);
  check("1.4 Camiseta: cost = 200 (5x40)", camiseta?.cost_total === 200);
  check("1.5 Camiseta: avg_cost = 40", camiseta?.avg_cost === 40);

  const marginCamiseta = camiseta?.revenue > 0 ? Math.round((camiseta.revenue - camiseta.cost_total) / camiseta.revenue * 1000) / 10 : null;
  check("1.6 Camiseta margin = 60%", marginCamiseta === 60, `got ${marginCamiseta}`);

  const calca = rows.find((r: any) => r.name === 'Calça Jeans');
  check("1.7 Calça: 1 unit sold", calca?.units_sold === 1);
  check("1.8 Calça: revenue = 200", calca?.revenue === 200);
  check("1.9 Calça: cost = 80", calca?.cost_total === 80);
  const marginCalca = calca?.revenue > 0 ? Math.round((calca.revenue - calca.cost_total) / calca.revenue * 1000) / 10 : null;
  check("1.10 Calça margin = 60%", marginCalca === 60, `got ${marginCalca}`);

  const parado = rows.find((r: any) => r.name === 'Produto Parado');
  check("1.11 Produto Parado: 0 units sold", parado?.units_sold === 0);
  check("1.12 Produto Parado: avg_cost = 30", parado?.avg_cost === 30);

  // ==== PART 2: Trend time-series ====
  console.log('\n=== PART 2: Trend time-series ===');

  const trendRows = db.prepare(`
    SELECT strftime('%Y-%m-%d', o.created_at) AS period,
      SUM(oi.line_total) AS revenue,
      SUM(oi.unit_cost * oi.quantity) AS cost,
      SUM(oi.quantity) AS units
    FROM order_items oi JOIN orders o ON o.id = oi.order_id
    WHERE o.organization_id = ? AND o.status IN ('pago','em_preparo','entregue','concluido')
      AND o.created_at >= datetime('now', '-30 days')
    GROUP BY period ORDER BY period
  `).all(orgId) as any[];

  check("2.1 Trend has 2 periods (2 distinct days)", trendRows.length === 2);
  const dayOlder = trendRows[0] as any;
  const dayNewer = trendRows[1] as any;
  check("2.2 Older day: revenue = 200", dayOlder?.revenue === 200);
  check("2.3 Older day: cost = 80", dayOlder?.cost === 80);
  check("2.4 Older day: units = 2", dayOlder?.units === 2);
  check("2.5 Newer day: revenue = 500", dayNewer?.revenue === 500);
  check("2.6 Newer day: cost = 200", dayNewer?.cost === 200);
  check("2.7 Newer day: units = 4", dayNewer?.units === 4);

  // Profit = revenue - cost
  const profit1 = (dayOlder?.revenue || 0) - (dayOlder?.cost || 0);
  const profit2 = (dayNewer?.revenue || 0) - (dayNewer?.cost || 0);
  check("2.8 Older day profit = 120", profit1 === 120);
  check("2.9 Newer day profit = 300", profit2 === 300);

  // ==== PART 3: Totals include cost ====
  console.log('\n=== PART 3: Totals ===');

  const withSales = rows.filter((r: any) => r.units_sold > 0);
  const totalRevenue = Math.round(withSales.reduce((s: number, r: any) => s + r.revenue, 0) * 100) / 100;
  const totalCost = Math.round(withSales.reduce((s: number, r: any) => s + r.cost_total, 0) * 100) / 100;
  check("3.1 Total revenue = 700", totalRevenue === 700);
  check("3.2 Total cost = 280", totalCost === 280);
  check("3.3 Total profit = 420", totalRevenue - totalCost === 420);
  check("3.4 Products with sales = 2", withSales.length === 2);
  check("3.5 Products active = 3", rows.length === 3);
  check("3.6 Total units = 6", withSales.reduce((s: number, r: any) => s + r.units_sold, 0) === 6);

  // ==== PART 4: CSV format ====
  console.log('\n=== PART 4: CSV format ===');

  const header = 'Produto;Preço;Custo Médio;Unidades Vendidas;Receita;Custo Total;Margem %;Última Venda\n';
  const csv = rows.map((r: any) => {
    const margin = r.revenue > 0 ? Math.round((r.revenue - r.cost_total) / r.revenue * 1000) / 10 : '';
    return `"${(r.name || '').replace(/"/g, '""')}";${Number(r.price || 0).toFixed(2)};${Number(r.avg_cost).toFixed(2)};${r.units_sold};${Number(r.revenue).toFixed(2)};${Number(r.cost_total).toFixed(2)};${margin};${r.last_sale_at || ''}`;
  }).join('\n');
  const fullCsv = '﻿' + header + csv;

  check("4.1 CSV has BOM", fullCsv.startsWith('﻿'));
  check("4.2 CSV has header row", fullCsv.includes('Produto;'));
  check("4.3 CSV has Camiseta row", fullCsv.includes('"Camiseta Premium"'));
  check("4.4 CSV has margin 60 for Camiseta", fullCsv.includes('60;'));
  check("4.5 CSV has 3 data rows", csv.split('\n').length === 3);

  // ---- Summary ----
  console.log("\n──── Resultados ────");
  for (const r of results) {
    console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.detail ? ` [${r.detail}]` : ""}`);
  }
  console.log(`\n${results.length} verificações, ${failures} falha(s).`);
  process.exit(failures > 0 ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
