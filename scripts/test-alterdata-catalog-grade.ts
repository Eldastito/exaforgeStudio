/**
 * TESTE — Diagnóstico "a grade (tamanho/cor) está chegando da Alterdata?"
 *
 * Pedido TOULON: o dono precisa saber, num olhar, se o catálogo Supply da
 * Alterdata está trazendo a GRADE (variantes com tamanho/cor) — a fonte única
 * da loja virtual. `catalogGradeStatus` responde isso derivado por query:
 * grade = variantes importadas (external_ref + tamanho/cor). Variante manual
 * (sem external_ref) e variante do ERP sem grade NÃO contam. Isolado por org.
 *
 * Uso:  npm run test:alterdata-catalog-grade
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-adgrade-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-adgrade-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { AlterdataConnectorService } = await import("../src/server/AlterdataConnectorService.js");
  const { RetailStoreService } = await import("../src/server/RetailStoreService.js");

  const A = `org_A_${randomUUID().slice(0, 6)}`;
  const B = `org_B_${randomUUID().slice(0, 6)}`;
  for (const org of [A, B]) db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), org);

  const prod = (org: string, name: string, extRef: string | null) => { const id = randomUUID(); db.prepare(`INSERT INTO products_services (id, organization_id, type, name, price, active, external_ref) VALUES (?, ?, 'product', ?, 100, 1, ?)`).run(id, org, name, extRef); return id; };
  const variant = (org: string, p: string, size: string | null, color: string | null, extRef: string | null) => db.prepare(`INSERT INTO product_variants (id, organization_id, product_service_id, name, size, color, external_ref) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(randomUUID(), org, p, `${size || ""}/${color || ""}`, size, color, extRef);

  // ===== 1. org sem dado → sem grade, desconectada =====
  let g = AlterdataConnectorService.catalogGradeStatus(A);
  check("1.1 fresh: gradeFlowing false", g.gradeFlowing === false, JSON.stringify(g));
  check("1.2 fresh: desconectado (sem token)", g.connected === false);
  check("1.3 fresh: contadores zerados", g.variantsWithGrade === 0 && g.productsFromAlterdata === 0 && g.storeStockRows === 0);

  // ===== 2. catálogo da Alterdata com grade =====
  const pErp = prod(A, "Calça Slim", "REF-100");        // produto do ERP
  variant(A, pErp, "42", "Preto", "EAN-1");             // variante COM grade e external_ref → conta
  variant(A, pErp, null, null, "EAN-2");                // do ERP mas SEM grade (só ref) → NÃO conta
  const pManual = prod(A, "Produto Manual", null);      // sem external_ref (cadastro manual)
  variant(A, pManual, "G", "Azul", null);               // variante manual (sem external_ref) → NÃO conta

  const store = RetailStoreService.create(A, { name: "Loja Virtual", code: "1" }).id;
  db.prepare(`INSERT INTO retail_store_inventory (id, organization_id, store_id, product_service_id, variant_id, quantity_available) VALUES (?, ?, ?, ?, NULL, 5)`).run(randomUUID(), A, store, pErp);
  db.prepare(`INSERT INTO retail_store_inventory (id, organization_id, store_id, product_service_id, variant_id, quantity_available) VALUES (?, ?, ?, ?, NULL, 3)`).run(randomUUID(), A, store, pManual);

  g = AlterdataConnectorService.catalogGradeStatus(A);
  check("2.1 grade chegando (1 variante com grade do ERP)", g.gradeFlowing === true && g.variantsWithGrade === 1, JSON.stringify(g));
  check("2.2 variante do ERP SEM grade não conta", g.variantsWithGrade === 1);
  check("2.3 variante MANUAL (sem external_ref) não conta", g.variantsWithGrade === 1);
  check("2.4 produtos do ERP (external_ref) = 1 (manual não conta)", g.productsFromAlterdata === 1, `${g.productsFromAlterdata}`);
  check("2.5 saldos por loja = 2", g.storeStockRows === 2, `${g.storeStockRows}`);

  // ===== 3. isolamento por org =====
  const gB = AlterdataConnectorService.catalogGradeStatus(B);
  check("3.1 org B isolada (sem grade, sem saldo)", gB.variantsWithGrade === 0 && gB.productsFromAlterdata === 0 && gB.storeStockRows === 0);

  console.log("\n=== Diagnóstico grade Alterdata (loja virtual) ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
