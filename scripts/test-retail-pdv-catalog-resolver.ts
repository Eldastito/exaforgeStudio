/**
 * TESTE — Resolução de catálogo do PDV na ingestão (PDR TOULON, Fatia 4 / PERF-001).
 * ------------------------------------------------------------------------------
 * Prova, offline (RetailPdvCatalogResolver):
 *   - variante por external_ref/sku → exact (com variant_id + product_service_id);
 *   - produto por external_ref/ean → exact;
 *   - prefixo (EAN13 do ERP começa com o external_ref do catálogo) → prefix;
 *   - ambíguo (2 candidatos) → ambiguous, NÃO associa;
 *   - sem match → unmatched;
 *   - backfill em lote grava a resolução e zera o pendente; idempotente;
 *   - isolamento multi-tenant.
 *
 * Uso:  npm run test:retail-pdv-catalog-resolver
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-pdv-catalog-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-pdv-catalog-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { RetailPdvCatalogResolver: R } = await import("../src/server/RetailPdvCatalogResolver.js");

  const A = `org_A_${randomUUID().slice(0, 6)}`;
  const B = `org_B_${randomUUID().slice(0, 6)}`;
  for (const org of [A, B]) db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), org);

  // Catálogo: camisa (produto com external_ref EAN12) + variante (external_ref EAN13),
  // boné (produto por ean), e um par ambíguo (dois produtos com o mesmo external_ref).
  const camisa = randomUUID(), varM = randomUUID(), bone = randomUUID(), amb1 = randomUUID(), amb2 = randomUUID();
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name, external_ref) VALUES (?, ?, 'product', 'Camisa', '789100000001')`).run(camisa, A);
  db.prepare(`INSERT INTO product_variants (id, organization_id, product_service_id, name, external_ref, active) VALUES (?, ?, ?, 'M/Azul', '7891000000019', 1)`).run(varM, A, camisa);
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name, ean) VALUES (?, ?, 'product', 'Boné', '555000111')`).run(bone, A);
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name, external_ref) VALUES (?, ?, 'product', 'Amb1', '999000')`).run(amb1, A);
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name, external_ref) VALUES (?, ?, 'product', 'Amb2', '999000')`).run(amb2, A);

  // ===== 1. resoluções diretas =====
  const rVar = R.resolveCode(A, '7891000000019');
  check("variante por external_ref → exact + variant_id", rVar.status === 'exact' && rVar.variantId === varM && rVar.productServiceId === camisa);
  check("produto por ean → exact", R.resolveCode(A, '555000111').status === 'exact');
  // ERP manda EAN13 '7891000000015' cujo prefixo bate no external_ref '789100000001' (12) da CAMISA (produto)
  const rPref = R.resolveCode(A, '7891000000015');
  check("prefixo (EAN13 começa com external_ref) → prefix", rPref.status === 'prefix' && rPref.productServiceId === camisa, `status=${rPref.status}`);
  check("dois candidatos → ambiguous (não associa)", R.resolveCode(A, '999000').status === 'ambiguous' && R.resolveCode(A, '999000').productServiceId === null);
  check("sem match → unmatched", R.resolveCode(A, '000000000').status === 'unmatched');

  // ===== 2. backfill grava e zera o pendente =====
  const item = db.prepare(`INSERT INTO retail_pdv_sale_items (id, organization_id, filial, boleta, sale_date, item_seq, produto, quantidade, valor) VALUES (?, ?, 'X', '1', '2026-08-01', 1, '7891000000019', 1, 100)`);
  const i1 = randomUUID(); item.run(i1, A);
  const i2 = randomUUID(); db.prepare(`INSERT INTO retail_pdv_sale_items (id, organization_id, filial, boleta, sale_date, item_seq, produto, quantidade, valor) VALUES (?, ?, 'X', '2', '2026-08-01', 1, '000000000', 1, 50)`).run(i2, A);
  check("antes do backfill: 2 pendentes", R.pendingCount(A) === 2);
  const bf = R.backfill(A, { limit: 100 });
  check("backfill processa 2 (1 exact + 1 unmatched)", bf.processed === 2 && bf.byStatus.exact === 1 && bf.byStatus.unmatched === 1, JSON.stringify(bf.byStatus));
  check("backfill zera o pendente", R.pendingCount(A) === 0);
  const row = db.prepare(`SELECT product_service_id, variant_id, catalog_match_status FROM retail_pdv_sale_items WHERE id = ?`).get(i1) as any;
  check("item resolvido gravou produto/variante/status", row.product_service_id === camisa && row.variant_id === varM && row.catalog_match_status === 'exact');
  // idempotente: rodar de novo não reprocessa (já resolvidos)
  check("backfill idempotente (nada pendente)", R.backfill(A, { limit: 100 }).processed === 0);

  // ===== 3. isolamento =====
  check("org B não resolve catálogo da A", R.resolveCode(B, '7891000000019').status === 'unmatched');

  console.log("\n=== TEST: Resolução de catálogo do PDV (Fatia 4) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
