/**
 * TESTE — Reposição da grade enriquecida (PRD Moda/TOULON, INV-005)
 * ----------------------------------------------------------------------------
 * Prova, offline (RetailTransferService.replenishmentSuggestions):
 *   - sugere transferência: loja que TRABALHA o produto mas está zerada numa
 *     variação × loja que tem essa variação sobrando (>= minDonor);
 *   - enriquece com referência, EAN, unidade, cor, tamanho;
 *   - saldo da necessitada + falta (política) e saldo/transferível da doadora;
 *   - transferível preserva o mínimo da doadora (RN nº 4); sem política → tudo;
 *   - sem meta na necessitada → shortage_qty null (não inventa);
 *   - distância anotada (mais próxima primeiro);
 *   - isolamento multi-tenant.
 *
 * Uso:  npm run test:retail-replenishment
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-retail-replen-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-retail-replenishment-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { RetailTransferService } = await import("../src/server/RetailTransferService.js");
  const { RetailInventoryService } = await import("../src/server/RetailInventoryService.js");
  const { RetailStockPolicyService } = await import("../src/server/RetailStockPolicyService.js");

  const A = `org_${randomUUID().slice(0, 8)}`;
  const B = `org_${randomUUID().slice(0, 8)}`;

  const mkStore = (org: string, name: string, code: string, lat?: number, lng?: number) => {
    const id = randomUUID();
    db.prepare(`INSERT INTO retail_stores (id, organization_id, name, code, active, latitude, longitude) VALUES (?, ?, ?, ?, 1, ?, ?)`)
      .run(id, org, name, code, lat ?? null, lng ?? null);
    return id;
  };
  const needy = mkStore(A, "Savassi", "L1", -19.94, -43.93);
  const donor = mkStore(A, "Centro", "L2", -19.92, -43.94);   // ~2km
  const donorFar = mkStore(A, "Contagem", "L3", -19.90, -44.10); // mais longe

  const product = randomUUID();
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name, external_ref, default_uom, ean) VALUES (?, ?, 'product', 'Camisa Slim', 'REF-100', 'UN', null)`).run(product, A);
  const varM = randomUUID(); // a que falta
  db.prepare(`INSERT INTO product_variants (id, organization_id, product_service_id, name, sku, size, color, external_ref, active) VALUES (?, ?, ?, 'M / Azul', '7890000000017', 'M', 'Azul', 'ERPV-M', 1)`).run(varM, A, product);
  const varG = randomUUID(); // outra da grade (faz a needy ser "carrier")
  db.prepare(`INSERT INTO product_variants (id, organization_id, product_service_id, name, size, color, active) VALUES (?, ?, ?, 'G / Azul', 'G', 'Azul', 1)`).run(varG, A, product);

  // Needy: trabalha o produto (varG com saldo) mas está ZERADA em varM.
  RetailInventoryService.setQuantity(A, needy, product, varG, 4);
  RetailInventoryService.setQuantity(A, needy, product, varM, 0);
  // Doadoras: varM sobrando (5 e 6) + varG com saldo (3) para NÃO precisarem de
  // varG — assim o único caso de reposição é varM → needy (teste determinístico).
  RetailInventoryService.setQuantity(A, donor, product, varM, 5);
  RetailInventoryService.setQuantity(A, donor, product, varG, 3);
  RetailInventoryService.setQuantity(A, donorFar, product, varM, 6);
  RetailInventoryService.setQuantity(A, donorFar, product, varG, 3);

  // ===== 1. Sugestão + enriquecimento (sem política) =====
  const r1 = RetailTransferService.replenishmentSuggestions(A, {});
  check("gera sugestões (2 doadoras)", r1.count === 2, `count=${r1.count}`);
  const near = r1.suggestions[0] as any; // mais próxima primeiro
  check("mais próxima primeiro (Centro)", near.donor_store === "Centro" && near.distance_km != null);
  check("referência do produto", near.product_external_ref === "REF-100");
  check("unidade", near.product_uom === "UN");
  check("EAN (sku da variante)", near.variant_ean === "7890000000017");
  check("SKU (ref da variante)", near.variant_sku === "ERPV-M");
  check("cor/tamanho", near.color === "Azul" && near.size === "M");
  check("saldo da doadora", near.donor_qty === 5);
  check("saldo da necessitada = 0", near.needy_current_qty === 0);
  check("sem política: transferível = todo o excedente da doadora", near.transferable_qty === 5);
  check("sem política: donor_min null", near.donor_min_qty === null);
  check("sem meta na necessitada: shortage null (não inventa)", near.shortage_qty === null && near.needy_target_qty === null);

  // ===== 2. Com política: transferível preserva o mínimo da doadora =====
  RetailStockPolicyService.set(A, { storeId: donor, productId: product, variantId: varM, minQty: 2, targetQty: 8 });
  RetailStockPolicyService.set(A, { storeId: needy, productId: product, variantId: varM, minQty: 1, targetQty: 3 });
  const r2 = RetailTransferService.replenishmentSuggestions(A, {});
  const near2 = r2.suggestions.find((s: any) => s.donor_store === "Centro") as any;
  check("transferível preserva mínimo da doadora (5-2=3)", near2.transferable_qty === 3, `t=${near2.transferable_qty}`);
  check("donor_min_qty exposto (2)", near2.donor_min_qty === 2);
  check("shortage da necessitada (alvo 3 - saldo 0 = 3)", near2.shortage_qty === 3);
  check("meta da necessitada exposta (3)", near2.needy_target_qty === 3);

  // ===== 3. minDonor filtra =====
  const r3 = RetailTransferService.replenishmentSuggestions(A, { minDonor: 6 });
  check("minDonor=6 só a doadora com >=6 (Contagem)", r3.count === 1 && r3.suggestions[0].donor_store === "Contagem");

  // ===== 4. Isolamento =====
  const rB = RetailTransferService.replenishmentSuggestions(B, {});
  check("org B não vê nada da A", rB.count === 0);

  console.log("\n=== TEST: Reposição da grade enriquecida (INV Fase 1) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
