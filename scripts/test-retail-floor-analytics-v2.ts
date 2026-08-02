/**
 * TESTE — ADR-150 Fatia 13: Analytics v2 (métricas novas sobre dados já gravados)
 * -------------------------------------------------------------------------------
 * Prova, offline:
 *  Grupo 1 (agregações novas no /analytics/store):
 *   - ticket médio e PA (peças/venda) SEMPRE declarado × confirmado (RN-150-004),
 *     média só sobre linhas com o dado preenchido;
 *   - unknownCount/unknownPct (higiene: auto-encerrados sobre o total);
 *   - byHour ganha walkouts (entrou-e-saiu por hora de pico);
 *   - byDay: série por dia com contagens honestas;
 *   - scanSplit: conversão com × sem consulta de peça (denominador decided);
 *   - unmetLostValue: R$ da ruptura via preço do catálogo; peça sem produto
 *     resolvido conta em unpricedCount (não finge precisão);
 *   - rede (Fatia 10) carrega ticketConfirmed/unknownPct/unmetLostValue.
 *  Grupo 2 (ops derivadas do audit — RetailFloorOpsMetricsService):
 *   - queueSkips: furos de fila autorizados (override=true da RN-150-012),
 *     total/byDay/bySeller (alfabético — fato, não ranking RN-150-006);
 *   - pauses: pausas por vendedor pareando entrada→saída do status; pausa em
 *     aberto conta na frequência e NÃO nos minutos;
 *   - returnTo: destino pós-atendimento (fila × pausa);
 *   - isolamento multi-tenant (RN-150-001).
 *
 * Uso:  npm run test:retail-floor-analytics-v2
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-retail-floor-f13-"));
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
  const { RetailFloorShiftService, RetailFloorQueueService } = await import("../src/server/RetailFloorShiftService.js");
  const { RetailFloorAttendanceService } = await import("../src/server/RetailFloorAttendanceService.js");
  const { RetailFloorAnalyticsService, RetailFloorNetworkAnalytics, RetailFloorOpsMetricsService } = await import("../src/server/RetailFloorAnalyticsService.js");

  const A = `org_A_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'A', 'active')`).run(randomUUID(), A);
  ModuleService.applyVertical(A, "moda");
  ModuleService.enableModule(A, "retail_floor");

  const uManager = randomUUID(), uV1 = randomUUID(), uV2 = randomUUID();
  const store1 = randomUUID();
  db.prepare(`INSERT INTO retail_stores (id, organization_id, name, code, manager_user_id) VALUES (?, ?, 'Loja 1005', '1005', ?)`).run(store1, A, uManager);
  const v1 = randomUUID(), v2 = randomUUID();
  db.prepare(`INSERT INTO retail_sellers (id, organization_id, matricula, name, user_id) VALUES (?, ?, 'M-01', 'Ana', ?)`).run(v1, A, uV1);
  db.prepare(`INSERT INTO retail_sellers (id, organization_id, matricula, name, user_id) VALUES (?, ?, 'M-02', 'Bia', ?)`).run(v2, A, uV2);
  const prodX = randomUUID();
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name, price) VALUES (?, ?, 'product', 'Vestido Midi', 150)`).run(prodX, A);

  const manager = { userId: uManager, role: "agent" };
  const sellerU1 = { userId: uV1, role: "agent" };
  const sellerU2 = { userId: uV2, role: "agent" };

  const shift = RetailFloorShiftService.open(A, store1, manager);
  RetailFloorQueueService.join(A, { storeId: store1 }, sellerU1);
  RetailFloorQueueService.join(A, { storeId: store1 }, sellerU2);
  const setJoined = db.prepare(`UPDATE retail_floor_queue_state SET joined_at = ? WHERE organization_id = ? AND shift_id = ? AND seller_id = ?`);
  setJoined.run("2026-08-01 09:00:00", A, shift.id, v1); // Ana 1ª
  setJoined.run("2026-08-01 09:05:00", A, shift.id, v2); // Bia 2ª

  const today = new Date().toISOString().slice(0, 10);
  const setStart = db.prepare(`UPDATE retail_floor_attendances SET started_at = ? WHERE id = ?`);
  const setEnd = db.prepare(`UPDATE retail_floor_attendances SET ended_at = ? WHERE id = ?`);

  // ---- Fluxo real (gera os eventos de audit que o ops mede) ----
  // a1 Ana (a próxima): converte 200/2 peças → confirmada. Volta pra fila.
  const a1 = RetailFloorAttendanceService.start(A, { storeId: store1 }, sellerU1);
  RetailFloorAttendanceService.finish(A, a1.id, { outcome: "converted", declaredValue: 200, declaredPieces: 2 }, sellerU1);
  db.prepare(`UPDATE retail_floor_attendances SET reconciliation_state = 'confirmed' WHERE id = ?`).run(a1.id);

  // a2 Bia FURA a fila (Ana voltou com 1 atendimento; round-robin põe... vamos
  // garantir: quem tem MENOS atendimentos é a Bia? Não — Bia tem 0, Ana 1 →
  // Bia é a próxima. Pra forçar o furo, Ana (1 atendimento) atende na frente
  // com allowSkip do gestor (RN-150-012).
  const a2 = RetailFloorAttendanceService.start(A, { storeId: store1, sellerId: v1, allowSkip: true }, manager);
  RetailFloorAttendanceService.finish(A, a2.id, { outcome: "converted", declaredValue: 100, declaredPieces: 1, returnTo: "break" }, sellerU1);
  // Ana saiu pra pausa via returnTo → fecha a pausa com rejoin depois.

  // a3 Bia: não converteu por preço (com note da Fatia 13-UI).
  const a3 = RetailFloorAttendanceService.start(A, { storeId: store1 }, sellerU2);
  RetailFloorAttendanceService.finish(A, a3.id, { outcome: "not_converted", reason: { category: "price", note: "queria parcelar em 6x" } }, sellerU2);

  // a4 Bia: walkout às 15h.
  const a4 = RetailFloorAttendanceService.start(A, { storeId: store1 }, sellerU2);
  RetailFloorAttendanceService.finish(A, a4.id, { outcome: "walkout" }, sellerU2);

  // a5 Bia: auto-encerrado (unknown) — simula o esquecimento.
  const a5 = RetailFloorAttendanceService.start(A, { storeId: store1 }, sellerU2);
  db.prepare(`UPDATE retail_floor_attendances SET outcome = 'unknown', ended_at = CURRENT_TIMESTAMP WHERE id = ?`).run(a5.id);
  db.prepare(`UPDATE retail_floor_queue_state SET status = 'waiting' WHERE organization_id = ? AND shift_id = ? AND seller_id = ?`).run(A, shift.id, v2);

  // Horas determinísticas (hoje, pra casar com o range e o audit de hoje).
  setStart.run(`${today} 10:00:00`, a1.id); setEnd.run(`${today} 10:20:00`, a1.id);
  setStart.run(`${today} 11:00:00`, a2.id); setEnd.run(`${today} 11:15:00`, a2.id);
  setStart.run(`${today} 14:00:00`, a3.id); setEnd.run(`${today} 14:10:00`, a3.id);
  setStart.run(`${today} 15:00:00`, a4.id); setEnd.run(`${today} 15:05:00`, a4.id);
  setStart.run(`${today} 16:00:00`, a5.id); setEnd.run(`${today} 16:30:00`, a5.id);

  // Scan no a1 (vendido) — pro scanSplit: a1 COM consulta; demais sem.
  db.prepare(`INSERT INTO retail_floor_attendance_scans (id, organization_id, attendance_id, ean, product_id, product_name, action) VALUES (?, ?, ?, '7891000000017', ?, 'Vestido Midi', 'sold')`)
    .run(randomUUID(), A, a1.id, prodX);

  // Ruptura: 2 com produto precificado (150 cada) + 1 EAN fora do catálogo.
  const unmet = db.prepare(`INSERT INTO retail_floor_unmet_demand (id, organization_id, store_id, attendance_id, product_id, ean, reason) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  unmet.run(randomUUID(), A, store1, a3.id, prodX, null, "missing_size");
  unmet.run(randomUUID(), A, store1, a3.id, prodX, null, "missing_color");
  unmet.run(randomUUID(), A, store1, a4.id, null, "7899999999991", "no_assortment");

  // Pausa da Bia com duração conhecida: break → (30min) → rejoin.
  RetailFloorQueueService.setStatus(A, { storeId: store1, sellerId: v2, status: "break" }, sellerU2);
  RetailFloorQueueService.join(A, { storeId: store1 }, sellerU2);
  const fixAudit = db.prepare(`UPDATE auth_audit_logs SET created_at = ? WHERE organization_id = ? AND event_type = ? AND metadata_json LIKE ?`);
  fixAudit.run(`${today} 12:00:00`, A, "RETAIL_FLOOR_QUEUE_STATUS", `%${v2}%break%`);
  fixAudit.run(`${today} 12:30:00`, A, "RETAIL_FLOOR_QUEUE_JOIN", `%${v2}%rejoin%`);
  // Pausa da Ana veio do returnTo='break' do a2 (não é QUEUE_STATUS) — ela
  // continua em pausa: NÃO pode somar minutos (pausa aberta), e o returnTo
  // dela conta no destino pós-atendimento.

  const r = RetailFloorAnalyticsService.store(A, store1, today, today);
  const t = r.totals;

  // ---- Grupo 1 ----
  check("ticket: confirmado = 200 (só a venda confirmada)", t.ticketConfirmed === 200);
  check("ticket: declarado = 150 (média das 2 declaradas)", t.ticketDeclared === 150);
  check("PA: confirmada = 2 peças/venda; declarada = 1.5", t.piecesPerSaleConfirmed === 2 && t.piecesPerSaleDeclared === 1.5);
  check("higiene: unknownCount=1 e unknownPct=20 (1 de 5)", t.unknownCount === 1 && t.unknownPct === 20);
  const h15 = r.byHour.find((h: any) => h.hour === 15);
  check("byHour: walkout aparece na hora certa (15h: 1 de 1)", h15?.count === 1 && h15?.walkouts === 1);
  check("byHour: hora sem walkout zera o campo", r.byHour.find((h: any) => h.hour === 10)?.walkouts === 0);
  const d0 = (r.byDay || []).find((d: any) => d.date === today);
  check("byDay: série do dia com contagens honestas", !!d0 && d0.attendances === 5 && d0.decided === 4 && d0.declared === 2 && d0.confirmed === 1 && d0.walkouts === 1 && d0.unknown === 1);
  check("scanSplit: com consulta 1/1 convertido (100% declarada)", r.scanSplit.withScan.decided === 1 && r.scanSplit.withScan.conversionDeclaredPct === 100);
  check("scanSplit: sem consulta 1/3 declarada (33.3%)", r.scanSplit.withoutScan.decided === 3 && r.scanSplit.withoutScan.conversionDeclaredPct === 33.3);
  check("scanSplit: unknown fora dos denominadores (5 atend., 4 decided)", r.scanSplit.withScan.decided + r.scanSplit.withoutScan.decided === 4);
  check("ruptura em R$: 2×150 precificados + 1 sem preço", r.unmetLostValue.knownValue === 300 && r.unmetLostValue.pricedCount === 2 && r.unmetLostValue.unpricedCount === 1);

  // ---- Rede carrega os novos números ----
  const net = RetailFloorNetworkAnalytics.network(A, today, today);
  const netRow = net.stores.find((s: any) => s.storeId === store1);
  check("rede: ticketConfirmed/unknownPct/unmetLostValue na linha da loja", netRow.ticketConfirmed === 200 && netRow.unknownPct === 20 && netRow.unmetLostValue === 300);

  // ---- Grupo 2 (ops via audit) ----
  const ops = RetailFloorOpsMetricsService.store(A, store1, today, today);
  check("ops: 1 furo de fila autorizado (allowSkip da RN-150-012)", ops.queueSkips.total === 1);
  check("ops: furo atribuído a quem atendeu fora da vez (Ana)", ops.queueSkips.bySeller.length === 1 && ops.queueSkips.bySeller[0].sellerName === "Ana" && ops.queueSkips.bySeller[0].count === 1);
  check("ops: furos por dia", ops.queueSkips.byDay.length === 1 && ops.queueSkips.byDay[0].count === 1);
  const biaP = ops.pauses.find((p: any) => p.sellerName === "Bia");
  check("ops: pausa da Bia pareada (1 pausa, 30 min)", biaP?.breaks === 1 && biaP?.breakMinutes === 30);
  check("ops: pausas em ordem alfabética (não ranking)", ops.pauses.every((p: any, i: number, arr: any[]) => i === 0 || arr[i - 1].sellerName.localeCompare(p.sellerName) <= 0));
  check("ops: returnTo — 4 finishes: 3 fila, 1 pausa", ops.returnTo.waiting === 3 && ops.returnTo.break === 1);

  // ---- Isolamento (RN-150-001) ----
  const B = `org_B_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'B', 'active')`).run(randomUUID(), B);
  const opsB = RetailFloorOpsMetricsService.store(B, store1, today, today);
  check("Isolamento: org B não vê furos/pausas de A", opsB.queueSkips.total === 0 && opsB.pauses.length === 0 && opsB.returnTo.waiting === 0);
  let crossStore = false;
  try { RetailFloorAnalyticsService.store(B, store1, today, today); } catch { crossStore = true; }
  check("Isolamento: org B não lê analytics da loja de A", crossStore);

  console.log("\n=== ADR-150 Fatia 13: Analytics v2 ===");
  for (const r2 of results) console.log(`${r2.ok ? "PASS" : "FAIL"}  ${r2.name}${r2.ok || !r2.detail ? "" : ` — ${r2.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
