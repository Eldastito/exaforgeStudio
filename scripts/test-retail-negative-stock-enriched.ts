/**
 * TESTE — Estoque negativo com identificação da peça (PRD Moda/TOULON, INV-001/002)
 * ----------------------------------------------------------------------------
 * Prova, offline (RetailInventoryService.listNegative):
 *   - enriquece o negativo com referência do produto, unidade, cor, tamanho,
 *     SKU (ref da variante) e EAN (sku da variante = código de barras);
 *   - store_code e source_synced_at (updated_at) presentes;
 *   - negativo SEM variante → campos de variante null, produto ainda presente;
 *   - EAN cai no product.ean quando a variante não tem código;
 *   - busca (q) casa por referência do produto e por EAN;
 *   - filtro por loja;
 *   - isolamento multi-tenant.
 *
 * Uso:  npm run test:retail-negative-stock-enriched
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-retail-negstock-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-negative-stock-enriched-123456";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { RetailInventoryService } = await import("../src/server/RetailInventoryService.js");

  const A = `org_${randomUUID().slice(0, 8)}`;
  const B = `org_${randomUUID().slice(0, 8)}`;

  const mkStore = (org: string, name: string, code: string) => {
    const id = randomUUID();
    db.prepare(`INSERT INTO retail_stores (id, organization_id, name, code, active) VALUES (?, ?, ?, ?, 1)`).run(id, org, name, code);
    return id;
  };
  const mkProduct = (org: string, name: string, extRef: string, uom: string | null, ean: string | null) => {
    const id = randomUUID();
    db.prepare(`INSERT INTO products_services (id, organization_id, type, name, external_ref, default_uom, ean) VALUES (?, ?, 'product', ?, ?, ?, ?)`)
      .run(id, org, name, extRef, uom, ean);
    return id;
  };
  const mkVariant = (org: string, productId: string, color: string, size: string, sku: string, extRef: string) => {
    const id = randomUUID();
    db.prepare(`INSERT INTO product_variants (id, organization_id, product_service_id, name, sku, size, color, external_ref, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`)
      .run(id, org, productId, `${size} / ${color}`, sku, size, color, extRef);
    return id;
  };

  const storeA = mkStore(A, "Savassi", "L1");
  // Produto COM variante: EAN no sku da variante.
  const camisa = mkProduct(A, "Camisa Slim", "REF-100", "UN", null);
  const varAzulM = mkVariant(A, camisa, "Azul", "M", "7890000000017", "ERPV-1");
  RetailInventoryService.setQuantity(A, storeA, camisa, varAzulM, -2);

  // Produto SEM variante: EAN no produto.
  const meia = mkProduct(A, "Meia Cano Alto", "REF-200", "PAR", "7890000000024");
  RetailInventoryService.setQuantity(A, storeA, meia, null, -5);

  // Org B (isolamento): outro negativo.
  const storeB = mkStore(B, "Loja B", "LB");
  const prodB = mkProduct(B, "Produto B", "REF-B", "UN", null);
  RetailInventoryService.setQuantity(B, storeB, prodB, null, -1);

  // ===== 1. Enriquecimento da variante =====
  const negA = RetailInventoryService.listNegative(A, {});
  check("org A vê 2 negativos (isolamento)", negA.total === 2, `total=${negA.total}`);
  const camisaNeg = negA.items.find((i: any) => i.product_name === "Camisa Slim") as any;
  check("referência do produto", camisaNeg?.product_external_ref === "REF-100");
  check("unidade do produto", camisaNeg?.product_uom === "UN");
  check("cor da variante", camisaNeg?.variant_color === "Azul");
  check("tamanho da variante", camisaNeg?.variant_size === "M");
  check("SKU = ref da variante", camisaNeg?.variant_sku === "ERPV-1");
  check("EAN = sku da variante (código de barras)", camisaNeg?.variant_ean === "7890000000017");
  check("store_code presente", camisaNeg?.store_code === "L1");
  check("source_synced_at presente", !!camisaNeg?.source_synced_at);
  check("saldo negativo preservado", camisaNeg?.quantity_available === -2);

  // ===== 2. Negativo SEM variante =====
  const meiaNeg = negA.items.find((i: any) => i.product_name === "Meia Cano Alto") as any;
  check("sem variante: cor null", meiaNeg?.variant_color === null);
  check("sem variante: tamanho null", meiaNeg?.variant_size === null);
  check("sem variante: SKU null", meiaNeg?.variant_sku === null);
  check("EAN cai no product.ean quando não há variante", meiaNeg?.variant_ean === "7890000000024");

  // ===== 3. Busca por referência e por EAN =====
  const byRef = RetailInventoryService.listNegative(A, { q: "REF-100" });
  check("busca por referência do produto", byRef.total === 1 && byRef.items[0].product_name === "Camisa Slim");
  const byEan = RetailInventoryService.listNegative(A, { q: "7890000000017" });
  check("busca por EAN (sku da variante)", byEan.total === 1 && byEan.items[0].product_name === "Camisa Slim");

  // ===== 4. Filtro por loja =====
  const byStore = RetailInventoryService.listNegative(A, { storeId: storeA });
  check("filtro por loja traz os 2 da Savassi", byStore.total === 2);

  // ===== 5. Isolamento =====
  const negB = RetailInventoryService.listNegative(B, {});
  check("org B só vê o próprio negativo", negB.total === 1 && negB.items[0].product_name === "Produto B");
  check("nenhum produto da org A vaza para B", !negB.items.some((i: any) => i.product_name === "Camisa Slim"));

  console.log("\n=== TEST: Estoque negativo enriquecido (INV Fase 1) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
