/**
 * TESTE — Mais/menos vendidos (ADR-027, item 30 do backlog)
 * -----------------------------------------------------------
 * Cobre a consulta de GET /api/products/sales-analytics (replicada aqui na
 * camada de dados, mesmo padrão dos demais testes):
 *   - só pedidos que viraram receita contam (mesmo filtro de status do
 *     best_sellers da vitrine — 'aguardando_pagamento'/'cancelado' ficam fora);
 *   - produto ativo com ZERO venda aparece na lista dos menos vendidos;
 *   - janela de período respeitada (venda antiga fora da janela não conta);
 *   - isolamento por organização;
 *   - produto inativo não aparece.
 *
 * Uso: npm run test:sales-analytics
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-sales-analytics-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-sales-analytics-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

async function main() {
  const { default: db } = await import("../src/server/db.js");

  const orgA = `org_${randomUUID().slice(0, 6)}`;
  const orgB = `org_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Empresa A', 'active')`).run(randomUUID(), orgA);
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Empresa B', 'active')`).run(randomUUID(), orgB);

  function seedProduct(orgId: string, name: string, active = 1) {
    const id = randomUUID();
    db.prepare(`INSERT INTO products_services (id, organization_id, type, name, price, active) VALUES (?, ?, 'product', ?, 10, ?)`).run(id, orgId, name, active);
    return id;
  }
  function seedOrder(orgId: string, status: string, items: { productId: string; qty: number; price: number }[], daysAgo = 0) {
    const orderId = randomUUID();
    const createdAt = new Date(Date.now() - daysAgo * 86400000).toISOString().replace("T", " ").slice(0, 19);
    db.prepare(`INSERT INTO orders (id, organization_id, status, total_amount, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(orderId, orgId, status, items.reduce((s, i) => s + i.qty * i.price, 0), createdAt);
    for (const it of items) {
      db.prepare(`INSERT INTO order_items (id, order_id, organization_id, product_service_id, name_snapshot, unit_price, quantity, line_total) VALUES (?, ?, ?, ?, 'x', ?, ?, ?)`)
        .run(randomUUID(), orderId, orgId, it.productId, it.price, it.qty, it.qty * it.price);
    }
  }

  const campeao = seedProduct(orgA, "Produto Campeão");
  const mediano = seedProduct(orgA, "Produto Mediano");
  const encalhado = seedProduct(orgA, "Produto Encalhado");
  const inativo = seedProduct(orgA, "Produto Inativo", 0);
  const deOutraOrg = seedProduct(orgB, "Produto da Org B");

  seedOrder(orgA, "pago", [{ productId: campeao, qty: 10, price: 10 }]);
  seedOrder(orgA, "concluido", [{ productId: campeao, qty: 5, price: 10 }, { productId: mediano, qty: 2, price: 10 }]);
  seedOrder(orgA, "cancelado", [{ productId: encalhado, qty: 100, price: 10 }]); // cancelado NÃO conta
  seedOrder(orgA, "aguardando_pagamento", [{ productId: encalhado, qty: 50, price: 10 }]); // não pago NÃO conta
  seedOrder(orgA, "pago", [{ productId: mediano, qty: 3, price: 10 }], 90); // fora da janela de 30 dias
  seedOrder(orgB, "pago", [{ productId: deOutraOrg, qty: 99, price: 10 }]);

  // mesma consulta da rota
  function salesAnalytics(orgId: string, days: number) {
    const rows = db.prepare(`
      SELECT ps.id, ps.name, ps.price,
        COALESCE(s.units, 0) AS units_sold,
        COALESCE(s.revenue, 0) AS revenue
      FROM products_services ps
      LEFT JOIN (
        SELECT oi.product_service_id, SUM(oi.quantity) units, SUM(oi.line_total) revenue
        FROM order_items oi JOIN orders o ON o.id = oi.order_id
        WHERE o.organization_id = ? AND o.status IN ('pago','em_preparo','entregue','concluido')
          AND o.created_at >= datetime('now', ?)
        GROUP BY oi.product_service_id
      ) s ON s.product_service_id = ps.id
      WHERE ps.organization_id = ? AND ps.type = 'product' AND ps.active = 1
      ORDER BY units_sold DESC, revenue DESC
    `).all(orgId, `-${days} days`, orgId) as any[];
    return rows;
  }

  const rows30 = salesAnalytics(orgA, 30);
  const byName = (n: string) => rows30.find((r) => r.name === n);

  check("Produto inativo não aparece", !byName("Produto Inativo"));
  check("Produto de outra organização não aparece (isolamento)", !byName("Produto da Org B"));
  check("Campeão soma as vendas pagas+concluídas (15 un)", byName("Produto Campeão")?.units_sold === 15, `un=${byName("Produto Campeão")?.units_sold}`);
  check("Campeão em 1º lugar", rows30[0]?.name === "Produto Campeão");
  check("Pedido cancelado/aguardando pagamento NÃO conta (encalhado = 0)", byName("Produto Encalhado")?.units_sold === 0);
  check("Encalhado aparece na lista mesmo com zero vendas (o insight mais importante)", !!byName("Produto Encalhado"));
  check("Venda fora da janela de 30 dias não conta (mediano = 2, não 5)", byName("Produto Mediano")?.units_sold === 2, `un=${byName("Produto Mediano")?.units_sold}`);
  check("Receita do campeão correta (15 x R$10 = R$150)", Math.abs((byName("Produto Campeão")?.revenue || 0) - 150) < 0.001);

  const rows365 = salesAnalytics(orgA, 365);
  check("Janela de 1 ano inclui a venda antiga (mediano = 5)", rows365.find((r) => r.name === "Produto Mediano")?.units_sold === 5);

  const rowsB = salesAnalytics(orgB, 30);
  check("Org B só vê os próprios produtos/vendas", rowsB.length === 1 && rowsB[0].units_sold === 99);

  // ---- resultado ----
  console.log("\n=== Mais/menos vendidos (ADR-027) ===\n");
  for (const r of results) {
    console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
  }
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);

  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (failures > 0) process.exit(1);
}

main().catch((e) => {
  console.error("Erro fatal no teste:", e);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(1);
});
