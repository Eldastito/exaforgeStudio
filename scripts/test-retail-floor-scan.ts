/**
 * TESTE — ADR-150 Fatia 5: scan no atendimento + demanda não atendida
 * -------------------------------------------------------------------
 * Prova, offline:
 *   - lookup em 2 níveis: variante por external_ref (grade Alterdata) e
 *     produto por products_services.ean;
 *   - congelamento: scan grava estoque local/rede + carimbo de sync no
 *     momento (histórico não muda quando o estoque muda depois);
 *   - rede = soma dos saldos POSITIVOS das outras lojas (negativo da sombra
 *     não conta como vendável) + lista das lojas com peça;
 *   - RN-150-007: syncedAt do cursor Alterdata; syncStale quando > 24h;
 *   - demanda não atendida (RN-150-009): EAN fora do catálogo →
 *     no_assortment; sem local e sem rede → no_network_stock; sem local mas
 *     COM rede → NÃO cria demanda (recuperável por transferência); dedupe
 *     por (attendance, ean|produto, reason); manual (missing_size etc.)
 *     exige scanId do próprio atendimento + o que faltou;
 *   - guards: scan só em atendimento ativo; terceiro sem escopo negado;
 *     action inválida e EAN inválido rejeitados;
 *   - timeline de scans em ordem;
 *   - isolamento multi-tenant.
 *
 * Uso:  npm run test:retail-floor-scan
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-retail-floor-f5-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-retail-floor-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

/** EAN-13 válido a partir de 12 dígitos (dígito verificador calculado). */
function makeEan(prefix12: string): string {
  const d = prefix12.padStart(12, "0").slice(0, 12).split("").map(Number);
  const sum = d.reduce((acc, n, i) => acc + n * (i % 2 === 0 ? 1 : 3), 0);
  return prefix12 + String((10 - (sum % 10)) % 10);
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { ModuleService } = await import("../src/server/ModuleService.js");
  const { RetailFloorShiftService, RetailFloorQueueService } = await import("../src/server/RetailFloorShiftService.js");
  const { RetailFloorAttendanceService } = await import("../src/server/RetailFloorAttendanceService.js");
  const { RetailFloorScanService } = await import("../src/server/RetailFloorScanService.js");

  const A = `org_A_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'A', 'active')`).run(randomUUID(), A);
  ModuleService.applyVertical(A, "moda");
  ModuleService.enableModule(A, "retail_floor");

  const uManager = randomUUID(), uV1 = randomUUID();
  const store1 = randomUUID(), store2 = randomUUID(), store3 = randomUUID();
  db.prepare(`INSERT INTO retail_stores (id, organization_id, name, code, manager_user_id) VALUES (?, ?, 'Loja 1005', '1005', ?)`).run(store1, A, uManager);
  db.prepare(`INSERT INTO retail_stores (id, organization_id, name, code) VALUES (?, ?, 'Loja 1006', '1006')`).run(store2, A);
  db.prepare(`INSERT INTO retail_stores (id, organization_id, name, code) VALUES (?, ?, 'Loja 1007', '1007')`).run(store3, A);
  const v1 = randomUUID();
  db.prepare(`INSERT INTO retail_sellers (id, organization_id, matricula, name, user_id) VALUES (?, ?, 'M-01', 'Ana', ?)`).run(v1, A, uV1);

  // Catálogo: camisa com grade (variante M/Azul com EAN próprio) + boné sem grade.
  const eanVar = makeEan("789100000001"), eanProd = makeEan("789100000002"), eanGhost = makeEan("789100000003"), eanDead = makeEan("789100000004");
  const prodCamisa = randomUUID(), varM = randomUUID(), prodBone = randomUUID(), prodDead = randomUUID();
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name, price) VALUES (?, ?, 'product', 'Camisa Malha', 129.9)`).run(prodCamisa, A);
  db.prepare(`INSERT INTO product_variants (id, organization_id, product_service_id, name, size, color, external_ref) VALUES (?, ?, ?, 'M / Azul', 'M', 'Azul', ?)`).run(varM, A, prodCamisa, eanVar);
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name, price, ean) VALUES (?, ?, 'product', 'Boné Logo', 59.9, ?)`).run(prodBone, A, eanProd);
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name, price, ean) VALUES (?, ?, 'product', 'Peça Esgotada', 99.9, ?)`).run(prodDead, A, eanDead);
  // Código INTERNO da ModaUp (prefixo 2, NÃO fecha o dígito verificador GS1) — é
  // o código REAL da etiqueta/ERP, gravado no external_ref da variante. O scan
  // NÃO pode recusá-lo como "inválido" (era o bug do Atendimento de Loja).
  const internalCode = "2971090622711"; // reprova de propósito no checksum GTIN
  const prodInt = randomUUID(), varInt = randomUUID();
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name, price) VALUES (?, ?, 'product', 'Vestido Interno', 199.9)`).run(prodInt, A);
  db.prepare(`INSERT INTO product_variants (id, organization_id, product_service_id, name, size, color, external_ref) VALUES (?, ?, ?, 'P / Preto', 'P', 'Preto', ?)`).run(varInt, A, prodInt, internalCode);

  // Estoque sombra: camisa M/Azul — loja1: 2; loja2: 5; loja3: -3 (negativo NÃO conta).
  const inv = db.prepare(`INSERT INTO retail_store_inventory (id, organization_id, store_id, product_service_id, variant_id, quantity_available) VALUES (?, ?, ?, ?, ?, ?)`);
  inv.run(randomUUID(), A, store1, prodCamisa, varM, 2);
  inv.run(randomUUID(), A, store2, prodCamisa, varM, 5);
  inv.run(randomUUID(), A, store3, prodCamisa, varM, -3);
  // Boné (sem variante) — loja1: 0; loja2: 3.
  inv.run(randomUUID(), A, store1, prodBone, null, 0);
  inv.run(randomUUID(), A, store2, prodBone, null, 3);
  // Peça esgotada — zero em todas.
  inv.run(randomUUID(), A, store1, prodDead, null, 0);
  // Vestido interno com estoque local (pra não virar demanda).
  inv.run(randomUUID(), A, store1, prodInt, varInt, 4);
  // Cursor Alterdata recente (carimbo de sync).
  db.prepare(`INSERT INTO alterdata_sync_cursors (id, organization_id, module, resource, filial, version, last_synced_at) VALUES (?, ?, 'supply', 'Saldo', '1005', '42', datetime('now', '-2 hours'))`).run(randomUUID(), A);

  const manager = { userId: uManager, role: "agent" };
  const sellerU1 = { userId: uV1, role: "agent" };
  RetailFloorShiftService.open(A, store1, manager);
  RetailFloorQueueService.join(A, { storeId: store1 }, sellerU1);
  const att = RetailFloorAttendanceService.start(A, { storeId: store1 }, sellerU1);

  // ---- 1. lookup + congelamento ----
  const s1 = RetailFloorScanService.scan(A, att.id, eanVar, {}, sellerU1);
  check("scan: variante resolvida por external_ref (M/Azul)", s1.found && s1.variant?.size === "M" && s1.product?.name === "Camisa Malha");
  check("scan: local=2, rede=5 (negativo da loja3 NÃO conta)", s1.localStock === 2 && s1.networkStock === 5);
  check("scan: otherStores lista só quem tem (loja2)", s1.otherStores.length === 1 && s1.otherStores[0].code === "1006" && s1.otherStores[0].quantity === 5);
  check("scan: carimbo de sync do cursor + não-stale (2h)", !!s1.syncedAt && s1.syncStale === false);
  check("scan: sem demanda (tem estoque local)", s1.unmetDemand === null);

  const s2 = RetailFloorScanService.scan(A, att.id, eanProd, {}, sellerU1);
  check("scan: produto sem grade por products_services.ean", s2.found && s2.product?.name === "Boné Logo" && s2.variant === null);
  check("scan: sem local mas COM rede → sugere loja, SEM demanda", s2.localStock === 0 && s2.networkStock === 3 && s2.otherStores.length === 1 && s2.unmetDemand === null);

  // Código interno da ModaUp (reprova no checksum GTIN) DEVE resolver — era
  // recusado como "Código de barras inválido" antes do fix.
  const sInt = RetailFloorScanService.scan(A, att.id, internalCode, {}, sellerU1);
  check("scan: código interno (não-GTIN) resolvido por external_ref", sInt.found && sInt.product?.name === "Vestido Interno" && sInt.variant?.color === "Preto", `found=${sInt.found}`);
  check("scan: código interno com estoque local (sem demanda)", sInt.localStock === 4 && sInt.unmetDemand === null);

  // Congelamento: estoque muda depois, o scan gravado não.
  db.prepare(`UPDATE retail_store_inventory SET quantity_available = 99 WHERE organization_id = ? AND store_id = ? AND product_service_id = ?`).run(A, store1, prodCamisa);
  const frozen = RetailFloorScanService.scans(A, att.id).find((s: any) => s.id === s1.scanId);
  check("congelamento: scan mantém local=2 após estoque virar 99", frozen.localStock === 2);

  // ---- 2. demanda não atendida automática ----
  const s3 = RetailFloorScanService.scan(A, att.id, eanGhost, {}, sellerU1);
  check("EAN fora do catálogo → found=false + no_assortment", !s3.found && s3.unmetDemand?.reason === "no_assortment" && s3.unmetDemand?.ean === eanGhost);
  const s3b = RetailFloorScanService.scan(A, att.id, eanGhost, {}, sellerU1);
  check("dedupe: re-bipar o mesmo EAN não duplica a demanda", s3b.unmetDemand?.deduped === true && s3b.unmetDemand?.id === s3.unmetDemand.id);

  const s4 = RetailFloorScanService.scan(A, att.id, eanDead, {}, sellerU1);
  check("sem local E sem rede → no_network_stock", s4.found && s4.unmetDemand?.reason === "no_network_stock" && s4.unmetDemand?.productId === prodDead);
  const unmetCount = db.prepare(`SELECT COUNT(*) AS n FROM retail_floor_unmet_demand WHERE organization_id = ? AND attendance_id = ?`).get(A, att.id) as any;
  check("total de demandas automáticas = 2 (ghost + esgotada)", Number(unmetCount.n) === 2);

  // ---- 3. demanda manual (faltou tamanho) ----
  let badReason = false;
  try { RetailFloorScanService.registerUnmet(A, att.id, { scanId: s1.scanId, reason: "no_local_stock" }, sellerU1); } catch (e: any) { badReason = /reason inválida/.test(e.message); }
  check("manual: reason automática rejeitada (máquina detecta no scan)", badReason);
  let noDetail = false;
  try { RetailFloorScanService.registerUnmet(A, att.id, { scanId: s1.scanId, reason: "missing_size" }, sellerU1); } catch (e: any) { noDetail = /o que faltou/.test(e.message); }
  check("manual: sem detalhe rejeitado", noDetail);
  const um = RetailFloorScanService.registerUnmet(A, att.id, { scanId: s1.scanId, reason: "missing_size", size: "G", categoryLabel: "malha" }, sellerU1);
  check("manual: missing_size com evidência do scan registrada", um.reason === "missing_size" && um.detail?.size === "G" && um.scanId === s1.scanId && um.deduped === false);
  const um2 = RetailFloorScanService.registerUnmet(A, att.id, { scanId: s1.scanId, reason: "missing_size", size: "G" }, sellerU1);
  check("manual: dedupe por (attendance, produto, reason)", um2.deduped === true);
  let wrongScan = false;
  try { RetailFloorScanService.registerUnmet(A, att.id, { scanId: randomUUID(), reason: "missing_color", color: "Vermelho" }, sellerU1); } catch (e: any) { wrongScan = /não pertence a este atendimento/.test(e.message); }
  check("manual: scanId alheio rejeitado (RN-150-009 evidência)", wrongScan);

  // ---- 4. guards ----
  let badAction = false;
  try { RetailFloorScanService.scan(A, att.id, eanVar, { action: "hide" }, sellerU1); } catch (e: any) { badAction = /action inválida/.test(e.message); }
  check("guard: action inválida rejeitada", badAction);
  let badEan = false;
  try { RetailFloorScanService.scan(A, att.id, "123", {}, sellerU1); } catch (e: any) { badEan = /inválido/.test(e.message); }
  check("guard: código curto (< 6 dígitos) rejeitado", badEan);
  let noScope = false;
  try { RetailFloorScanService.scan(A, att.id, eanVar, {}, { userId: randomUUID(), role: "agent" }); } catch (e: any) { noScope = e.message === "store_scope_denied"; }
  check("guard: terceiro sem escopo não bipa (RN-150-005)", noScope);

  const timeline = RetailFloorScanService.scans(A, att.id);
  check("timeline: 6 scans em ordem (a leitura fica ligada ao atendimento)", timeline.length === 6 && timeline[0].id === s1.scanId);

  RetailFloorAttendanceService.finish(A, att.id, { outcome: "not_converted", reason: { category: "product", productDetail: { reason: "missing_size", size: "G" } } }, sellerU1);
  let closedScan = false;
  try { RetailFloorScanService.scan(A, att.id, eanVar, {}, sellerU1); } catch (e: any) { closedScan = /já encerrado/.test(e.message); }
  check("guard: scan em atendimento encerrado rejeitado", closedScan);

  // ---- 5. syncStale (RN-150-007) ----
  db.prepare(`UPDATE alterdata_sync_cursors SET last_synced_at = datetime('now', '-30 hours') WHERE organization_id = ?`).run(A);
  const att2 = RetailFloorAttendanceService.start(A, { storeId: store1 }, sellerU1);
  const sStale = RetailFloorScanService.scan(A, att2.id, eanVar, {}, sellerU1);
  check("syncStale: cursor de 30h marca desatualizado", sStale.syncStale === true);

  // ---- 6. isolamento ----
  const B = `org_B_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'B', 'active')`).run(randomUUID(), B);
  let crossScan = false;
  try { RetailFloorScanService.scan(B, att2.id, eanVar, {}, { userId: randomUUID(), role: "owner" }); } catch { crossScan = true; }
  check("Isolamento: org B não bipa em atendimento de A", crossScan);
  check("Isolamento: timeline de A vazia sob org B", RetailFloorScanService.scans(B, att.id).length === 0);

  console.log("\n=== ADR-150 Fatia 5: scan no atendimento + demanda não atendida ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
