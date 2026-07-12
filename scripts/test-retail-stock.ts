/**
 * TESTE — Retail Ops Fase F: estoque negativo por loja (ADR-083)
 * -------------------------------------------------------------
 * Prova, offline, a detecção de estoque negativo por loja (o core segue
 * clampado e intocado — a camada por loja PERMITE negativo para expor a
 * divergência):
 *   - saldo por loja pode ficar < 0 (setQuantity/applyMovement);
 *   - ao ficar negativo, abre-se um retail_stock_alert com causas prováveis;
 *   - ao normalizar, o alerta é resolvido; reabre se cair de novo;
 *   - resolução manual; listagem de negativos por org/loja; isolamento.
 *
 * Uso:  npm run test:retail-stock
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-retail-f-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-retail-f-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { RetailStoreService } = await import("../src/server/RetailStoreService.js");
  const { RetailInventoryService } = await import("../src/server/RetailInventoryService.js");

  const A = `org_A_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'A', 'active')`).run(randomUUID(), A);
  const store = RetailStoreService.create(A, { name: "Loja Barra" });
  const prod = randomUUID();
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name, price) VALUES (?, ?, 'product', 'Camiseta', 50)`).run(prod, A);

  // ---- 1. Vender além do saldo → negativo → alerta ----
  RetailInventoryService.setQuantity(A, store.id, prod, null, 10);
  RetailInventoryService.applyMovement(A, store.id, prod, null, -15); // vende 15 de 10 → -5
  const row = RetailInventoryService.get(A, store.id, prod, null);
  check("Saldo por loja PODE ficar negativo (-5)", row.quantity_available === -5);
  const neg = RetailInventoryService.listNegative(A);
  check("Item negativo listado", neg.length === 1 && neg[0].product_service_id === prod);
  const alerts = RetailInventoryService.listAlerts(A);
  check("Alerta de estoque negativo aberto", alerts.length === 1 && alerts[0].quantity === -5 && alerts[0].status === "open");
  check("Alerta traz causas prováveis", Array.isArray(alerts[0].possibleCauses) && alerts[0].possibleCauses.length >= 3);

  // ---- 2. Normalizar → alerta resolvido ----
  RetailInventoryService.applyMovement(A, store.id, prod, null, 10); // -5 + 10 = 5
  check("Ao normalizar, some dos negativos", RetailInventoryService.listNegative(A).length === 0);
  check("Alerta é resolvido automaticamente", RetailInventoryService.listAlerts(A, "open").length === 0);

  // ---- 3. Cair de novo → reabre o mesmo alerta (sem duplicar) ----
  RetailInventoryService.setQuantity(A, store.id, prod, null, -3);
  const open2 = RetailInventoryService.listAlerts(A, "open");
  check("Reabre o alerta ao cair de novo (sem duplicar)", open2.length === 1 && open2[0].quantity === -3);

  // ---- 4. Resolução manual ----
  const resolved = RetailInventoryService.resolveAlert(A, open2[0].id, "ajuste de inventário");
  check("Resolução manual marca 'resolved' com nota", resolved.status === "resolved" && resolved.resolution_note === "ajuste de inventário");

  // ---- 5. Isolamento ----
  const B = `org_B_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'B', 'active')`).run(randomUUID(), B);
  check("Isolamento: B não vê estoque/alertas de A", RetailInventoryService.listNegative(B).length === 0 && RetailInventoryService.listAlerts(B, "resolved").length === 0);

  console.log("\n=== Retail Ops — Fase F: estoque negativo por loja (ADR-083) ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
