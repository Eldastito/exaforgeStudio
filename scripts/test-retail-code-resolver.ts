/**
 * TESTE — PRD Fase 1, F1.2: leitor de código (EAN/SKU/referência/ERP/alias)
 * Prova, offline: ordem de busca, código alfanumérico preservado, zeros à esquerda,
 * ambiguidade não escolhe às cegas, "não identificado" com ações, vincular alias
 * (gestor) resolve na leitura seguinte, reportar vira sinal com dedupe, isolamento.
 * Uso:  npm run test:retail-code-resolver
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-retail-code-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-retail-code-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { ModuleService } = await import("../src/server/ModuleService.js");
  const { RetailFloorShiftService, RetailFloorQueueService } = await import("../src/server/RetailFloorShiftService.js");
  const { RetailFloorAttendanceService } = await import("../src/server/RetailFloorAttendanceService.js");
  const { RetailFloorScanService } = await import("../src/server/RetailFloorScanService.js");
  const { RetailCodeResolverService: R } = await import("../src/server/RetailCodeResolverService.js");

  const A = `org_A_${randomUUID().slice(0, 6)}`, B = `org_B_${randomUUID().slice(0, 6)}`;
  for (const o of [A, B]) db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), o);
  ModuleService.applyVertical(A, "moda");
  ModuleService.enableModule(A, "retail_floor");

  const uManager = randomUUID(), uV1 = randomUUID();
  const store1 = randomUUID();
  db.prepare(`INSERT INTO retail_stores (id, organization_id, name, code, manager_user_id) VALUES (?, ?, 'Loja 1005', '1005', ?)`).run(store1, A, uManager);
  db.prepare(`INSERT INTO retail_sellers (id, organization_id, matricula, name, user_id) VALUES (?, ?, 'M-01', 'Ana', ?)`).run(randomUUID(), A, uV1);

  const prod = (org: string, name: string, extra: { ean?: string; ref?: string } = {}) => {
    const id = randomUUID();
    db.prepare(`INSERT INTO products_services (id, organization_id, type, name, price, ean, external_ref) VALUES (?, ?, 'product', ?, 100, ?, ?)`).run(id, org, name, extra.ean ?? null, extra.ref ?? null);
    return id;
  };
  const variant = (org: string, pid: string, name: string, x: { ref?: string; sku?: string } = {}) => {
    const id = randomUUID();
    db.prepare(`INSERT INTO product_variants (id, organization_id, product_service_id, name, size, color, external_ref, sku) VALUES (?, ?, ?, ?, 'M', 'Azul', ?, ?)`).run(id, org, pid, name, x.ref ?? null, x.sku ?? null);
    return id;
  };

  // Catálogo
  const pCam = prod(A, "Camisa", { ref: "CAM-100" });
  const vCam = variant(A, pCam, "M / Azul", { ref: "7891000000011", sku: "CAM-100-M-AZ" });
  const pBone = prod(A, "Boné", { ean: "7891000000028" });
  const pRef = prod(A, "Cinto ERP", { ref: "ABC123" });
  // ambíguo: mesmo SKU em 2 produtos diferentes
  const pX = prod(A, "Meia X"), pY = prod(A, "Meia Y");
  variant(A, pX, "U", { sku: "MEIA-DUP" }); variant(A, pY, "U", { sku: "MEIA-DUP" });
  // ordem: ref de uma variante = sku de outra → ref (EAN) vence
  const pO1 = prod(A, "Ordem 1"), pO2 = prod(A, "Ordem 2");
  variant(A, pO1, "V1", { ref: "5550001112223" }); variant(A, pO2, "V2", { sku: "5550001112223" });
  // org B com o mesmo EAN de A
  const pB = prod(B, "Camisa B", { ean: "7891000000028" });

  // ---- resolver puro ----
  const r1 = R.resolve(A, "7891000000011");
  check("variante por external_ref (EAN da variante)", r1.status === "found" && r1.matchedBy === "variant_ean" && r1.variant?.id === vCam && r1.product?.reference === "CAM-100");
  const r2 = R.resolve(A, "cam-100-m-az");
  check("variante por SKU alfanumérico (minúscula → normalizado)", r2.status === "found" && r2.matchedBy === "variant_sku" && r2.variant?.id === vCam);
  const r3 = R.resolve(A, "7891000000028");
  check("produto por EAN", r3.status === "found" && r3.matchedBy === "product_ean" && r3.product?.id === pBone);
  const r4 = R.resolve(A, "abc123");
  check("produto por referência ERP alfanumérica (antes virava só dígitos)", r4.status === "found" && r4.matchedBy === "product_ref" && r4.product?.id === pRef);
  const r5 = R.resolve(A, "07891000000028");
  check("zero à esquerda (GTIN-14/UPC) resolve o mesmo produto", r5.status === "found" && r5.product?.id === pBone);
  const r6 = R.resolve(A, "  789 1000 000028 ");
  check("espaços internos ignorados", r6.status === "found" && r6.product?.id === pBone);
  const rOrd = R.resolve(A, "5550001112223");
  check("ordem: EAN/ref da variante vence SKU de outra", rOrd.status === "found" && rOrd.matchedBy === "variant_ean" && rOrd.variant?.name === "V1");
  const rAmb = R.resolve(A, "MEIA-DUP");
  check("ambíguo (2 produtos): NÃO escolhe, lista candidatos", rAmb.status === "ambiguous" && rAmb.product === null && rAmb.candidates.length === 2);
  const rNo = R.resolve(A, "9990000000000");
  check("não encontrado → unresolved", rNo.status === "unresolved" && rNo.product === null);
  check("código curto/vazio → unresolved sem lançar", R.resolve(A, "12").status === "unresolved" && R.resolve(A, "").status === "unresolved");
  check("isolamento: org B não vê o produto de A e vice-versa", R.resolve(B, "7891000000028").product?.id === pB && R.resolve(B, "7891000000011").status === "unresolved");

  // ---- scan: não identificado + ações ----
  const manager = { userId: uManager, role: "agent" }, seller = { userId: uV1, role: "agent" };
  RetailFloorShiftService.open(A, store1, manager);
  RetailFloorQueueService.join(A, { storeId: store1 }, seller);
  const att = RetailFloorAttendanceService.start(A, { storeId: store1 }, seller);
  const inv = db.prepare(`INSERT INTO retail_store_inventory (id, organization_id, store_id, product_service_id, variant_id, quantity_available) VALUES (?, ?, ?, ?, ?, ?)`);
  inv.run(randomUUID(), A, store1, pRef, null, 3);

  const sOk = RetailFloorScanService.scan(A, att.id, "abc123", {}, seller);
  check("scan: referência alfanumérica reconhecida com estoque", sOk.found && sOk.resolution === "found" && sOk.matchedBy === "product_ref" && sOk.localStock === 3 && sOk.unresolved === null);
  const sAmb = RetailFloorScanService.scan(A, att.id, "MEIA-DUP", {}, seller);
  check("scan: ambíguo → found=false + candidatos + ações, SEM demanda no_assortment", !sAmb.found && sAmb.resolution === "ambiguous" && sAmb.candidates.length === 2 && sAmb.unmetDemand === null && sAmb.unresolved.actions.includes("link_product"));
  const sNo = RetailFloorScanService.scan(A, att.id, "9990000000000", {}, seller);
  check("scan: não identificado mostra código lido e as 3 ações", !sNo.found && sNo.resolution === "unresolved" && sNo.unresolved.code === "9990000000000" && sNo.unresolved.message === "Código não identificado" && ["search_catalog", "link_product", "report_problem"].every((a) => sNo.unresolved.actions.includes(a)));
  check("scan: não identificado mantém a demanda no_assortment (0-regressão)", sNo.unmetDemand?.reason === "no_assortment");

  // ---- pesquisar catálogo ----
  const srch = RetailFloorScanService.searchCatalog(A, "camisa");
  check("pesquisar catálogo: acha por nome e traz variantes", srch.length === 1 && srch[0].productId === pCam && srch[0].variants[0].id === vCam);
  check("pesquisar catálogo: por referência/SKU e isolado por org", RetailFloorScanService.searchCatalog(A, "CAM-100").length >= 1 && !RetailFloorScanService.searchCatalog(B, "camisa").some((x: any) => x.productId === pCam) && RetailFloorScanService.searchCatalog(A, "x").length === 0);

  // ---- reportar (vendedor pode) ----
  const rep = RetailFloorScanService.reportCodeProblem(A, att.id, { scanId: sNo.scanId, note: "etiqueta nova" }, seller);
  const rep2 = RetailFloorScanService.reportCodeProblem(A, att.id, { scanId: sNo.scanId }, seller);
  const sigRow = db.prepare(`SELECT COUNT(*) AS n FROM business_signals WHERE organization_id = ? AND signal_type = 'retail_floor_code_unresolved'`).get(A) as any;
  check("reportar: vendedor publica sinal; repetir dedupa", rep.reported && rep2.deduped === true && Number(sigRow.n) === 1);
  let repIdentified = false;
  try { RetailFloorScanService.reportCodeProblem(A, att.id, { scanId: sOk.scanId }, seller); } catch (e: any) { repIdentified = /já foi identificado/.test(e.message); }
  check("reportar: scan já identificado rejeitado", repIdentified);

  // ---- vincular (gestor) ----
  let sellerLink = false;
  try { RetailFloorScanService.linkCode(A, att.id, { scanId: sNo.scanId, productId: pCam, variantId: vCam }, seller); } catch (e: any) { sellerLink = e.message === "store_scope_denied"; }
  check("vincular: vendedor comum negado (gestor decide o catálogo)", sellerLink);
  let badVar = false;
  try { RetailFloorScanService.linkCode(A, att.id, { scanId: sNo.scanId, productId: pBone, variantId: vCam }, manager); } catch (e: any) { badVar = /Variante não pertence/.test(e.message); }
  check("vincular: variante de outro produto rejeitada", badVar);
  let crossProd = false;
  try { RetailFloorScanService.linkCode(A, att.id, { scanId: sNo.scanId, productId: pB }, manager); } catch (e: any) { crossProd = /Produto não encontrado/.test(e.message); }
  check("vincular: produto de outra org rejeitado", crossProd);
  const lk = RetailFloorScanService.linkCode(A, att.id, { scanId: sNo.scanId, productId: pCam, variantId: vCam }, manager);
  check("vincular: gestor liga o código à variante", lk.linked && lk.resolved.status === "found" && lk.resolved.matchedBy === "alias");
  const sAfter = RetailFloorScanService.scan(A, att.id, "9990000000000", {}, seller);
  check("após vincular: próxima leitura resolve sem cadastro manual", sAfter.found && sAfter.matchedBy === "alias" && sAfter.variant?.id === vCam);
  let relink = false;
  try { RetailFloorScanService.linkCode(A, att.id, { scanId: sNo.scanId, productId: pCam }, manager); } catch (e: any) { relink = /já foi identificado/.test(e.message); }
  check("vincular: scan já identificado não revincula", relink);
  let shadow = false;
  try { R.linkAlias(A, "7891000000028", { productId: pCam }, uManager); } catch (e: any) { shadow = e.message === "code_already_resolves"; }
  check("vincular: não esconde código que já resolve por EAN/ref", shadow);
  check("alias isolado por org", R.resolve(B, "9990000000000").status === "unresolved");

  console.log("\n=== PRD Fase 1 · F1.2: leitor de código ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
