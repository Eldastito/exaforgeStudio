/**
 * TESTE — Referência da peça pelo código de barras (modelo Toulon)
 * ----------------------------------------------------------------------------
 * A Alterdata não envia a referência dos produtos, mas envia o EAN. A Toulon
 * identifica a peça pelos 6 PRIMEIROS DÍGITOS do código de barras. Prova:
 *   - referenceFromBarcode: 6 dígitos, ignora não-dígitos, null se < 6;
 *   - backfill: deriva do EAN do produto; se vazio, do SKU (EAN) da variante;
 *   - NÃO sobrescreve referência já preenchida; produto sem código → fica sem;
 *   - busca localiza a peça pela referência.
 *
 * Uso:  npm run test:product-reference
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-prod-ref-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-prod-ref-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { referenceFromBarcode } = await import("../src/server/eanUtil.js");

  // ===== 1. Helper puro =====
  check("1.1 6 primeiros dígitos", referenceFromBarcode("7891234000017") === "789123");
  check("1.2 ignora não-dígitos", referenceFromBarcode(" 78-91 23xx") === "789123");
  check("1.3 menos de 6 dígitos → null", referenceFromBarcode("12345") === null);
  check("1.4 vazio/nulo → null", referenceFromBarcode("") === null && referenceFromBarcode(null) === null);

  // ===== 2. Backfill (replica a lógica do endpoint) =====
  const org = `org_${randomUUID().slice(0, 8)}`;
  const mk = (name: string, ean: string | null) => {
    const id = randomUUID();
    db.prepare(`INSERT INTO products_services (id, organization_id, name, type, active, price, ean) VALUES (?, ?, ?, 'product', 1, 10, ?)`).run(id, org, name, ean);
    return id;
  };
  const pEan = mk("Camisa", "7891234000017");           // ref do EAN → 789123
  const pVar = mk("Bermuda", null);                      // ref do SKU da variante
  db.prepare(`INSERT INTO product_variants (id, organization_id, product_service_id, name, sku, variant_type, active) VALUES (?, ?, ?, 'P', '7899999000024', 'grade', 1)`).run(randomUUID(), org, pVar);
  const pManual = mk("Blazer", null);                    // já tem referência manual
  db.prepare(`UPDATE products_services SET reference = 'REF-MANUAL' WHERE id = ?`).run(pManual);
  const pNoCode = mk("Serviço sem código", null);        // sem EAN e sem variante → fica sem ref

  // replica o SELECT + UPDATE do endpoint /backfill-references
  const rows = db.prepare(
    `SELECT ps.id, COALESCE(NULLIF(ps.ean, ''), (SELECT v.sku FROM product_variants v WHERE v.product_service_id = ps.id AND v.sku IS NOT NULL AND v.sku != '' ORDER BY v.id LIMIT 1)) AS barcode
       FROM products_services ps
      WHERE ps.organization_id = ? AND ps.type = 'product' AND (ps.reference IS NULL OR ps.reference = '')`
  ).all(org) as any[];
  let updated = 0;
  for (const r of rows) { const ref = referenceFromBarcode(r.barcode); if (ref) { db.prepare(`UPDATE products_services SET reference = ? WHERE id = ?`).run(ref, r.id); updated++; } }

  const refOf = (id: string) => (db.prepare(`SELECT reference FROM products_services WHERE id = ?`).get(id) as any)?.reference;
  check("2.1 referência do EAN do produto", refOf(pEan) === "789123", refOf(pEan));
  check("2.2 referência do SKU da variante (fallback)", refOf(pVar) === "789999", refOf(pVar));
  check("2.3 referência manual preservada", refOf(pManual) === "REF-MANUAL");
  check("2.4 sem código de barras → fica sem referência", !refOf(pNoCode));
  check("2.5 backfill contou os 2 derivados", updated === 2, String(updated));

  // ===== 3. Busca localiza pela referência =====
  const like = "%789123%";
  const found = db.prepare(`SELECT id FROM products_services ps WHERE ps.organization_id = ? AND (ps.name LIKE ? OR ps.ean LIKE ? OR ps.reference LIKE ?)`).all(org, like, like, like) as any[];
  check("3.1 busca por referência acha a peça", found.some((f) => f.id === pEan));

  console.log("\n=== TEST: Referência pelo código de barras (Toulon) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
