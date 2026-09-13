/**
 * TEST — vitrine só exibe produto com estoque (auto_hide_out_of_stock).
 * Prova o saldo vendável combinando estoque próprio (inventory_items base/variação)
 * + estoque de loja (retail_store_inventory), e a cláusula SQL que exclui esgotado
 * da listagem pública (contagem/paginação). Serviço/sem-controle nunca é escondido.
 * Uso: npm run test:storefront-stock
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-storestock-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-storestock-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { StorefrontStockService: S } = await import("../src/server/StorefrontStockService.js");
  const ORG = `org_${randomUUID().slice(0, 8)}`;

  const mkProduct = (name: string, stockControl = true) => {
    const id = randomUUID();
    db.prepare("INSERT INTO products_services (id, organization_id, type, name, description, price, stock_control_enabled, slug) VALUES (?, ?, 'product', ?, '', 10, ?, ?)")
      .run(id, ORG, name, stockControl ? 1 : 0, name.toLowerCase().replace(/[^a-z0-9]+/g, "-"));
    return id;
  };
  const setOwn = (pid: string, avail: number, reserved = 0, variant: string | null = null) =>
    db.prepare("INSERT INTO inventory_items (id, organization_id, product_service_id, variant_id, quantity_available, quantity_reserved) VALUES (?, ?, ?, ?, ?, ?)")
      .run(randomUUID(), ORG, pid, variant, avail, reserved);
  const setStore = (pid: string, avail: number, reserved = 0) =>
    db.prepare("INSERT INTO retail_store_inventory (id, organization_id, store_id, product_service_id, variant_id, quantity_available, quantity_reserved) VALUES (?, ?, ?, ?, NULL, ?, ?)")
      .run(randomUUID(), ORG, `store_${randomUUID().slice(0, 6)}`, pid, avail, reserved);

  // ── 1. estoque próprio (inventory_items base) ──
  const p1 = mkProduct("Camisa Azul"); setOwn(p1, 5);
  check("1.1 estoque próprio 5 → vendável 5", S.sellable(p1) === 5);
  const p1b = mkProduct("Camisa Vermelha"); setOwn(p1b, 0);
  check("1.2 estoque próprio 0 → vendável 0", S.sellable(p1b) === 0);
  const p1c = mkProduct("Camisa Reservada"); setOwn(p1c, 2, 2);
  check("1.3 disponível 2 reservado 2 → vendável 0", S.sellable(p1c) === 0);

  // ── 2. estoque só de loja (rede/Alterdata) — o caso que estava quebrado ──
  const p2 = mkProduct("Calça Rede"); setStore(p2, 3);
  check("2.1 estoque de loja 3 (sem inventory_items) → vendável 3", S.sellable(p2) === 3);
  const p2b = mkProduct("Calça Rede Zerada"); setStore(p2b, 0);
  check("2.2 estoque de loja 0 → vendável 0", S.sellable(p2b) === 0);

  // ── 3. variações somam ──
  const p3 = mkProduct("Tênis"); setOwn(p3, 1, 0, "var_a"); setOwn(p3, 2, 0, "var_b");
  check("3.1 variações 1+2 → vendável 3", S.sellable(p3) === 3);

  // ── 4. cláusula SQL de exclusão na listagem ──
  const pService = mkProduct("Consultoria", false); // sem controle de estoque
  const visible = (db.prepare(
    `SELECT id FROM products_services WHERE organization_id = ? AND ${S.OUT_OF_STOCK_EXCLUDE_SQL}`
  ).all(ORG) as any[]).map(r => r.id);
  const vis = new Set(visible);
  check("4.1 com estoque próprio aparece", vis.has(p1));
  check("4.2 com estoque de loja aparece", vis.has(p2));
  check("4.3 esgotado (próprio) some", !vis.has(p1b));
  check("4.4 esgotado (reservado) some", !vis.has(p1c));
  check("4.5 esgotado (loja) some", !vis.has(p2b));
  check("4.6 serviço sem controle de estoque nunca some", vis.has(pService));
  check("4.7 variações somam → aparece", vis.has(p3));

  console.log("\n=== Vitrine: só produto com estoque ===");
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} storefront-stock: ${results.length - failures}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
