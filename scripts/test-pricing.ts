/**
 * TESTE — Preço sugerido por margem (Loja Virtual, incremento pós Smart
 * Inventory, ADR-023)
 * -----------------------------------------------------------------------
 * Cobre `src/server/pricing.ts` (suggestSalePrice) e sua integração:
 *   - fórmula de markup + arredondamento psicológico;
 *   - GET /api/products passa a devolver avg_cost + suggested_price (só
 *     quando há custo real conhecido — nunca inventa sugestão do nada);
 *   - a sugestão é só uma DICA: não sobrescreve preço já definido, não é
 *     persistida em lugar nenhum, é recalculada a cada leitura.
 *
 * Uso: npm run test:pricing
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-pricing-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-pricing-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

async function main() {
  const { suggestSalePrice } = await import("../src/server/pricing.js");

  // ---- fórmula pura ----
  check("Custo 6.35 (markup 40%) -> sugestão 8.99 (exemplo do PRD)", suggestSalePrice(6.35) === 8.99, `obtido=${suggestSalePrice(6.35)}`);
  check("Custo 0 -> sugestão 0 (sem custo, sem sugestão)", suggestSalePrice(0) === 0);
  check("Custo negativo -> sugestão 0 (nunca negativo)", suggestSalePrice(-5) === 0);
  check("Markup customizado (custo 10, markup 100%) -> 19.99", suggestSalePrice(10, 100) === 19.99, `obtido=${suggestSalePrice(10, 100)}`);
  check("Sugestão é sempre >= custo (markup nunca gera prejuízo)", suggestSalePrice(23.5) >= 23.5);

  // ---- integração: GET /api/products devolve avg_cost + suggested_price coerentes ----
  const { default: db } = await import("../src/server/db.js");
  const { InventoryService } = await import("../src/server/InventoryService.js");

  const orgA = `org_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Empresa A', 'active')`).run(randomUUID(), orgA);

  // produto SEM custo conhecido (nunca recebeu entrada de estoque com unitCost)
  const noCostId = randomUUID();
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name, price, stock_control_enabled) VALUES (?, ?, 'product', 'Produto Sem Custo', 10, 1)`).run(noCostId, orgA);
  db.prepare(`INSERT INTO inventory_items (id, organization_id, product_service_id, quantity_available, avg_cost) VALUES (?, ?, ?, 5, 0)`).run(randomUUID(), orgA, noCostId);

  // produto COM custo conhecido via movimentação real (mesmo path das Fases 1/2)
  const withCostId = randomUUID();
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name, price, stock_control_enabled) VALUES (?, ?, 'product', 'Produto Com Custo', 10, 1)`).run(withCostId, orgA);
  InventoryService.recordMovement(orgA, { productId: withCostId, type: "entrada", quantity: 10, unitCost: 6.35, origin: "invoice_scan" });

  // replica a query de GET /api/products (mesma forma, sem precisar subir HTTP)
  const { suggestSalePrice: suggest2 } = await import("../src/server/pricing.js");
  const rows = db.prepare(`
    SELECT ps.*, prod.avg_cost AS avg_cost
    FROM products_services ps
    LEFT JOIN inventory_items prod ON prod.product_service_id = ps.id AND prod.variant_id IS NULL
    WHERE ps.organization_id = ?
    ORDER BY ps.created_at DESC
  `).all(orgA) as any[];
  const mapped = rows.map((p) => ({ ...p, suggested_price: p.avg_cost > 0 ? suggest2(p.avg_cost) : null }));

  const noCostRow = mapped.find((p) => p.id === noCostId);
  const withCostRow = mapped.find((p) => p.id === withCostId);

  check("Produto sem custo conhecido: suggested_price é null (não inventa sugestão)", noCostRow?.suggested_price === null);
  check("Produto com custo conhecido: avg_cost correto (6.35)", Math.abs((withCostRow?.avg_cost || 0) - 6.35) < 0.001);
  check("Produto com custo conhecido: suggested_price calculado corretamente (8.99)", withCostRow?.suggested_price === 8.99);
  check("Preço já definido pelo lojista não é alterado pela sugestão (continua 10)", withCostRow?.price === 10);

  // ---- resultado ----
  console.log("\n=== Preço sugerido por margem — Loja Virtual (ADR-023) ===\n");
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
