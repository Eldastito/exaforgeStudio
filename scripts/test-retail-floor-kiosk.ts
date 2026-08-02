/**
 * TESTE — ADR-150 Fatia 12: PIN da gerência (modo quiosque)
 * ----------------------------------------------------------
 * Prova, offline:
 *   - schema: aditivos manager_pin_* em retail_stores;
 *   - setManagerPin: 4-8 dígitos, salt novo por set, exige PIN atual pra
 *     trocar/remover quando já existe, auditoria;
 *   - verifyManagerPin: PIN_NOT_SET / PIN_REQUIRED / PIN_INVALID / lockout
 *     5×/15min (PIN_LOCKED) / acerto zera contador — molde Clínica Fase 28;
 *   - resetManagerPinLockout destrava antes da janela;
 *   - contexto expõe hasManagerPin (booleano, nunca o hash);
 *   - isolamento multi-tenant (RN-150-001).
 *
 * Uso:  npm run test:retail-floor-kiosk
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-retail-floor-f12-"));
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
  const { RetailFloorService } = await import("../src/server/RetailFloorService.js");

  const A = `org_A_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'A', 'active')`).run(randomUUID(), A);
  const uOwner = randomUUID();
  const store1 = randomUUID();
  db.prepare(`INSERT INTO retail_stores (id, organization_id, name, code) VALUES (?, ?, 'Loja 1005', '1005')`).run(store1, A);

  // ---- 1. Schema ----
  const cols = (db.prepare(`PRAGMA table_info(retail_stores)`).all() as any[]).map((c) => c.name);
  for (const c of ["manager_pin_salt", "manager_pin_hash", "manager_pin_failed_count", "manager_pin_locked_until"]) {
    check(`Schema: aditivo retail_stores.${c}`, cols.includes(c));
  }

  // ---- 2. verify sem PIN configurado ----
  let notSet = "";
  try { RetailFloorService.verifyManagerPin(A, store1, "1234"); } catch (e: any) { notSet = e.code; }
  check("Verify: sem PIN configurado → PIN_NOT_SET", notSet === "PIN_NOT_SET");

  // ---- 3. setManagerPin ----
  let badFormat = "";
  try { RetailFloorService.setManagerPin(A, store1, "12", undefined, uOwner); } catch (e: any) { badFormat = e.code; }
  check("Set: PIN curto é rejeitado (PIN_INVALID_FORMAT)", badFormat === "PIN_INVALID_FORMAT");
  let alpha = "";
  try { RetailFloorService.setManagerPin(A, store1, "abcd", undefined, uOwner); } catch (e: any) { alpha = e.code; }
  check("Set: PIN não numérico é rejeitado", alpha === "PIN_INVALID_FORMAT");

  const set1 = RetailFloorService.setManagerPin(A, store1, "4321", undefined, uOwner);
  check("Set: 1º PIN aceito (sem PIN atual exigido)", set1.hasManagerPin === true);
  const auditSet = db.prepare(`SELECT COUNT(*) AS n FROM auth_audit_logs WHERE organization_id = ? AND event_type = 'RETAIL_FLOOR_MANAGER_PIN_SET'`).get(A) as any;
  check("Set: audita (logAuthEvent)", Number(auditSet.n) >= 1);

  // Trocar sem o PIN atual → nega; com PIN atual errado → nega; certo → troca.
  let noCur = "";
  try { RetailFloorService.setManagerPin(A, store1, "9999", undefined, uOwner); } catch (e: any) { noCur = e.code; }
  check("Set: trocar sem PIN atual é negado (PIN_REQUIRED)", noCur === "PIN_REQUIRED");
  let wrongCur = "";
  try { RetailFloorService.setManagerPin(A, store1, "9999", "0000", uOwner); } catch (e: any) { wrongCur = e.code; }
  check("Set: trocar com PIN atual errado é negado (PIN_INVALID)", wrongCur === "PIN_INVALID");
  const set2 = RetailFloorService.setManagerPin(A, store1, "8765", "4321", uOwner);
  check("Set: trocar com PIN atual certo funciona", set2.hasManagerPin === true);

  // ---- 4. verifyManagerPin ----
  check("Verify: PIN certo retorna true", RetailFloorService.verifyManagerPin(A, store1, "8765") === true);
  let required = "";
  try { RetailFloorService.verifyManagerPin(A, store1, ""); } catch (e: any) { required = e.code; }
  check("Verify: vazio → PIN_REQUIRED", required === "PIN_REQUIRED");
  let invalid = "";
  try { RetailFloorService.verifyManagerPin(A, store1, "0000"); } catch (e: any) { invalid = e.code; }
  check("Verify: errado → PIN_INVALID + contador", invalid === "PIN_INVALID");
  const c1 = db.prepare(`SELECT manager_pin_failed_count AS n FROM retail_stores WHERE id = ?`).get(store1) as any;
  check("Verify: contador de falhas incrementou", Number(c1.n) === 1);
  RetailFloorService.verifyManagerPin(A, store1, "8765");
  const c2 = db.prepare(`SELECT manager_pin_failed_count AS n FROM retail_stores WHERE id = ?`).get(store1) as any;
  check("Verify: acerto zera o contador", Number(c2.n) === 0);

  // ---- 5. Lockout 5×/15min ----
  let lockedCode = "";
  for (let i = 0; i < 5; i++) {
    try { RetailFloorService.verifyManagerPin(A, store1, "0000"); } catch (e: any) { lockedCode = e.code; }
  }
  check("Lockout: 5ª falha → PIN_LOCKED", lockedCode === "PIN_LOCKED");
  let stillLocked = "";
  try { RetailFloorService.verifyManagerPin(A, store1, "8765"); } catch (e: any) { stillLocked = e.code; }
  check("Lockout: até o PIN CERTO é bloqueado na janela", stillLocked === "PIN_LOCKED");
  const auditLock = db.prepare(`SELECT COUNT(*) AS n FROM auth_audit_logs WHERE organization_id = ? AND event_type = 'RETAIL_FLOOR_MANAGER_PIN_LOCKED'`).get(A) as any;
  check("Lockout: audita RETAIL_FLOOR_MANAGER_PIN_LOCKED", Number(auditLock.n) >= 1);

  RetailFloorService.resetManagerPinLockout(A, store1, uOwner);
  check("Lockout: reset destrava antes dos 15 min", RetailFloorService.verifyManagerPin(A, store1, "8765") === true);

  // ---- 6. Contexto expõe hasManagerPin ----
  const ctx = RetailFloorService.context(A, { userId: uOwner, role: "owner" });
  check("Contexto: stores trazem hasManagerPin=true", ctx.stores.find((s: any) => s.id === store1)?.hasManagerPin === true);
  check("Contexto: NUNCA expõe o hash", JSON.stringify(ctx).includes("pin_hash") === false && JSON.stringify(ctx).includes("manager_pin") === false);

  // Remover exige PIN atual; depois hasManagerPin=false.
  const cleared = RetailFloorService.setManagerPin(A, store1, null, "8765", uOwner);
  check("Set: remover com PIN atual funciona", cleared.hasManagerPin === false);
  let notSet2 = "";
  try { RetailFloorService.verifyManagerPin(A, store1, "8765"); } catch (e: any) { notSet2 = e.code; }
  check("Set: removido volta a PIN_NOT_SET", notSet2 === "PIN_NOT_SET");
  RetailFloorService.setManagerPin(A, store1, "8765", undefined, uOwner);

  // ---- 7. Isolamento multi-tenant ----
  const B = `org_B_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'B', 'active')`).run(randomUUID(), B);
  let crossVerify = false;
  try { RetailFloorService.verifyManagerPin(B, store1, "8765"); } catch { crossVerify = true; }
  check("Isolamento: verify cross-tenant negado (loja não encontrada)", crossVerify);
  let crossSet = false;
  try { RetailFloorService.setManagerPin(B, store1, "1111", undefined, uOwner); } catch { crossSet = true; }
  check("Isolamento: set cross-tenant negado", crossSet);

  console.log("\n=== ADR-150 Fatia 12: PIN da gerência (modo quiosque) ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
