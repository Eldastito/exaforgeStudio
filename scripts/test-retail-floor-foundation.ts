/**
 * TESTE — ADR-150 Fatia 1: fundação do Retail Floor (Atendimento de Loja)
 * -----------------------------------------------------------------------
 * Prova, offline:
 *   - gate de módulo: nenhuma vertical liga `retail_floor` sozinha; opt-in
 *     explícito liga (PLAN_FREE_ADDONS, mesmo racional do retail);
 *   - schema: as 6 tabelas existem; unique parcial de turno aberto (1 por
 *     loja) e de atendimento ativo (1 por vendedor) seguram raça no banco;
 *   - settings: criação lazy com defaults, update validado, auditoria,
 *     calibração (RN-150-011);
 *   - contexto por escopo: owner vê todas as lojas; gerente de loja vê SÓ a
 *     sua; vendedor mapeado recebe sellerProfile; assertStoreManager nega
 *     fora do escopo (RN-150-005);
 *   - isolamento multi-tenant (RN-150-001).
 *
 * Uso:  npm run test:retail-floor-foundation
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-retail-floor-f1-"));
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
  const { RetailFloorService, RetailFloorSettingsService } = await import("../src/server/RetailFloorService.js");

  // ---- 1. Gate de módulo ----
  const A = `org_A_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'A', 'active')`).run(randomUUID(), A);
  ModuleService.applyVertical(A, "moda");
  check("Gate: vertical moda NÃO liga retail_floor sozinha", !ModuleService.isEnabled(A, "retail_floor"));
  ModuleService.enableModule(A, "retail_floor");
  check("Gate: opt-in explícito liga (PLAN_FREE_ADDONS)", ModuleService.isEnabled(A, "retail_floor"));
  check("Gate: rota /api/retail-floor mapeia pro módulo", ModuleService.MODULE_BY_ROUTE["retail-floor"] === "retail_floor");
  ModuleService.applyVertical(A, "moda");
  check("Gate: grandfather — re-aplicar vertical preserva o add-on", ModuleService.isEnabled(A, "retail_floor"));

  // ---- 2. Schema ----
  const tables = ["retail_floor_settings", "retail_floor_shifts", "retail_floor_queue_state", "retail_floor_attendances", "retail_floor_attendance_scans", "retail_floor_unmet_demand"];
  for (const t of tables) {
    const row = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(t);
    check(`Schema: tabela ${t} existe`, !!row);
  }
  const cols = db.prepare(`PRAGMA table_info(retail_erp_seller_sales)`).all() as any[];
  check("Schema: aditivo retail_erp_seller_sales.attendance_id", cols.some((c) => c.name === "attendance_id"));

  // Unique parcial: 1 turno aberto por loja.
  const storeX = randomUUID();
  db.prepare(`INSERT INTO retail_floor_shifts (id, organization_id, store_id, status) VALUES (?, ?, ?, 'open')`).run(randomUUID(), A, storeX);
  let dupShift = false;
  try { db.prepare(`INSERT INTO retail_floor_shifts (id, organization_id, store_id, status) VALUES (?, ?, ?, 'open')`).run(randomUUID(), A, storeX); } catch { dupShift = true; }
  check("Schema: 2º turno aberto na mesma loja é rejeitado (unique parcial)", dupShift);
  db.prepare(`INSERT INTO retail_floor_shifts (id, organization_id, store_id, status) VALUES (?, ?, ?, 'closed')`).run(randomUUID(), A, storeX);
  check("Schema: turno fechado NÃO conflita com o aberto", true);

  // Unique parcial: 1 atendimento ativo por vendedor.
  const sellerX = randomUUID();
  db.prepare(`INSERT INTO retail_floor_attendances (id, organization_id, store_id, shift_id, seller_id) VALUES (?, ?, ?, ?, ?)`).run(randomUUID(), A, storeX, "s1", sellerX);
  let dupAtt = false;
  try { db.prepare(`INSERT INTO retail_floor_attendances (id, organization_id, store_id, shift_id, seller_id) VALUES (?, ?, ?, ?, ?)`).run(randomUUID(), A, storeX, "s1", sellerX); } catch { dupAtt = true; }
  check("Schema: 2º atendimento ATIVO do mesmo vendedor é rejeitado", dupAtt);
  db.prepare(`INSERT INTO retail_floor_attendances (id, organization_id, store_id, shift_id, seller_id, ended_at) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`).run(randomUUID(), A, storeX, "s1", sellerX);
  check("Schema: atendimento ENCERRADO não conflita com o ativo", true);

  // ---- 3. Settings ----
  const s0 = RetailFloorSettingsService.get(A);
  check("Settings: defaults (round_robin, 90min, anônimo, sem calibração)",
    s0.queuePolicy === "round_robin" && s0.autoCloseMinutes === 90 && s0.anonymousDefault === true && s0.calibrationUntil === null);
  const s1 = RetailFloorSettingsService.update(A, { queuePolicy: "fifo", autoCloseMinutes: 60, calibrationUntil: "2099-12-31" }, "u1");
  check("Settings: update persiste", s1.queuePolicy === "fifo" && s1.autoCloseMinutes === 60 && s1.calibrationUntil === "2099-12-31");
  check("Settings: calibração ativa (RN-150-011)", RetailFloorSettingsService.inCalibration(A));
  let badPolicy = false;
  try { RetailFloorSettingsService.update(A, { queuePolicy: "lifo" }, "u1"); } catch { badPolicy = true; }
  check("Settings: queue_policy inválida é rejeitada", badPolicy);
  let badMinutes = false;
  try { RetailFloorSettingsService.update(A, { autoCloseMinutes: 5 }, "u1"); } catch { badMinutes = true; }
  check("Settings: auto_close fora de 10..480 é rejeitado", badMinutes);
  const audit = db.prepare(`SELECT COUNT(*) AS n FROM auth_audit_logs WHERE organization_id = ? AND event_type = 'RETAIL_FLOOR_SETTINGS_UPDATE'`).get(A) as any;
  check("Settings: update audita (logAuthEvent)", Number(audit.n) >= 1);

  // ---- 4. Contexto por escopo ----
  const uOwner = randomUUID(), uManager = randomUUID(), uSeller = randomUUID(), uNobody = randomUUID();
  const store1 = randomUUID(), store2 = randomUUID();
  db.prepare(`INSERT INTO retail_stores (id, organization_id, name, code, manager_user_id) VALUES (?, ?, 'Loja 1005', '1005', ?)`).run(store1, A, uManager);
  db.prepare(`INSERT INTO retail_stores (id, organization_id, name, code) VALUES (?, ?, 'Loja 1006', '1006')`).run(store2, A);
  db.prepare(`INSERT INTO retail_sellers (id, organization_id, matricula, name, user_id) VALUES (?, ?, 'M-77', 'Vendedora V', ?)`).run(randomUUID(), A, uSeller);

  const ctxOwner = RetailFloorService.context(A, { userId: uOwner, role: "owner" });
  check("Contexto: owner gerencia TODAS as lojas ativas", ctxOwner.manageableStores.length === 2 && ctxOwner.canConfigure === true);
  check("Contexto: expõe settings + calibração", ctxOwner.settings.queuePolicy === "fifo" && ctxOwner.inCalibration === true);

  const ctxMgr = RetailFloorService.context(A, { userId: uManager, role: "agent" });
  check("Contexto: gerente de loja vê SÓ a sua (escopo por manager_user_id)",
    ctxMgr.manageableStores.length === 1 && ctxMgr.manageableStores[0].id === store1 && ctxMgr.canConfigure === false);

  const ctxSeller = RetailFloorService.context(A, { userId: uSeller, role: "agent" });
  check("Contexto: vendedor mapeado recebe sellerProfile (matrícula)",
    ctxSeller.sellerProfile?.matricula === "M-77" && ctxSeller.manageableStores.length === 0);

  const ctxNobody = RetailFloorService.context(A, { userId: uNobody, role: "agent" });
  check("Contexto: usuário sem vínculo não gerencia nem vende", ctxNobody.manageableStores.length === 0 && ctxNobody.sellerProfile === null);

  // assertStoreManager (RN-150-005)
  let okMgr = true; try { RetailFloorService.assertStoreManager(A, { userId: uManager, role: "agent" }, store1); } catch { okMgr = false; }
  check("Escopo: gerente autoriza na PRÓPRIA loja", okMgr);
  let denied = false; try { RetailFloorService.assertStoreManager(A, { userId: uManager, role: "agent" }, store2); } catch { denied = true; }
  check("Escopo: gerente NEGADO em loja alheia", denied);
  let okAdmin = true; try { RetailFloorService.assertStoreManager(A, { userId: uOwner, role: "admin" }, store2); } catch { okAdmin = false; }
  check("Escopo: admin autoriza em qualquer loja da org", okAdmin);

  // ---- 5. Isolamento multi-tenant ----
  const B = `org_B_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'B', 'active')`).run(randomUUID(), B);
  ModuleService.applyVertical(B, "moda");
  check("Isolamento: B não ganhou o módulo por A", !ModuleService.isEnabled(B, "retail_floor"));
  const sB = RetailFloorSettingsService.get(B);
  check("Isolamento: settings de B são defaults (não herdou o fifo de A)", sB.queuePolicy === "round_robin" && sB.calibrationUntil === null);
  const ctxB = RetailFloorService.context(B, { userId: uOwner, role: "owner" });
  check("Isolamento: contexto de B não vê lojas de A", ctxB.manageableStores.length === 0);
  let crossDenied = false; try { RetailFloorService.assertStoreManager(B, { userId: uManager, role: "agent" }, store1); } catch { crossDenied = true; }
  check("Isolamento: escopo cross-tenant negado", crossDenied);

  console.log("\n=== ADR-150 Fatia 1: fundação do Retail Floor ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
