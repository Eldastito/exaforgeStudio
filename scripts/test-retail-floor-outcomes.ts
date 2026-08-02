/**
 * TESTE — ADR-150 Fatia 4: taxonomia hierárquica de desfecho + retorno à fila
 * ---------------------------------------------------------------------------
 * Prova, offline:
 *   - not_converted EXIGE motivo (category); category inválida rejeitada;
 *   - category='product' EXIGE productDetail.reason da taxonomia da demanda
 *     não atendida; reason inválida rejeitada; detalhe (size/color) canônico
 *     persistido e devolvido parseado;
 *   - productDetail em categoria não-product rejeitado;
 *   - converted/walkout com motivo REJEITADOS (motivo só onde faz sentido —
 *     senão o Pareto de perdas mente);
 *   - política de retorno: default volta `waiting`; returnTo='break' vai pra
 *     pausa; returnTo inválido rejeitado;
 *   - taxonomia exposta no contexto (fonte única pros dropdowns);
 *   - auditoria carrega reasonCategory + returnTo.
 *
 * Uso:  npm run test:retail-floor-outcomes
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-retail-floor-f4-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-retail-floor-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { ModuleService } = await import("../src/server/ModuleService.js");
  const { RetailFloorService } = await import("../src/server/RetailFloorService.js");
  const { RetailFloorShiftService, RetailFloorQueueService } = await import("../src/server/RetailFloorShiftService.js");
  const { RetailFloorAttendanceService } = await import("../src/server/RetailFloorAttendanceService.js");

  const A = `org_A_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'A', 'active')`).run(randomUUID(), A);
  ModuleService.applyVertical(A, "moda");
  ModuleService.enableModule(A, "retail_floor");

  const uManager = randomUUID(), uV1 = randomUUID();
  const store1 = randomUUID();
  db.prepare(`INSERT INTO retail_stores (id, organization_id, name, code, manager_user_id) VALUES (?, ?, 'Loja 1005', '1005', ?)`).run(store1, A, uManager);
  const v1 = randomUUID();
  db.prepare(`INSERT INTO retail_sellers (id, organization_id, matricula, name, user_id) VALUES (?, ?, 'M-01', 'Ana', ?)`).run(v1, A, uV1);

  const manager = { userId: uManager, role: "agent" };
  const sellerU1 = { userId: uV1, role: "agent" };
  RetailFloorShiftService.open(A, store1, manager);
  RetailFloorQueueService.join(A, { storeId: store1 }, sellerU1);

  const startAtt = () => RetailFloorAttendanceService.start(A, { storeId: store1 }, sellerU1);
  const queueStatus = () => {
    const shift = RetailFloorShiftService.currentForStore(A, store1)!;
    return RetailFloorQueueService.ordered(A, shift.id).queue.find((r: any) => r.sellerId === v1).status;
  };

  // ---- 1. not_converted exige motivo hierárquico ----
  let att = startAtt();
  let noReason = false;
  try { RetailFloorAttendanceService.finish(A, att.id, { outcome: "not_converted" }, sellerU1); } catch (e: any) { noReason = /Motivo obrigatório/.test(e.message); }
  check("not_converted sem motivo → rejeitado", noReason);
  let badCat = false;
  try { RetailFloorAttendanceService.finish(A, att.id, { outcome: "not_converted", reason: { category: "clima" } }, sellerU1); } catch (e: any) { badCat = /Motivo obrigatório/.test(e.message); }
  check("category inválida rejeitada", badCat);
  let prodNoDetail = false;
  try { RetailFloorAttendanceService.finish(A, att.id, { outcome: "not_converted", reason: { category: "product" } }, sellerU1); } catch (e: any) { prodNoDetail = /productDetail\.reason/.test(e.message); }
  check("product sem productDetail.reason rejeitado", prodNoDetail);
  let badProdReason = false;
  try { RetailFloorAttendanceService.finish(A, att.id, { outcome: "not_converted", reason: { category: "product", productDetail: { reason: "sumiu" } } }, sellerU1); } catch (e: any) { badProdReason = /productDetail\.reason/.test(e.message); }
  check("productDetail.reason fora da taxonomia rejeitado", badProdReason);
  let detailOnPrice = false;
  try { RetailFloorAttendanceService.finish(A, att.id, { outcome: "not_converted", reason: { category: "price", productDetail: { reason: "missing_size" } } }, sellerU1); } catch (e: any) { detailOnPrice = /só se aplica à categoria product/.test(e.message); }
  check("productDetail em categoria não-product rejeitado", detailOnPrice);

  // Motivo válido nível 2: faltou tamanho M na malha.
  const done1 = RetailFloorAttendanceService.finish(A, att.id, {
    outcome: "not_converted",
    reason: { category: "product", note: "cliente queria a malha nova", productDetail: { reason: "missing_size", size: "M", categoryLabel: "malha" } },
  }, sellerU1);
  check("motivo hierárquico persistido e devolvido canônico",
    done1.outcome === "not_converted" && done1.outcomeReason?.category === "product" &&
    done1.outcomeReason?.productDetail?.reason === "missing_size" && done1.outcomeReason?.productDetail?.size === "M" &&
    done1.outcomeReason?.productDetail?.categoryLabel === "malha" && done1.reconciliationState === null);
  check("retorno default: volta waiting", queueStatus() === "waiting");
  const auditFin = db.prepare(`SELECT metadata_json FROM auth_audit_logs WHERE organization_id = ? AND event_type = 'RETAIL_FLOOR_ATTENDANCE_FINISH' ORDER BY rowid DESC LIMIT 1`).get(A) as any;
  const meta = JSON.parse(auditFin.metadata_json);
  check("auditoria carrega reasonCategory + returnTo", meta.reasonCategory === "product" && meta.returnTo === "waiting");

  // ---- 2. motivo rejeitado onde não faz sentido ----
  att = startAtt();
  let reasonOnConverted = false;
  try { RetailFloorAttendanceService.finish(A, att.id, { outcome: "converted", reason: { category: "price" } }, sellerU1); } catch (e: any) { reasonOnConverted = /só se aplica a desfecho not_converted/.test(e.message); }
  check("converted com motivo rejeitado", reasonOnConverted);
  let reasonOnWalkout = false;
  try { RetailFloorAttendanceService.finish(A, att.id, { outcome: "walkout", reason: { category: "other" } }, sellerU1); } catch (e: any) { reasonOnWalkout = /só se aplica a desfecho not_converted/.test(e.message); }
  check("walkout com motivo rejeitado", reasonOnWalkout);
  const doneW = RetailFloorAttendanceService.finish(A, att.id, { outcome: "walkout" }, sellerU1);
  check("walkout sem motivo segue ok (outcomeReason null)", doneW.outcome === "walkout" && doneW.outcomeReason === null);

  // Categoria não-product sem detalhe: canônica com note truncada.
  att = startAtt();
  const donePrice = RetailFloorAttendanceService.finish(A, att.id, { outcome: "not_converted", reason: { category: "price", note: "x".repeat(600) } }, sellerU1);
  check("categoria simples (price) com note truncada a 500", donePrice.outcomeReason?.category === "price" && donePrice.outcomeReason?.note?.length === 500);

  // ---- 3. política de retorno ----
  att = startAtt();
  let badReturn = false;
  try { RetailFloorAttendanceService.finish(A, att.id, { outcome: "walkout", returnTo: "home" }, sellerU1); } catch (e: any) { badReturn = /returnTo inválido/.test(e.message); }
  check("returnTo inválido rejeitado", badReturn);
  RetailFloorAttendanceService.finish(A, att.id, { outcome: "converted", declaredValue: 100, returnTo: "break" }, sellerU1);
  check("returnTo='break': vendedor vai pra pausa após encerrar", queueStatus() === "break");
  // Volta pra fila pra não travar os próximos starts.
  RetailFloorQueueService.join(A, { storeId: store1 }, sellerU1);
  check("rejoin pós-pausa volta waiting", queueStatus() === "waiting");

  // ---- 4. taxonomia no contexto (fonte única da UI) ----
  const ctx = RetailFloorService.context(A, { userId: uManager, role: "agent" });
  check("contexto expõe taxonomia (5 categorias + 6 motivos de produto)",
    ctx.taxonomy?.notConvertedCategories?.length === 5 && ctx.taxonomy?.productReasons?.length === 6 &&
    ctx.taxonomy.notConvertedCategories.includes("product") && ctx.taxonomy.productReasons.includes("no_network_stock"));

  console.log("\n=== ADR-150 Fatia 4: taxonomia de desfecho + retorno à fila ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
