/**
 * TESTE — Ciclo de vida da vitrine: ocultar/restaurar por estoque + histórico
 * versionado de edições (ADR-033)
 * -------------------------------------------------------------------------
 * Dois recursos puramente determinísticos (sem IA), então testados de ponta
 * a ponta de verdade:
 *   1. Auto-ocultar da vitrine quando o estoque zera / restaurar ao repor —
 *      opt-in por loja, nunca sobrepõe uma escolha manual do lojista nem
 *      publica um produto sem preço (recusa da Fase B, ADR-032).
 *   2. Histórico versionado (diff) de cada edição pós-criação.
 *
 * Uso: npm run test:store-lifecycle
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-store-lifecycle-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-store-lifecycle-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { InventoryService } = await import("../src/server/InventoryService.js");
  const { InventoryIntakeService } = await import("../src/server/InventoryIntakeService.js");
  const { ProductEditHistoryService } = await import("../src/server/ProductEditHistoryService.js");

  const orgA = `org_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Empresa A', 'active')`).run(randomUUID(), orgA);
  db.prepare(`INSERT INTO storefront_settings (organization_id, slug) VALUES (?, 'empresa-a')`).run(orgA);

  // ---- schema ----
  const productCols = (db.prepare(`PRAGMA table_info(products_services)`).all() as any[]).map((c) => c.name);
  check("products_services tem coluna out_of_stock_hidden", productCols.includes("out_of_stock_hidden"));
  const storefrontCols = (db.prepare(`PRAGMA table_info(storefront_settings)`).all() as any[]).map((c) => c.name);
  check("storefront_settings tem coluna auto_hide_out_of_stock", storefrontCols.includes("auto_hide_out_of_stock"));
  const historyCols = (db.prepare(`PRAGMA table_info(product_edit_history)`).all() as any[]).map((c) => c.name);
  for (const col of ["id", "organization_id", "product_id", "changed_by", "changed_fields_json", "created_at"]) {
    check(`product_edit_history tem coluna ${col}`, historyCols.includes(col));
  }

  function createProduct(price: number | null, quantity: number): string {
    const id = randomUUID();
    db.prepare(
      `INSERT INTO products_services (id, organization_id, type, name, price, stock_control_enabled, storefront_visible, slug)
       VALUES (?, ?, 'product', 'Produto Teste', ?, 1, ?, ?)`
    ).run(id, orgA, price, price != null ? 1 : 0, `produto-teste-${id.slice(0, 8)}`);
    db.prepare(`INSERT INTO inventory_items (id, organization_id, product_service_id, quantity_available) VALUES (?, ?, ?, ?)`)
      .run(randomUUID(), orgA, id, quantity);
    return id;
  }
  function getProduct(id: string): any {
    return db.prepare(`SELECT * FROM products_services WHERE id = ?`).get(id);
  }

  // ---- toggle DESLIGADO (padrão): estoque zerar nunca mexe na vitrine ----
  const pOff = createProduct(9.9, 5);
  InventoryService.recordMovement(orgA, { productId: pOff, type: "saida", quantity: 5 });
  check("Toggle desligado: estoque zerado NÃO esconde o produto", getProduct(pOff)?.storefront_visible === 1);

  // ---- liga o toggle ----
  db.prepare(`UPDATE storefront_settings SET auto_hide_out_of_stock = 1 WHERE organization_id = ?`).run(orgA);

  // ---- estoque zera via recordMovement (saída) -> esconde ----
  const p1 = createProduct(9.9, 5);
  InventoryService.recordMovement(orgA, { productId: p1, type: "saida", quantity: 5 });
  const afterZero = getProduct(p1);
  check("Toggle ligado: estoque zerado ESCONDE o produto (storefront_visible=0)", afterZero?.storefront_visible === 0);
  check("Toggle ligado: out_of_stock_hidden marca que foi o sistema", afterZero?.out_of_stock_hidden === 1);

  // ---- repõe via recordMovement (entrada) -> restaura ----
  InventoryService.recordMovement(orgA, { productId: p1, type: "entrada", quantity: 10 });
  const afterRestock = getProduct(p1);
  check("Reposição via nota fiscal RESTAURA a vitrine", afterRestock?.storefront_visible === 1);
  check("Reposição limpa out_of_stock_hidden", afterRestock?.out_of_stock_hidden === 0);

  // ---- reserve()/release() (fluxo de pedido) também disparam o sync ----
  const p2 = createProduct(15, 3);
  InventoryService.reserve(orgA, p2, 3);
  check("Reserva total (pedido) esconde o produto (sellable=0)", getProduct(p2)?.storefront_visible === 0);
  InventoryService.release(orgA, p2, 3);
  check("Liberar a reserva (pedido cancelado) restaura o produto", getProduct(p2)?.storefront_visible === 1);

  // ---- restock() e setQuantity() também dispararam o sync ----
  const p3 = createProduct(20, 1);
  InventoryService.commit(orgA, p3, 1); // baixa direta (pedido pago) -> zera
  check("commit() (baixa por pedido) esconde o produto", getProduct(p3)?.storefront_visible === 0);
  InventoryService.restock(orgA, p3, 2);
  check("restock() restaura o produto", getProduct(p3)?.storefront_visible === 1);
  InventoryService.setQuantity(orgA, p3, 0);
  check("setQuantity(0) (ajuste manual) esconde o produto", getProduct(p3)?.storefront_visible === 0);

  // ---- produto SEM controle de estoque nunca é afetado ----
  const pNoStock = randomUUID();
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name, price, stock_control_enabled, storefront_visible, slug) VALUES (?, ?, 'product', 'Serviço', 50, 0, 1, ?)`)
    .run(pNoStock, orgA, `servico-${pNoStock.slice(0, 8)}`);
  InventoryService.recordMovement(orgA, { productId: pNoStock, type: "saida", quantity: 999 });
  check("Produto sem controle de estoque nunca é escondido pelo mecanismo", (db.prepare(`SELECT storefront_visible FROM products_services WHERE id = ?`).get(pNoStock) as any)?.storefront_visible === 1);

  // ---- produto com recusa de preço (Fase B) NUNCA é restaurado, mesmo com estoque positivo ----
  const declinedId = InventoryIntakeService.commitProductWithoutPrice(orgA, { name: "Sem Preço", quantity: 0, imageUrl: "/media/x.jpg" });
  InventoryService.recordMovement(orgA, { productId: declinedId, type: "entrada", quantity: 10 });
  check("Produto sem preço (recusa) continua fora da vitrine mesmo com estoque positivo", getProduct(declinedId)?.storefront_visible === 0);

  // ---- movimentação em VARIAÇÃO não esconde o produto-base inteiro ----
  const pVariant = createProduct(30, 5);
  const variantId = randomUUID();
  db.prepare(`INSERT INTO product_variants (id, organization_id, product_service_id, name) VALUES (?, ?, ?, 'Tamanho P')`).run(variantId, orgA, pVariant);
  db.prepare(`INSERT INTO inventory_items (id, organization_id, product_service_id, variant_id, quantity_available) VALUES (?, ?, ?, ?, 3)`).run(randomUUID(), orgA, pVariant, variantId);
  InventoryService.recordMovement(orgA, { productId: pVariant, variantId, type: "saida", quantity: 3 });
  check("Zerar o estoque de UMA variação não esconde o produto inteiro", getProduct(pVariant)?.storefront_visible === 1);

  // ---- histórico versionado: diff correto, no-op não grava nada ----
  const beforeSnap = { name: "Nome Antigo", price: 10, category: "Grãos", description: "desc antiga", active: 1 };
  ProductEditHistoryService.record(orgA, p1, "user-1", beforeSnap, { name: "Nome Novo", price: 12 });
  const hist1 = ProductEditHistoryService.list(orgA, p1);
  check("Histórico grava exatamente os campos alterados", hist1.length === 1 && hist1[0].changedFields.length === 2);
  const fieldNames = hist1[0].changedFields.map((f: any) => f.field).sort();
  check("Histórico lista name e price como alterados", fieldNames.join(",") === "name,price");
  const priceChange = hist1[0].changedFields.find((f: any) => f.field === "price");
  check("Histórico grava valor ANTES e DEPOIS do preço", priceChange?.before === 10 && priceChange?.after === 12);

  ProductEditHistoryService.record(orgA, p1, "user-1", beforeSnap, { name: "Nome Antigo", price: 10 });
  const hist2 = ProductEditHistoryService.list(orgA, p1);
  check("Edição sem mudança real (mesmos valores) NÃO grava histórico novo", hist2.length === 1);

  ProductEditHistoryService.record(orgA, p1, "user-2", beforeSnap, { category: "Mercearia" });
  const hist3 = ProductEditHistoryService.list(orgA, p1);
  check("Segunda edição real aparece no topo (mais recente primeiro)", hist3.length === 2 && hist3[0].changedFields[0].field === "category");
  check("Histórico registra quem alterou (changedBy)", hist3[0].changedBy === "user-2");

  // ---- resultado ----
  console.log("\n=== Ciclo de vida da vitrine: auto-ocultar por estoque + histórico versionado (ADR-033) ===\n");
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
