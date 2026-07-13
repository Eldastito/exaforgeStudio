/**
 * TESTE — ADR-084 D5: graduação supervisor → nativo (loja única)
 * --------------------------------------------------------------
 * Prova, offline, o "resultado antes, migração depois":
 *   - uma loja supervisionada é promovida a nativa, semeando o núcleo
 *     (inventory_items) a partir do saldo da sombra (retail_store_inventory);
 *   - quantidade negativa da sombra entra no núcleo como 0 (clamp) e é contada;
 *   - após a graduação o modo resolve 'native' e o ledger autoritativo é 'core';
 *   - graduar de novo falha (already_native); loja inexistente falha; isolamento.
 *
 * Uso:  npm run test:retail-graduation
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-retail-grad-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-retail-grad-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { RetailStoreService } = await import("../src/server/RetailStoreService.js");
  const { RetailStockModeService } = await import("../src/server/RetailStockModeService.js");
  const { RetailGraduationService } = await import("../src/server/RetailGraduationService.js");
  const { InventoryService } = await import("../src/server/InventoryService.js");

  const A = `org_A_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'A', 'active')`).run(randomUUID(), A);
  const s1 = RetailStoreService.create(A, { name: "Loja Única" });
  RetailStockModeService.setOrgMode(A, "supervised", "u1");

  // Sombra: p1 = 10 (ok), p2 = -3 (divergência negativa).
  const p1 = randomUUID(), p2 = randomUUID();
  const shadow = (prod: string, qty: number) =>
    db.prepare(`INSERT INTO retail_store_inventory (id, organization_id, store_id, product_service_id, variant_id, quantity_available) VALUES (?, ?, ?, ?, NULL, ?)`)
      .run(randomUUID(), A, s1.id, prod, qty);
  shadow(p1, 10); shadow(p2, -3);

  check("Antes: loja resolve 'supervised' (ledger shadow)", RetailStockModeService.resolve(A, s1.id) === "supervised" && RetailStockModeService.authoritativeLedger(A, s1.id) === "shadow");

  // ---- Graduação ----
  const rep = RetailGraduationService.graduate(A, s1.id, "gestor");
  check("Graduação: 2 produtos semeados, 1 negativo clampado", rep.productsSeeded === 2 && rep.negativesClamped === 1);
  check("Graduação: fromMode supervised → toMode native", rep.fromMode === "supervised" && rep.toMode === "native");
  check("Após: loja resolve 'native' (ledger core)", RetailStockModeService.resolve(A, s1.id) === "native" && RetailStockModeService.authoritativeLedger(A, s1.id) === "core");
  check("Núcleo semeado: p1 = 10", InventoryService.sellable(A, p1, null) === 10);
  check("Núcleo semeado: p2 negativo virou 0 (clamp)", InventoryService.sellable(A, p2, null) === 0);

  // ---- Guardas ----
  let threw = false;
  try { RetailGraduationService.graduate(A, s1.id, "gestor"); } catch (e: any) { threw = e.message === "already_native"; }
  check("Graduar de novo falha (already_native)", threw);
  let threw2 = false;
  try { RetailGraduationService.graduate(A, "nao-existe", "gestor"); } catch (e: any) { threw2 = e.message === "store_not_found"; }
  check("Loja inexistente falha (store_not_found)", threw2);

  // ---- Isolamento ----
  const B = `org_B_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'B', 'active')`).run(randomUUID(), B);
  check("Isolamento: núcleo de B não foi semeado por A", InventoryService.sellable(B, p1, null) === null);

  console.log("\n=== ADR-084 D5: graduação supervisor → nativo (loja única) ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
