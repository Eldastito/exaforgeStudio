/**
 * TESTE — "Coleção encerrada": ocultar produtos com estoque zerado (modelo Toulon)
 * ----------------------------------------------------------------------------
 * Prova, offline, a cláusula de exclusão usada em GET /api/products quando a org
 * liga `hide_out_of_stock_products`:
 *   - produto com controle de estoque e saldo 0 é OMITIDO;
 *   - produto com saldo > 0, serviço e produto sem controle de estoque aparecem;
 *   - saldo por LOJA (retail_store_inventory) conta (rede de filiais);
 *   - escape includeOutOfStock (sem a cláusula) traz tudo — histórico preservado.
 *
 * Uso:  npm run test:product-hide-oos
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-hide-oos-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-hide-oos-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

// Mesma cláusula do endpoint (correlata por ps).
const EXCLUDE = `NOT (ps.stock_control_enabled = 1 AND (
  COALESCE((SELECT ii.quantity_available FROM inventory_items ii WHERE ii.product_service_id = ps.id AND ii.variant_id IS NULL),
           (SELECT SUM(ii.quantity_available) FROM inventory_items ii WHERE ii.product_service_id = ps.id AND ii.variant_id IS NOT NULL),
           (SELECT SUM(rsi.quantity_available) FROM retail_store_inventory rsi WHERE rsi.product_service_id = ps.id), 0)
- COALESCE((SELECT ii.quantity_reserved FROM inventory_items ii WHERE ii.product_service_id = ps.id AND ii.variant_id IS NULL),
           (SELECT SUM(ii.quantity_reserved) FROM inventory_items ii WHERE ii.product_service_id = ps.id AND ii.variant_id IS NOT NULL),
           (SELECT SUM(rsi.quantity_reserved) FROM retail_store_inventory rsi WHERE rsi.product_service_id = ps.id), 0)
) <= 0)`;

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const org = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (organization_id, hide_out_of_stock_products) VALUES (?, 1)`).run(org);

  const mkProd = (name: string, stockCtrl: number) => {
    const id = randomUUID();
    db.prepare(`INSERT INTO products_services (id, organization_id, name, type, active, price, stock_control_enabled) VALUES (?, ?, ?, 'product', 1, 10, ?)`).run(id, org, name, stockCtrl);
    return id;
  };
  const addOwn = (pid: string, qty: number) => db.prepare(`INSERT INTO inventory_items (id, organization_id, product_service_id, variant_id, quantity_available, quantity_reserved) VALUES (?, ?, ?, NULL, ?, 0)`).run(randomUUID(), org, pid, qty);
  const addStore = (pid: string, qty: number) => db.prepare(`INSERT INTO retail_store_inventory (id, organization_id, product_service_id, store_id, quantity_available, quantity_reserved) VALUES (?, ?, ?, ?, ?, 0)`).run(randomUUID(), org, pid, randomUUID(), qty);

  const comEstoque = mkProd("Com estoque", 1); addOwn(comEstoque, 5);
  const zerado = mkProd("Zerado", 1); addOwn(zerado, 0);
  const semLinha = mkProd("Zerado sem linha", 1); // sem inventory → 0
  const soLoja = mkProd("Só na filial", 1); addStore(soLoja, 3);
  const semControle = mkProd("Sem controle de estoque", 0); // não tem "esgotado"
  const servId = randomUUID();
  db.prepare(`INSERT INTO products_services (id, organization_id, name, type, active, price, stock_control_enabled) VALUES (?, ?, 'Serviço', 'service', 1, 10, 0)`).run(servId, org);

  // Com a flag (aplica EXCLUDE):
  const visibles = new Set((db.prepare(`SELECT ps.id FROM products_services ps WHERE ps.organization_id = ? AND ${EXCLUDE}`).all(org) as any[]).map((r) => r.id));
  check("com flag: produto com estoque aparece", visibles.has(comEstoque));
  check("com flag: produto ZERADO some", !visibles.has(zerado));
  check("com flag: zerado sem linha de estoque some", !visibles.has(semLinha));
  check("com flag: com saldo só na filial aparece", visibles.has(soLoja));
  check("com flag: sem controle de estoque aparece", visibles.has(semControle));
  check("com flag: serviço aparece", visibles.has(servId));

  // Escape includeOutOfStock (sem EXCLUDE): tudo aparece — histórico preservado.
  const all = new Set((db.prepare(`SELECT ps.id FROM products_services ps WHERE ps.organization_id = ?`).all(org) as any[]).map((r) => r.id));
  check("escape: zerado volta a aparecer (para editar/receber)", all.has(zerado) && all.has(semLinha));
  check("dado do zerado preservado (nunca apagado)", !!(db.prepare(`SELECT id FROM products_services WHERE id = ?`).get(zerado) as any));

  console.log("\n=== TEST: Coleção encerrada — ocultar estoque zerado ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
