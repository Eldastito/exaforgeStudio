/**
 * TESTE — Resultado da Rede SET-BASED + consumo das colunas resolvidas
 * (PDR TOULON, Fatia 4B / PERF-002/003/004).
 * ---------------------------------------------------------------------------
 * A Fatia 4A passou a RESOLVER o código do ERP → catálogo na ingestão,
 * persistindo `product_service_id`/`variant_id`/`catalog_resolved_at` no item.
 * A 4B faz as analíticas CONSUMIREM essas colunas:
 *
 *   - CMV usa a coluna resolvida (junção por id/índice) — prova FORTE: um item
 *     cujo `produto` NÃO casaria por código nenhum, mas com `product_service_id`
 *     resolvido, AINDA é custeado (a query lê a coluna, não re-roda o LIKE);
 *   - o prefixo LIKE roda SÓ para itens ainda não resolvidos (fallback) — um
 *     item `catalog_resolved_at IS NULL` continua resolvendo por código;
 *   - item resolvido como `ambiguous` (sem product_service_id) NÃO é custeado;
 *   - `allStoresResult` (set-based, sem N+1) devolve, por loja, EXATAMENTE o
 *     mesmo que `storeResult` (N+1) — a montagem é a mesma regra;
 *   - isolamento multi-tenant.
 *
 * Determinístico e offline (zero-token).
 *
 * Uso:  npm run test:retail-store-result-setbased
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-retail-setbased-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-retail-setbased-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }
const near = (a: number, b: number, eps = 0.011) => Math.abs(a - b) < eps;

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { RetailStoreService } = await import("../src/server/RetailStoreService.js");
  const { RetailStoreCostService } = await import("../src/server/RetailStoreCostService.js");

  const period = new Date().toISOString().slice(0, 7);
  const A = `org_A_${randomUUID().slice(0, 6)}`;
  const B = `org_B_${randomUUID().slice(0, 6)}`;
  for (const org of [A, B]) db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), org);

  const loja1 = RetailStoreService.create(A, { name: "Loja 1", code: "10" });
  const loja2 = RetailStoreService.create(A, { name: "Loja 2", code: "20" });
  const loja3 = RetailStoreService.create(A, { name: "Loja 3", code: "30" });
  for (const l of [loja1, loja2, loja3]) RetailStoreService.update(A, l.id, { grossMarginPercent: 50 });

  // Catálogo: produto P1 com custo médio R$ 30.
  const p1 = randomUUID();
  db.prepare(`INSERT INTO products_services (id, organization_id, name, type, active, external_ref) VALUES (?, ?, 'P1', 'product', 1, 'P1CODE')`).run(p1, A);
  db.prepare(`INSERT INTO inventory_items (id, organization_id, product_service_id, quantity_available, avg_cost) VALUES (?, ?, ?, 0, 30)`).run(randomUUID(), A, p1);

  const insItem = (
    filial: string, boleta: string, produto: string, qty: number, valor: number,
    resolved?: { productServiceId: string | null; status: string }
  ) => db.prepare(
    `INSERT INTO retail_pdv_sale_items (id, organization_id, filial, boleta, sale_date, item_seq, produto, quantidade, valor, product_service_id, catalog_match_status, catalog_resolved_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`
  ).run(
    randomUUID(), A, filial, boleta, `${period}-05`, produto, qty, valor,
    resolved ? resolved.productServiceId : null,
    resolved ? resolved.status : null,
    resolved ? "2026-08-05 12:00:00" : null
  );
  const insClosing = (storeId: string, total: number) =>
    db.prepare(`INSERT INTO retail_daily_closings (id, organization_id, store_id, closing_date, status, informed_total, system_total) VALUES (?, ?, ?, ?, 'approved', ?, ?)`)
      .run(randomUUID(), A, storeId, `${period}-05`, total, total);

  // Loja 1 — item RESOLVIDO cujo `produto` NÃO casaria por código nenhum
  // ('LIXO999'), mas com product_service_id = P1. qty 2 × R$100 = 200; custo 60.
  insItem("10", "B1", "LIXO999", 2, 200, { productServiceId: p1, status: "exact" });
  insClosing(loja1.id, 200);

  // Loja 2 — item NÃO resolvido (catalog_resolved_at NULL), produto casa por
  // código exato ('P1CODE'). qty 1 × R$100; custo 30. Prova o fallback.
  insItem("20", "B2", "P1CODE", 1, 100);
  insClosing(loja2.id, 100);

  // Loja 3 — item RESOLVIDO como 'ambiguous' (product_service_id NULL) → NÃO
  // custeia; R$50 de receita PDV sem cobertura.
  insItem("30", "B3", "P1CODE", 1, 50, { productServiceId: null, status: "ambiguous" });
  insClosing(loja3.id, 50);

  // ===== 1. CMV consome a coluna resolvida (prova forte) =====
  const cmv1 = RetailStoreCostService.monthlyCogsBreakdown(A, loja1.id, period);
  check("resolvido: item com produto sem match por código é custeado pela coluna", cmv1.source === "real" && near(cmv1.cmvReal, 60), `${cmv1.source}/${cmv1.cmvReal}`);
  check("resolvido: receita coberta = 200", near(cmv1.revenueCovered, 200), String(cmv1.revenueCovered));

  // ===== 2. Fallback ainda roda para itens não resolvidos =====
  const cmv2 = RetailStoreCostService.monthlyCogsBreakdown(A, loja2.id, period);
  check("não resolvido: fallback por código custeia (cmvReal = 30)", cmv2.source === "real" && near(cmv2.cmvReal, 30), `${cmv2.source}/${cmv2.cmvReal}`);

  // ===== 3. Ambíguo resolvido não é custeado =====
  const cmv3 = RetailStoreCostService.monthlyCogsBreakdown(A, loja3.id, period);
  check("ambíguo: sem product_service_id não custeia (coverage 0)", cmv3.revenueTotalPdv > 0 && cmv3.coverage === 0 && cmv3.source === "estimate", `${cmv3.source}/${cmv3.coverage}`);

  // ===== 4. Batch == N+1 (set-based idêntico ao por-loja) =====
  const all = RetailStoreCostService.allStoresResult(A, period);
  check("allStoresResult tem as 3 lojas", all.perStore.length === 3, String(all.perStore.length));
  const cmvAll = RetailStoreCostService.monthlyCogsBreakdownAll(A, period);
  check("monthlyCogsBreakdownAll casa loja1", near((cmvAll.get(loja1.id)?.cmvReal ?? -1), 60));
  check("monthlyCogsBreakdownAll casa loja2", near((cmvAll.get(loja2.id)?.cmvReal ?? -1), 30));
  let identical = true; const diffs: string[] = [];
  for (const l of [loja1, loja2, loja3]) {
    const single = RetailStoreCostService.storeResult(A, l.id, period)!;
    const batched = all.perStore.find((s) => s.storeId === l.id)!;
    for (const k of ["faturamento", "cmv", "margemBruta", "margemContribuicao", "resultado", "vendasCount"] as const) {
      const a: any = (single as any)[k]; const b: any = (batched as any)[k];
      const eq = a === b || (typeof a === "number" && typeof b === "number" && near(a, b));
      if (!eq) { identical = false; diffs.push(`${l.code}.${k}: ${a} != ${b}`); }
    }
    if (single.custosFixos.total !== batched.custosFixos.total) { identical = false; diffs.push(`${l.code}.custosFixos`); }
  }
  check("set-based == N+1 (mesmos números por loja)", identical, diffs.join("; "));

  // Totais da rede batem com a soma manual das lojas.
  const somaFat = all.perStore.reduce((s, r) => s + r.faturamento, 0);
  check("totais da rede: faturamento = Σ lojas", near(all.totals.faturamento, somaFat) && near(somaFat, 350), String(all.totals.faturamento));

  // ===== 5. Isolamento =====
  check("org B: allStoresResult vazio", RetailStoreCostService.allStoresResult(B, period).perStore.length === 0);
  check("org B: monthlyCogsBreakdownAll vazio", RetailStoreCostService.monthlyCogsBreakdownAll(B, period).size === 0);

  console.log("\n=== TEST: Resultado da Rede set-based (Fatia 4B) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
