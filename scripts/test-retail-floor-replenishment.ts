/**
 * TESTE — FLOOR: reposição na ruptura (PRD Moda/TOULON; ADR-176)
 * -------------------------------------------------------------
 * Prova, offline (RetailFloorReplenishmentService), o atalho de transferência:
 *   - peça sem estoque local mas COM rede → pedido publica business_signal
 *     apontando a loja doadora (maior saldo por padrão) + marca o scan;
 *   - targetStoreId escolhido é respeitado (e recusa loja sem saldo);
 *   - peça esgotada na rede → NÃO inventa transferência (erro → vira compra);
 *   - EAN fora do mix (sem produto) → sem transferência;
 *   - idempotência: dois pedidos p/ a mesma doadora atualizam o MESMO sinal;
 *   - o sinal carrega evidência (loja doadora, saldo, PUBLICADO ≠ REPOSTO);
 *   - isolamento multi-tenant.
 *
 * Uso:  npm run test:retail-floor-replenishment
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-retail-floor-repl-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-retail-floor-repl-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

/** EAN-13 válido a partir de 12 dígitos. */
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
  const { RetailFloorReplenishmentService } = await import("../src/server/RetailFloorReplenishmentService.js");

  const A = `org_A_${randomUUID().slice(0, 6)}`;
  const B = `org_B_${randomUUID().slice(0, 6)}`;
  for (const org of [A, B]) {
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, ?, 'active')`).run(randomUUID(), org, org);
    ModuleService.applyVertical(org, "moda");
    ModuleService.enableModule(org, "retail_floor");
  }

  const uV1 = randomUUID();
  const store1 = randomUUID(), store2 = randomUUID(), store3 = randomUUID();
  db.prepare(`INSERT INTO retail_stores (id, organization_id, name, code, manager_user_id) VALUES (?, ?, 'Loja 1005', '1005', ?)`).run(store1, A, uV1);
  db.prepare(`INSERT INTO retail_stores (id, organization_id, name, code) VALUES (?, ?, 'Loja 1006', '1006')`).run(store2, A);
  db.prepare(`INSERT INTO retail_stores (id, organization_id, name, code) VALUES (?, ?, 'Loja 1007', '1007')`).run(store3, A);
  db.prepare(`INSERT INTO retail_sellers (id, organization_id, matricula, name, user_id) VALUES (?, ?, 'M-01', 'Ana', ?)`).run(randomUUID(), A, uV1);

  // Catálogo: camisa (grade M/Azul), boné (sem grade, esgotado na rede), fantasma.
  const eanVar = makeEan("789200000001"), eanDead = makeEan("789200000002");
  const prodCamisa = randomUUID(), varM = randomUUID(), prodDead = randomUUID();
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name, price) VALUES (?, ?, 'product', 'Camisa Malha', 129.9)`).run(prodCamisa, A);
  db.prepare(`INSERT INTO product_variants (id, organization_id, product_service_id, name, size, color, external_ref) VALUES (?, ?, ?, 'M / Azul', 'M', 'Azul', ?)`).run(varM, A, prodCamisa, eanVar);
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name, price, ean) VALUES (?, ?, 'product', 'Peça Esgotada', 99.9, ?)`).run(prodDead, A, eanDead);

  // Estoque: camisa M/Azul — loja1(atual): 0; loja2: 5; loja3: 8 (maior doador).
  const inv = db.prepare(`INSERT INTO retail_store_inventory (id, organization_id, store_id, product_service_id, variant_id, quantity_available) VALUES (?, ?, ?, ?, ?, ?)`);
  inv.run(randomUUID(), A, store1, prodCamisa, varM, 0);
  inv.run(randomUUID(), A, store2, prodCamisa, varM, 5);
  inv.run(randomUUID(), A, store3, prodCamisa, varM, 8);
  inv.run(randomUUID(), A, store1, prodDead, null, 0); // esgotada em todas
  db.prepare(`INSERT INTO alterdata_sync_cursors (id, organization_id, module, resource, filial, version, last_synced_at) VALUES (?, ?, 'supply', 'Saldo', '1005', '42', datetime('now', '-2 hours'))`).run(randomUUID(), A);

  const sellerU1 = { userId: uV1, role: "agent" };
  RetailFloorShiftService.open(A, store1, sellerU1);
  RetailFloorQueueService.join(A, { storeId: store1 }, sellerU1);
  const att = RetailFloorAttendanceService.start(A, { storeId: store1 }, sellerU1);

  // Consulta a camisa (sem estoque local, com rede).
  const scanVar = RetailFloorScanService.scan(A, att.id, eanVar, {}, sellerU1);
  check("pré: scan sem estoque local, com rede", scanVar.localStock === 0 && scanVar.networkStock === 13);

  // ===== 1. pedido default → maior doador (loja3, 8) =====
  const r1 = RetailFloorReplenishmentService.request(A, att.id, { scanId: scanVar.scanId }, sellerU1);
  check("pedido default escolhe o maior doador (loja3/8)", r1.target.storeId === store3 && r1.target.quantity === 8, `target=${r1.target?.storeName} q=${r1.target?.quantity}`);
  check("pedido publica sinal", !!r1.signalId && r1.deduped === false);
  const scanRow = db.prepare(`SELECT action FROM retail_floor_attendance_scans WHERE id = ?`).get(scanVar.scanId) as any;
  check("scan marcado transfer_requested", scanRow.action === "transfer_requested");

  // ===== 2. sinal em business_signals com evidência =====
  const sig = db.prepare(`SELECT * FROM business_signals WHERE organization_id = ? AND signal_type = 'retail_floor_replenishment_request'`).get(A) as any;
  check("sinal existe (retail_floor_replenishment_request)", !!sig && sig.source_entity_id === store3);
  const ev = JSON.parse(sig.evidence_json || "{}");
  check("evidência: doadora + saldo + PUBLICADO≠REPOSTO", ev.fromStore === "Loja 1007" && ev.fromStoreQuantity === 8 && /REPOSTO/.test(ev.note));

  // ===== 3. idempotência: mesmo doador atualiza o mesmo sinal =====
  const r1b = RetailFloorReplenishmentService.request(A, att.id, { scanId: scanVar.scanId, targetStoreId: store3 }, sellerU1);
  check("mesmo doador → deduped", r1b.deduped === true && r1b.signalId === r1.signalId);
  const nSig = (db.prepare(`SELECT COUNT(*) AS n FROM business_signals WHERE organization_id = ? AND signal_type = 'retail_floor_replenishment_request'`).get(A) as any).n;
  check("um sinal por doador (não duplica)", nSig === 1, `n=${nSig}`);

  // ===== 4. targetStoreId escolhido é respeitado / recusa sem saldo =====
  const r2 = RetailFloorReplenishmentService.request(A, att.id, { scanId: scanVar.scanId, targetStoreId: store2 }, sellerU1);
  check("targetStoreId escolhido (loja2/5)", r2.target.storeId === store2 && r2.target.quantity === 5);
  let rejectedNoStock = false;
  try { RetailFloorReplenishmentService.request(A, att.id, { scanId: scanVar.scanId, targetStoreId: store1 }, sellerU1); }
  catch { rejectedNoStock = true; }
  check("loja sem saldo é recusada como alvo", rejectedNoStock);

  // ===== 5. peça esgotada na rede → sem transferência =====
  const scanDead = RetailFloorScanService.scan(A, att.id, eanDead, {}, sellerU1);
  let rejectedDead = false;
  try { RetailFloorReplenishmentService.request(A, att.id, { scanId: scanDead.scanId }, sellerU1); }
  catch { rejectedDead = true; }
  check("sem estoque na rede → NÃO inventa transferência", rejectedDead);

  // ===== 6. EAN fora do mix → sem transferência =====
  const scanGhost = RetailFloorScanService.scan(A, att.id, makeEan("789200000003"), {}, sellerU1);
  let rejectedGhost = false;
  try { RetailFloorReplenishmentService.request(A, att.id, { scanId: scanGhost.scanId }, sellerU1); }
  catch { rejectedGhost = true; }
  check("EAN fora do mix → sem transferência", rejectedGhost);

  // ===== 7. isolamento =====
  let rejectedIso = false;
  try { RetailFloorReplenishmentService.request(B, att.id, { scanId: scanVar.scanId }, sellerU1); }
  catch { rejectedIso = true; }
  check("org B não age no atendimento de A", rejectedIso);

  console.log("\n=== TEST: FLOOR — reposição na ruptura (ADR-176) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
