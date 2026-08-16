/**
 * TESTE — Política de estoque (PRD Moda/TOULON, INV-003/004; AC-06/AC-07)
 * ----------------------------------------------------------------------------
 * Prova, offline (RetailStockPolicyService + fiação no listNegative):
 *   - set cria; set de novo no MESMO escopo ATUALIZA (uma ativa por escopo);
 *   - validação: alvo >= mínimo; sem negativos;
 *   - resolução por PRECEDÊNCIA: loja+variante > loja+produto > org+variante > org+produto;
 *   - computeQuantities: qty_to_zero = max(-atual,0); shortage = max(alvo-atual,0);
 *   - AC-06: sem política → shortage_qty null (Meta não configurada), qty_to_zero ainda existe;
 *   - AC-07: saldo -2, alvo 3 → shortage 5, qty_to_zero 2 (números separados);
 *   - listNegative carrega os números por item;
 *   - remove desativa (não some do histórico) e libera o escopo;
 *   - isolamento multi-tenant.
 *
 * Uso:  npm run test:retail-stock-policy
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-retail-stockpol-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-retail-stock-policy-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { RetailStockPolicyService } = await import("../src/server/RetailStockPolicyService.js");
  const { RetailInventoryService } = await import("../src/server/RetailInventoryService.js");

  const A = `org_${randomUUID().slice(0, 8)}`;
  const B = `org_${randomUUID().slice(0, 8)}`;

  const store = randomUUID();
  db.prepare(`INSERT INTO retail_stores (id, organization_id, name, code, active) VALUES (?, ?, 'Savassi', 'L1', 1)`).run(store, A);
  const product = randomUUID();
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name, external_ref) VALUES (?, ?, 'product', 'Camisa', 'REF-1')`).run(product, A);
  const variant = randomUUID();
  db.prepare(`INSERT INTO product_variants (id, organization_id, product_service_id, name, size, color, active) VALUES (?, ?, ?, 'M / Azul', 'M', 'Azul', 1)`).run(variant, A, product);

  // ===== 1. set + update no mesmo escopo =====
  const p1 = RetailStockPolicyService.set(A, { productId: product, minQty: 1, targetQty: 3 });
  check("cria política org+produto", !!p1?.id && p1.target_qty === 3);
  const p1b = RetailStockPolicyService.set(A, { productId: product, minQty: 2, targetQty: 5 });
  check("mesmo escopo ATUALIZA (mesmo id)", p1b.id === p1.id && p1b.target_qty === 5);
  check("uma ativa por escopo", RetailStockPolicyService.list(A, { productId: product }).filter((p: any) => p.store_id === "" && p.variant_id === "").length === 1);

  // ===== 2. validação =====
  let threw = false;
  try { RetailStockPolicyService.set(A, { productId: product, minQty: 5, targetQty: 3 }); } catch { threw = true; }
  check("alvo < mínimo rejeitado", threw);
  threw = false;
  try { RetailStockPolicyService.set(A, { productId: product, minQty: -1, targetQty: 3 }); } catch { threw = true; }
  check("mínimo negativo rejeitado", threw);

  // ===== 3. precedência =====
  // org+produto já existe (min2/target5). Cria loja+produto (target 8) e loja+variante (target 10).
  RetailStockPolicyService.set(A, { storeId: store, productId: product, minQty: 3, targetQty: 8 });
  RetailStockPolicyService.set(A, { storeId: store, productId: product, variantId: variant, minQty: 4, targetQty: 10 });
  const rSV = RetailStockPolicyService.resolve(A, store, product, variant);
  check("loja+variante vence tudo (target 10)", rSV?.target_qty === 10 && rSV?.scope === "store_variant");
  const rSP = RetailStockPolicyService.resolve(A, store, product, "outra-variante");
  check("sem loja+variante cai em loja+produto (target 8)", rSP?.target_qty === 8 && rSP?.scope === "store_product");
  const rOP = RetailStockPolicyService.resolve(A, "outra-loja", product, "x");
  check("outra loja cai em org+produto (target 5)", rOP?.target_qty === 5 && rOP?.scope === "org_product");
  const rNone = RetailStockPolicyService.resolve(A, store, "produto-sem-politica", null);
  check("produto sem política → null", rNone === null);

  // ===== 4. computeQuantities (AC-07) =====
  const c = RetailStockPolicyService.computeQuantities(-2, rSV); // atual -2, alvo 10
  check("AC-07: qty_to_zero = 2", c.qty_to_zero === 2);
  check("AC-07: shortage = alvo - atual = 12", c.shortage_qty === 12);
  // Exemplo exato do PRD: atual -2, alvo 3 → shortage 5, qty_to_zero 2.
  const cPrd = RetailStockPolicyService.computeQuantities(-2, { ...rSV!, target_qty: 3 } as any);
  check("PRD: atual -2 alvo 3 → shortage 5", cPrd.shortage_qty === 5);
  check("PRD: atual -2 → qty_to_zero 2", cPrd.qty_to_zero === 2);

  // ===== 5. AC-06: sem política → shortage null, qty_to_zero existe =====
  const cNone = RetailStockPolicyService.computeQuantities(-4, null);
  check("AC-06: sem política shortage_qty null", cNone.shortage_qty === null && cNone.target_qty === null);
  check("AC-06: qty_to_zero ainda existe sem política", cNone.qty_to_zero === 4);

  // ===== 6. listNegative carrega os números =====
  RetailInventoryService.setQuantity(A, store, product, variant, -2); // resolve loja+variante (alvo 10)
  const neg = RetailInventoryService.listNegative(A, {});
  const row = neg.items.find((i: any) => i.product_service_id === product) as any;
  check("listNegative traz shortage do item", row?.shortage_qty === 12 && row?.qty_to_zero === 2, `shortage=${row?.shortage_qty}`);
  check("listNegative traz target/min", row?.target_qty === 10 && row?.min_qty === 4);

  // ===== 7. remove desativa e libera escopo =====
  RetailStockPolicyService.remove(A, rSV!.id);
  const afterRemove = RetailStockPolicyService.resolve(A, store, product, variant);
  check("após remover loja+variante, cai em loja+produto (8)", afterRemove?.target_qty === 8);
  const neg2 = RetailInventoryService.listNegative(A, {});
  const row2 = neg2.items.find((i: any) => i.product_service_id === product) as any;
  check("listNegative reflete a nova política (alvo 8)", row2?.target_qty === 8 && row2?.shortage_qty === 10);

  // ===== 8. isolamento =====
  const bHas = RetailStockPolicyService.hasAny(B);
  check("org B não tem políticas", bHas === false);
  check("resolve na org B não vê políticas da A", RetailStockPolicyService.resolve(B, store, product, variant) === null);

  console.log("\n=== TEST: Política de estoque (INV Fase 1) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
