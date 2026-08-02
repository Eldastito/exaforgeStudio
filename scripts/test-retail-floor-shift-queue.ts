/**
 * TESTE — ADR-150 Fatia 2: turno + lista da vez (posição derivada)
 * ----------------------------------------------------------------
 * Prova, offline:
 *   - turno: abrir (gestor da loja; negado fora do escopo), 1 aberto por loja
 *     (erro claro), fechar (UPDATE — RN-150-010), reabrir depois de fechado;
 *   - fila: join do próprio vendedor e por gestor; rejoin preserva joined_at
 *     (justiça não zera com pausa); join sem turno aberto / vendedor inativo
 *     rejeitados;
 *   - status: vendedor muda o próprio (break/waiting); NÃO muda o de terceiro;
 *     skipped é só de gestor; serving é rejeitado (pertence à Fatia 3);
 *     auditoria com byManager (RN-150-005);
 *   - posição DERIVADA (RN-150-003): ordem por joined_at sem atendimentos;
 *     round_robin põe quem menos atendeu primeiro; fifo ordena pelo retorno
 *     (último atendimento encerrado); quem não está waiting não tem posição;
 *   - isolamento multi-tenant (RN-150-001).
 *
 * Uso:  npm run test:retail-floor-shift-queue
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-retail-floor-f2-"));
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
  const { RetailFloorSettingsService } = await import("../src/server/RetailFloorService.js");
  const { RetailFloorShiftService, RetailFloorQueueService } = await import("../src/server/RetailFloorShiftService.js");

  const A = `org_A_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'A', 'active')`).run(randomUUID(), A);
  ModuleService.applyVertical(A, "moda");
  ModuleService.enableModule(A, "retail_floor");

  const uOwner = randomUUID(), uManager = randomUUID(), uOther = randomUUID();
  const uV1 = randomUUID(), uV2 = randomUUID(), uV3 = randomUUID();
  const store1 = randomUUID(), store2 = randomUUID();
  db.prepare(`INSERT INTO retail_stores (id, organization_id, name, code, manager_user_id) VALUES (?, ?, 'Loja 1005', '1005', ?)`).run(store1, A, uManager);
  db.prepare(`INSERT INTO retail_stores (id, organization_id, name, code) VALUES (?, ?, 'Loja 1006', '1006')`).run(store2, A);
  const v1 = randomUUID(), v2 = randomUUID(), v3 = randomUUID(), vInactive = randomUUID();
  db.prepare(`INSERT INTO retail_sellers (id, organization_id, matricula, name, user_id) VALUES (?, ?, 'M-01', 'Ana', ?)`).run(v1, A, uV1);
  db.prepare(`INSERT INTO retail_sellers (id, organization_id, matricula, name, user_id) VALUES (?, ?, 'M-02', 'Bia', ?)`).run(v2, A, uV2);
  db.prepare(`INSERT INTO retail_sellers (id, organization_id, matricula, name, user_id) VALUES (?, ?, 'M-03', 'Caio', ?)`).run(v3, A, uV3);
  db.prepare(`INSERT INTO retail_sellers (id, organization_id, matricula, name, user_id, active) VALUES (?, ?, 'M-99', 'Inativa', ?, 0)`).run(vInactive, A, randomUUID());

  const manager = { userId: uManager, role: "agent" };
  const owner = { userId: uOwner, role: "owner" };
  const sellerU1 = { userId: uV1, role: "agent" };
  const sellerU2 = { userId: uV2, role: "agent" };

  // ---- 1. Turno ----
  let denied = false;
  try { RetailFloorShiftService.open(A, store1, { userId: uOther, role: "agent" }); } catch (e: any) { denied = e.message === "store_scope_denied"; }
  check("Turno: usuário fora do escopo NÃO abre (403)", denied);
  const shift = RetailFloorShiftService.open(A, store1, manager);
  check("Turno: gestor da loja abre", shift.status === "open" && shift.storeId === store1 && !!shift.openedAt);
  let dup = false;
  try { RetailFloorShiftService.open(A, store1, manager); } catch (e: any) { dup = e.message === "shift_already_open"; }
  check("Turno: 2º aberto na mesma loja → shift_already_open", dup);
  const shift2 = RetailFloorShiftService.open(A, store2, owner);
  check("Turno: owner abre em qualquer loja (loja 2 em paralelo)", shift2.status === "open");
  let badStore = false;
  try { RetailFloorShiftService.open(A, randomUUID(), owner); } catch { badStore = true; }
  check("Turno: loja inexistente rejeitada", badStore);

  // ---- 2. Fila: join ----
  let noShift = false;
  try {
    RetailFloorShiftService.close(A, shift2.id, owner);
    RetailFloorQueueService.join(A, { storeId: store2 }, sellerU1);
  } catch (e: any) { noShift = /Nenhum turno aberto/.test(e.message); }
  check("Fila: join sem turno aberto rejeitado", noShift);

  RetailFloorQueueService.join(A, { storeId: store1 }, sellerU1);            // Ana (self)
  RetailFloorQueueService.join(A, { storeId: store1 }, sellerU2);            // Bia (self)
  const q0 = RetailFloorQueueService.join(A, { storeId: store1, sellerId: v3 }, manager); // Caio (gestor)
  check("Fila: 3 na lista (self + self + gestor)", q0.queue.length === 3);

  let outsiderJoin = false;
  try { RetailFloorQueueService.join(A, { storeId: store1, sellerId: v1 }, { userId: uOther, role: "agent" }); } catch (e: any) { outsiderJoin = e.message === "store_scope_denied"; }
  check("Fila: terceiro sem escopo NÃO adiciona outro vendedor", outsiderJoin);
  let inactiveJoin = false;
  try { RetailFloorQueueService.join(A, { storeId: store1, sellerId: vInactive }, manager); } catch { inactiveJoin = true; }
  check("Fila: vendedor inativo rejeitado", inactiveJoin);

  // Ordem determinística pra testar posição derivada (CURRENT_TIMESTAMP tem
  // precisão de segundo — o teste fixa joined_at).
  const setJoined = db.prepare(`UPDATE retail_floor_queue_state SET joined_at = ? WHERE organization_id = ? AND shift_id = ? AND seller_id = ?`);
  setJoined.run("2026-08-02 09:00:00", A, shift.id, v1);
  setJoined.run("2026-08-02 09:05:00", A, shift.id, v2);
  setJoined.run("2026-08-02 09:10:00", A, shift.id, v3);

  const q1 = RetailFloorQueueService.ordered(A, shift.id);
  check("Posição: sem atendimentos, ordena por joined_at (Ana 1ª)",
    q1.queue[0].sellerId === v1 && q1.queue[0].position === 1 && q1.queue[0].next === true &&
    q1.queue[1].sellerId === v2 && q1.queue[2].sellerId === v3);

  // ---- 3. Status ----
  const qBreak = RetailFloorQueueService.setStatus(A, { storeId: store1, sellerId: v1, status: "break" }, sellerU1);
  const anaRow = qBreak.queue.find((r: any) => r.sellerId === v1);
  check("Status: vendedor entra em pausa (self)", anaRow.status === "break" && anaRow.position === null && anaRow.next === false);
  check("Status: com Ana em pausa, Bia vira a próxima", qBreak.queue.find((r: any) => r.sellerId === v2).next === true);

  let crossSeller = false;
  try { RetailFloorQueueService.setStatus(A, { storeId: store1, sellerId: v2, status: "break" }, sellerU1); } catch (e: any) { crossSeller = e.message === "store_scope_denied"; }
  check("Status: vendedor NÃO muda status de colega", crossSeller);
  let selfSkip = false;
  try { RetailFloorQueueService.setStatus(A, { storeId: store1, sellerId: v1, status: "skipped" }, sellerU1); } catch (e: any) { selfSkip = e.message === "store_scope_denied"; }
  check("Status: skipped é só de gestor", selfSkip);
  let servingHere = false;
  try { RetailFloorQueueService.setStatus(A, { storeId: store1, sellerId: v2, status: "serving" }, manager); } catch { servingHere = true; }
  check("Status: serving rejeitado na fila (é da Fatia 3)", servingHere);

  RetailFloorQueueService.setStatus(A, { storeId: store1, sellerId: v2, status: "skipped" }, manager);
  const audit = db.prepare(`SELECT metadata_json FROM auth_audit_logs WHERE organization_id = ? AND event_type = 'RETAIL_FLOOR_QUEUE_STATUS' ORDER BY rowid DESC LIMIT 1`).get(A) as any;
  check("Status: skip do gestor audita com byManager", JSON.parse(audit.metadata_json).byManager === true);

  // Rejoin: Ana volta da pausa; joined_at PRESERVADO (justiça não zera).
  RetailFloorQueueService.join(A, { storeId: store1 }, sellerU1);
  const anaJoined = (db.prepare(`SELECT joined_at FROM retail_floor_queue_state WHERE organization_id = ? AND shift_id = ? AND seller_id = ?`).get(A, shift.id, v1) as any).joined_at;
  check("Rejoin: preserva joined_at", anaJoined === "2026-08-02 09:00:00");
  const q2 = RetailFloorQueueService.ordered(A, shift.id);
  check("Rejoin: Ana volta como próxima (Bia skipped, Caio depois)",
    q2.queue.find((r: any) => r.sellerId === v1).next === true && q2.queue.find((r: any) => r.sellerId === v2).position === null);

  // ---- 4. Posição derivada com atendimentos (simula Fatia 3 via SQL cru) ----
  RetailFloorQueueService.join(A, { storeId: store1, sellerId: v2 }, manager); // Bia volta
  // Ana já atendeu 2x; Bia 1x (encerrou DEPOIS do join do Caio); Caio 0.
  const att = db.prepare(`INSERT INTO retail_floor_attendances (id, organization_id, store_id, shift_id, seller_id, started_at, ended_at, outcome) VALUES (?, ?, ?, ?, ?, ?, ?, 'not_converted')`);
  att.run(randomUUID(), A, store1, shift.id, v1, "2026-08-02 10:00:00", "2026-08-02 10:20:00");
  att.run(randomUUID(), A, store1, shift.id, v1, "2026-08-02 11:00:00", "2026-08-02 11:30:00");
  att.run(randomUUID(), A, store1, shift.id, v2, "2026-08-02 11:40:00", "2026-08-02 12:00:00");

  const rr = RetailFloorQueueService.ordered(A, shift.id);
  check("round_robin: quem MENOS atendeu é o próximo (Caio, 0 atend.)",
    rr.policy === "round_robin" && rr.queue[0].sellerId === v3 && rr.queue[0].served === 0);
  check("round_robin: Bia (1) antes de Ana (2)",
    rr.queue[1].sellerId === v2 && rr.queue[2].sellerId === v1);

  RetailFloorSettingsService.update(A, { queuePolicy: "fifo" }, uOwner);
  const ff = RetailFloorQueueService.ordered(A, shift.id);
  check("fifo: ordena pelo retorno — Caio (nunca atendeu, joined 09:10) primeiro",
    ff.policy === "fifo" && ff.queue[0].sellerId === v3);
  check("fifo: Ana (encerrou 11:30) antes de Bia (encerrou 12:00)",
    ff.queue[1].sellerId === v1 && ff.queue[2].sellerId === v2);

  // ---- 5. Fechamento ----
  const closed = RetailFloorShiftService.close(A, shift.id, manager);
  check("Fechar: UPDATE com closed_at/closed_by (RN-150-010)", closed.status === "closed" && !!closed.closedAt && closed.closedBy === uManager);
  let reclose = false;
  try { RetailFloorShiftService.close(A, shift.id, manager); } catch { reclose = true; }
  check("Fechar: turno já fechado é erro claro", reclose);
  const reopened = RetailFloorShiftService.open(A, store1, manager);
  check("Reabrir: novo turno na mesma loja depois do fechamento", reopened.status === "open" && reopened.id !== shift.id);
  const rowsKept = db.prepare(`SELECT COUNT(*) AS n FROM retail_floor_queue_state WHERE organization_id = ? AND shift_id = ?`).get(A, shift.id) as any;
  check("Retenção: roster do turno fechado preservado (sem DELETE)", Number(rowsKept.n) === 3);

  // ---- 6. Isolamento ----
  const B = `org_B_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'B', 'active')`).run(randomUUID(), B);
  let crossShift = false;
  try { RetailFloorShiftService.get(B, reopened.id); } catch { crossShift = true; }
  check("Isolamento: org B não lê turno de A", crossShift);
  let crossClose = false;
  try { RetailFloorShiftService.close(B, reopened.id, { userId: randomUUID(), role: "owner" }); } catch { crossClose = true; }
  check("Isolamento: org B não fecha turno de A", crossClose);
  const qB = RetailFloorQueueService.ordered(B, reopened.id);
  check("Isolamento: fila de A vazia sob org B", qB.queue.length === 0);

  console.log("\n=== ADR-150 Fatia 2: turno + lista da vez ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
