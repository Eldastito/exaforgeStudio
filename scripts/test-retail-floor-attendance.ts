/**
 * TESTE — ADR-150 Fatia 3: atendimento start/finish + auto-encerramento
 * ---------------------------------------------------------------------
 * Prova, offline:
 *   - start: o PRÓXIMO derivado inicia sozinho; fora da vez é not_your_turn;
 *     gestor faz override auditado; fora da fila / não-waiting rejeitados;
 *   - atomicidade: 2º start do mesmo vendedor → attendance_already_active
 *     (SELECT COUNT dentro da tx + unique parcial como backstop);
 *   - fila integrada: iniciar vira `serving` (sem posição); encerrar devolve
 *     pra `waiting` e a chave de retorno manda pro fim da fila;
 *   - finish: cronômetro server-side (ended_at do servidor); converted →
 *     reconciliation_state='pending' + valor/peças declarados (RN-150-004);
 *     not_converted sem estado de conciliação; desfecho inválido rejeitado;
 *     encerrar 2x rejeitado; terceiro sem escopo negado; gestor encerra de
 *     terceiro auditado (RN-150-005);
 *   - auto-encerramento: ativo além de auto_close_minutes fecha com
 *     outcome='unknown' (UPDATE — RN-150-010), devolve o vendedor pra fila e
 *     audita; atendimento fresco intocado;
 *   - isolamento multi-tenant (RN-150-001).
 *
 * Uso:  npm run test:retail-floor-attendance
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-retail-floor-f3-"));
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
  const { RetailFloorAttendanceService } = await import("../src/server/RetailFloorAttendanceService.js");

  const A = `org_A_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'A', 'active')`).run(randomUUID(), A);
  ModuleService.applyVertical(A, "moda");
  ModuleService.enableModule(A, "retail_floor");

  const uManager = randomUUID(), uV1 = randomUUID(), uV2 = randomUUID(), uOther = randomUUID();
  const store1 = randomUUID();
  db.prepare(`INSERT INTO retail_stores (id, organization_id, name, code, manager_user_id) VALUES (?, ?, 'Loja 1005', '1005', ?)`).run(store1, A, uManager);
  const v1 = randomUUID(), v2 = randomUUID();
  db.prepare(`INSERT INTO retail_sellers (id, organization_id, matricula, name, user_id) VALUES (?, ?, 'M-01', 'Ana', ?)`).run(v1, A, uV1);
  db.prepare(`INSERT INTO retail_sellers (id, organization_id, matricula, name, user_id) VALUES (?, ?, 'M-02', 'Bia', ?)`).run(v2, A, uV2);

  const manager = { userId: uManager, role: "agent" };
  const sellerU1 = { userId: uV1, role: "agent" };
  const sellerU2 = { userId: uV2, role: "agent" };

  const shift = RetailFloorShiftService.open(A, store1, manager);
  RetailFloorQueueService.join(A, { storeId: store1 }, sellerU1);
  RetailFloorQueueService.join(A, { storeId: store1 }, sellerU2);
  const setJoined = db.prepare(`UPDATE retail_floor_queue_state SET joined_at = ? WHERE organization_id = ? AND shift_id = ? AND seller_id = ?`);
  setJoined.run("2026-08-02 09:00:00", A, shift.id, v1); // Ana 1ª
  setJoined.run("2026-08-02 09:05:00", A, shift.id, v2); // Bia 2ª

  // ---- 1. start ----
  let notTurn = false;
  try { RetailFloorAttendanceService.start(A, { storeId: store1 }, sellerU2); } catch (e: any) { notTurn = e.message === "not_your_turn"; }
  check("start: fora da vez → not_your_turn (Bia não é a próxima)", notTurn);

  const att1 = RetailFloorAttendanceService.start(A, { storeId: store1 }, sellerU1);
  check("start: o próximo inicia sozinho (cronômetro server-side)", att1.sellerId === v1 && !!att1.startedAt && att1.endedAt === null);
  const qServing = RetailFloorQueueService.ordered(A, shift.id);
  check("start: fila reflete serving (Ana sem posição, Bia vira próxima)",
    qServing.queue.find((r: any) => r.sellerId === v1).status === "serving" &&
    qServing.queue.find((r: any) => r.sellerId === v1).position === null &&
    qServing.queue.find((r: any) => r.sellerId === v2).next === true);

  let dupStart = false;
  try { RetailFloorAttendanceService.start(A, { storeId: store1, sellerId: v1 }, manager); } catch (e: any) { dupStart = /não está aguardando/.test(e.message); }
  check("start: vendedor já serving não inicia 2º (status guard)", dupStart);

  // Raça direta: força a linha da fila de volta pra waiting e tenta de novo —
  // o COUNT dentro da tx segura (o guard de status foi contornado de propósito).
  db.prepare(`UPDATE retail_floor_queue_state SET status = 'waiting' WHERE organization_id = ? AND shift_id = ? AND seller_id = ?`).run(A, shift.id, v1);
  let raceStart = false;
  try { RetailFloorAttendanceService.start(A, { storeId: store1, sellerId: v1 }, manager); } catch (e: any) { raceStart = e.message === "attendance_already_active"; }
  check("start: raça → attendance_already_active (COUNT na tx)", raceStart);
  db.prepare(`UPDATE retail_floor_queue_state SET status = 'serving' WHERE organization_id = ? AND shift_id = ? AND seller_id = ?`).run(A, shift.id, v1);

  // Override: gestor inicia Bia mesmo sem ser... Bia agora É a próxima (Ana serving).
  // Pra testar override, adiciona 3º vendedor na frente é complexo — em vez
  // disso: Bia é a próxima, então gestor iniciando Bia NÃO é override; teste
  // o flag de auditoria do caminho normal + override real com not-next.
  const att2 = RetailFloorAttendanceService.start(A, { storeId: store1, sellerId: v2 }, manager);
  check("start: gestor inicia pelo vendedor (Bia, a próxima)", att2.sellerId === v2);
  RetailFloorAttendanceService.finish(A, att2.id, { outcome: "walkout" }, manager);
  // Agora Ana serving, Bia waiting e única → Bia é a próxima. Simula not-next:
  // vendedor 3 entra depois e gestor o inicia na frente de Bia = override.
  const v3 = randomUUID(), uV3 = randomUUID();
  const sellerU3 = { userId: uV3, role: "agent" };
  db.prepare(`INSERT INTO retail_sellers (id, organization_id, matricula, name, user_id) VALUES (?, ?, 'M-03', 'Caio', ?)`).run(v3, A, uV3);
  RetailFloorQueueService.join(A, { storeId: store1, sellerId: v3 }, manager);
  // Round-robin põe Caio (0 atendimentos) como próximo — gestor iniciar a BIA
  // (1 atendimento) na frente dele é o override real (cliente pediu a Bia).
  const att3 = RetailFloorAttendanceService.start(A, { storeId: store1, sellerId: v2 }, manager);
  const auditStart = db.prepare(`SELECT metadata_json FROM auth_audit_logs WHERE organization_id = ? AND event_type = 'RETAIL_FLOOR_ATTENDANCE_START' ORDER BY rowid DESC LIMIT 1`).get(A) as any;
  check("start: override do gestor (fora da vez) auditado", JSON.parse(auditStart.metadata_json).override === true);
  RetailFloorAttendanceService.finish(A, att3.id, { outcome: "walkout" }, manager);

  let noQueue = false;
  const vOut = randomUUID();
  db.prepare(`INSERT INTO retail_sellers (id, organization_id, matricula, name) VALUES (?, ?, 'M-09', 'Fora')`).run(vOut, A);
  try { RetailFloorAttendanceService.start(A, { storeId: store1, sellerId: vOut }, manager); } catch (e: any) { noQueue = /não está na lista/.test(e.message); }
  check("start: vendedor fora da fila rejeitado", noQueue);

  // ---- 2. finish ----
  let badOutcome = false;
  try { RetailFloorAttendanceService.finish(A, att1.id, { outcome: "maybe" }, sellerU1); } catch { badOutcome = true; }
  check("finish: desfecho inválido rejeitado", badOutcome);
  let crossFinish = false;
  try { RetailFloorAttendanceService.finish(A, att1.id, { outcome: "walkout" }, { userId: uOther, role: "agent" }); } catch (e: any) { crossFinish = e.message === "store_scope_denied"; }
  check("finish: terceiro sem escopo NÃO encerra (RN-150-005)", crossFinish);

  const done1 = RetailFloorAttendanceService.finish(A, att1.id, { outcome: "converted", declaredValue: 350.9, declaredPieces: 2 }, sellerU1);
  check("finish: converted → conciliação pendente + declarados (RN-150-004)",
    done1.outcome === "converted" && done1.reconciliationState === "pending" && done1.declaredValue === 350.9 && done1.declaredPieces === 2 && !!done1.endedAt);
  const qBack = RetailFloorQueueService.ordered(A, shift.id);
  check("finish: vendedor volta pra fila como waiting", qBack.queue.find((r: any) => r.sellerId === v1).status === "waiting");
  let refinish = false;
  try { RetailFloorAttendanceService.finish(A, att1.id, { outcome: "walkout" }, sellerU1); } catch (e: any) { refinish = /já encerrado/.test(e.message); }
  check("finish: encerrar 2x rejeitado", refinish);

  // Determinismo: CURRENT_TIMESTAMP tem precisão de segundo (os 3 encerraram
  // no mesmo segundo) — fixa ended_at distintos pra ordenação ser estável.
  db.prepare(`UPDATE retail_floor_attendances SET ended_at = '2026-08-02 10:00:00' WHERE id = ?`).run(att2.id); // Bia (1º)
  db.prepare(`UPDATE retail_floor_attendances SET ended_at = '2026-08-02 10:05:00' WHERE id = ?`).run(att3.id); // Bia (2º)
  db.prepare(`UPDATE retail_floor_attendances SET ended_at = '2026-08-02 10:10:00' WHERE id = ?`).run(att1.id); // Ana

  // round_robin integrado: Caio (0 atendimentos) primeiro, Ana (1) depois,
  // Bia (2, do override) por último.
  const rr = RetailFloorQueueService.ordered(A, shift.id);
  check("fila: round_robin ordena por menos-atendidos (Caio, Ana, Bia)",
    rr.queue[0].sellerId === v3 && rr.queue[1].sellerId === v1 &&
    rr.queue.filter((r: any) => r.position != null).slice(-1)[0].sellerId === v2);

  // Gestor encerra de terceiro (auditado byManager). Bia (próxima) atende de novo.
  const att4 = RetailFloorAttendanceService.start(A, { storeId: store1, sellerId: v2 }, manager);
  // Fatia 4: not_converted passou a EXIGIR o motivo hierárquico.
  const done4 = RetailFloorAttendanceService.finish(A, att4.id, { outcome: "not_converted", reason: { category: "price" } }, manager);
  check("finish: not_converted sem estado de conciliação", done4.reconciliationState === null);
  const auditFin = db.prepare(`SELECT metadata_json FROM auth_audit_logs WHERE organization_id = ? AND event_type = 'RETAIL_FLOOR_ATTENDANCE_FINISH' ORDER BY rowid DESC LIMIT 1`).get(A) as any;
  check("finish: gestor encerrando terceiro audita byManager", JSON.parse(auditFin.metadata_json).byManager === true);

  // ---- 3. active + elapsed derivado ----
  // Com Bia em 2 atendimentos, o próximo derivado é Caio (1 atend., retorno 10:05).
  const att5 = RetailFloorAttendanceService.start(A, { storeId: store1 }, sellerU3);
  const actives = RetailFloorAttendanceService.active(A, store1);
  check("active: lista ativos com elapsedSeconds derivado do servidor",
    actives.length === 1 && actives[0].id === att5.id && actives[0].elapsedSeconds >= 0 && actives[0].sellerName === "Caio");

  // ---- 4. auto-encerramento ----
  db.prepare(`UPDATE retail_floor_attendances SET started_at = datetime('now', '-120 minutes') WHERE id = ?`).run(att5.id);
  const att6 = RetailFloorAttendanceService.start(A, { storeId: store1, sellerId: v2 }, manager); // fresco (override do gestor)
  const closedCount = RetailFloorAttendanceService.autoCloseStale(A);
  check("autoclose: fecha só o vencido (120min > teto 90)", closedCount === 1);
  const att5After = RetailFloorAttendanceService.get(A, att5.id);
  check("autoclose: outcome='unknown' + ended_at (UPDATE, RN-150-010)", att5After.outcome === "unknown" && !!att5After.endedAt);
  check("autoclose: vendedor devolvido pra fila", RetailFloorQueueService.ordered(A, shift.id).queue.find((r: any) => r.sellerId === v3).status === "waiting");
  check("autoclose: atendimento fresco intocado", RetailFloorAttendanceService.get(A, att6.id).endedAt === null);
  const auditAuto = db.prepare(`SELECT COUNT(*) AS n FROM auth_audit_logs WHERE organization_id = ? AND event_type = 'RETAIL_FLOOR_ATTENDANCE_AUTOCLOSE'`).get(A) as any;
  check("autoclose: auditado", Number(auditAuto.n) === 1);
  // Teto respeita settings: aperta pra 10min e o fresco (agora com ~0min) segue vivo.
  RetailFloorSettingsService.update(A, { autoCloseMinutes: 10 }, uManager);
  check("autoclose: teto da org respeitado (fresco < 10min segue)", RetailFloorAttendanceService.autoCloseStale(A) === 0);

  // ---- 5. Isolamento ----
  const B = `org_B_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'B', 'active')`).run(randomUUID(), B);
  let crossGet = false;
  try { RetailFloorAttendanceService.get(B, att6.id); } catch { crossGet = true; }
  check("Isolamento: org B não lê atendimento de A", crossGet);
  let crossFin = false;
  try { RetailFloorAttendanceService.finish(B, att6.id, { outcome: "walkout" }, { userId: randomUUID(), role: "owner" }); } catch { crossFin = true; }
  check("Isolamento: org B não encerra atendimento de A", crossFin);
  check("Isolamento: autoCloseStale de B não fecha nada de A", RetailFloorAttendanceService.autoCloseStale(B) === 0 && RetailFloorAttendanceService.get(A, att6.id).endedAt === null);

  console.log("\n=== ADR-150 Fatia 3: atendimento + auto-encerramento ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
