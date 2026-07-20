/**
 * TEST — Relatório de vendas: cards por vertical + filtros (ADR-094).
 * Uso: npm run test:sales-report-vertical
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "zf-salesrep-"));
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-salesrep-1234567890abcdef";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { ReportsService } = await import("../src/server/ReportsService.js");

  const orgId = randomUUID(), sellerId = randomUUID();
  db.prepare(`INSERT INTO organization_settings (organization_id, business_name, status, vertical) VALUES (?, 'TOULON', 'active', 'moda')`).run(orgId);
  db.prepare(`INSERT INTO users (id, organization_id, name, email, role, global_status) VALUES (?, ?, 'Vendedor João', 'joao@t.com', 'agent', 'active')`).run(sellerId, orgId);

  const prodA = randomUUID(), prodB = randomUUID();
  db.prepare(`INSERT INTO products_services (id, organization_id, name, type, price, category, active) VALUES (?, ?, 'Camisa Polo', 'product', 50, 'Camisas', 1)`).run(prodA, orgId);
  db.prepare(`INSERT INTO products_services (id, organization_id, name, type, price, category, active) VALUES (?, ?, 'Calça Jeans', 'product', 80, 'Calças', 1)`).run(prodB, orgId);

  const mkOrder = (createdBy: string, status: string, total: number, items: { pid: string; name: string; qty: number; line: number }[]) => {
    const oid = randomUUID();
    db.prepare(`INSERT INTO orders (id, organization_id, status, total_amount, created_by) VALUES (?, ?, ?, ?, ?)`).run(oid, orgId, status, total, createdBy);
    for (const it of items) {
      db.prepare(`INSERT INTO order_items (id, order_id, organization_id, product_service_id, name_snapshot, unit_price, quantity, line_total) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(randomUUID(), oid, orgId, it.pid, it.name, it.line / it.qty, it.qty, it.line);
    }
    return oid;
  };

  mkOrder("storefront", "pago", 300, [{ pid: prodA, name: "Camisa Polo", qty: 5, line: 250 }, { pid: prodB, name: "Calça Jeans", qty: 1, line: 50 }]);
  mkOrder("ai", "aguardando_pagamento", 80, [{ pid: prodB, name: "Calça Jeans", qty: 2, line: 80 }]);
  mkOrder(sellerId, "cancelado", 999, [{ pid: prodA, name: "Camisa Polo", qty: 9, line: 999 }]); // cancelado -> fora
  mkOrder(sellerId, "pago", 100, [{ pid: prodA, name: "Camisa Polo", qty: 1, line: 100 }]);

  const card = (rep: any, key: string) => [...rep.coreCards, ...rep.verticalCards].find((c: any) => c.key === key)?.value;

  // 1. Core sem filtro (cancelado fora).
  const r = ReportsService.salesReport(orgId, { period: "30" });
  check("1.1 faturamento exclui cancelado", card(r, "revenue") === 480); // 300 + 80 + 100
  check("1.2 pedidos não cancelados = 3", card(r, "orders") === 3);
  check("1.3 pedidos pagos = 2", card(r, "paid") === 2);
  check("1.4 ticket médio = 160", Math.round(card(r, "ticket")) === 160);

  // 2. Cards da vertical moda.
  check("2.1 é vertical moda", r.vertical === "moda");
  check("2.2 peça mais vendida = Camisa Polo (qtd 6)", card(r, "top_product") === "Camisa Polo");
  check("2.3 peça menos vendida = Calça Jeans", card(r, "bottom_product") === "Calça Jeans");
  check("2.4 categoria que mais vende = Camisas", card(r, "top_category") === "Camisas");
  check("2.5 topProducts ordenado por qtd", r.topProducts[0].name === "Camisa Polo" && r.topProducts[0].qty === 6);

  // 3. Filtro por canal (derivado de created_by).
  const loja = ReportsService.salesReport(orgId, { period: "30", channel: "loja" });
  check("3.1 canal loja só o pedido storefront", card(loja, "revenue") === 300 && card(loja, "orders") === 1);
  const wpp = ReportsService.salesReport(orgId, { period: "30", channel: "whatsapp" });
  check("3.2 canal whatsapp só o pedido 'ai'", card(wpp, "revenue") === 80);

  // 4. Filtro por vendedor (created_by = userId).
  const bySeller = ReportsService.salesReport(orgId, { period: "30", seller: sellerId });
  check("4.1 vendedor: só o pedido pago dele (cancelado fora)", card(bySeller, "revenue") === 100 && card(bySeller, "orders") === 1);

  // 5. Filtro por categoria (pedido que contém item da categoria).
  const camisas = ReportsService.salesReport(orgId, { period: "30", category: "Camisas" });
  check("5.1 categoria Camisas: pedidos com Camisa (storefront + vendedor)", card(camisas, "revenue") === 400);

  // 6. Opções dos dropdowns.
  check("6.1 categorias disponíveis", r.options.categories.includes("Camisas") && r.options.categories.includes("Calças"));
  check("6.2 vendedor aparece na lista", r.options.sellers.some((s: any) => s.id === sellerId && s.name === "Vendedor João"));

  console.log("\n=== test:sales-report-vertical ===");
  for (const x of results) console.log(`${x.ok ? "✅" : "❌"} ${x.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  if (failures > 0) { console.error(`\n❌ ${failures} falha(s).`); process.exit(1); }
  console.log("\n✅ Relatório por vertical + filtros OK.");
}

main().catch((e) => { console.error(e); process.exit(1); });
