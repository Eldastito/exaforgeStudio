/**
 * TESTE — ADR-086: scan por código de barras (só-catálogo-próprio, zero token)
 * ---------------------------------------------------------------------------
 * Prova, offline:
 *   - lookup pelo EAN no catálogo próprio (GTIN válido); código inválido e
 *     desconhecido tratados;
 *   - entrada por bipagem RESPEITA o ledger autoritativo do modo de estoque:
 *     native → núcleo (inventory_items); supervised → sombra por loja;
 *   - supervised sem loja informada → erro store_required; isolamento por org.
 *
 * Uso:  npm run test:retail-scan-barcode
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-retail-scanbc-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-retail-scanbc-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

const EAN = "7891000315507"; // GTIN-13 válido (dígito verificador correto)

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { RetailStoreService } = await import("../src/server/RetailStoreService.js");
  const { RetailStockModeService } = await import("../src/server/RetailStockModeService.js");
  const { RetailInventoryService } = await import("../src/server/RetailInventoryService.js");
  const { InventoryService } = await import("../src/server/InventoryService.js");
  const { RetailScanService } = await import("../src/server/RetailScanService.js");

  const A = `org_A_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'A', 'active')`).run(randomUUID(), A);
  const prodId = randomUUID();
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name, ean, price) VALUES (?, ?, 'product', 'Achocolatado 1kg', ?, 12.9)`).run(prodId, A, EAN);

  // ---- Lookup ----
  const hit = RetailScanService.lookupByEan(A, EAN);
  check("Lookup: acha o produto pelo EAN", hit.found === true && hit.product.id === prodId);
  check("Lookup: EAN inválido → invalid", RetailScanService.lookupByEan(A, "123").invalid === true);
  check("Lookup: EAN válido não cadastrado → não encontrado", RetailScanService.lookupByEan(A, "7891000053508").found === false);

  // ---- Entrada NATIVE → núcleo ----
  const r1 = RetailScanService.scanReceive(A, EAN, 5, {}, "u1");
  check("Entrada native usa o ledger 'core'", r1.ledger === "core" && r1.quantity === 5);
  check("Núcleo creditado: +5", InventoryService.sellable(A, prodId, null) === 5);

  // ---- Entrada SUPERVISED → sombra por loja ----
  const s1 = RetailStoreService.create(A, { name: "Loja 1" });
  RetailStockModeService.setStoreOverride(A, s1.id, "supervised", "u1");
  const r2 = RetailScanService.scanReceive(A, EAN, 3, { storeId: s1.id }, "u1");
  check("Entrada supervised usa o ledger 'shadow'", r2.ledger === "shadow");
  check("Sombra da loja creditada: +3", Number(RetailInventoryService.get(A, s1.id, prodId, null)?.quantity_available) === 3);
  check("Núcleo NÃO mudou (segue 5)", InventoryService.sellable(A, prodId, null) === 5);

  // ---- Supervised sem loja → erro ----
  RetailStockModeService.setOrgMode(A, "supervised", "u1");
  let threw = false;
  try { RetailScanService.scanReceive(A, EAN, 1, {}, "u1"); } catch (e: any) { threw = e.message === "store_required"; }
  check("Supervised sem loja → store_required", threw);

  // ---- Isolamento ----
  const B = `org_B_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'B', 'active')`).run(randomUUID(), B);
  check("Isolamento: B não acha o produto de A", RetailScanService.lookupByEan(B, EAN).found === false);

  console.log("\n=== ADR-086: scan por código de barras (só-catálogo) ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
