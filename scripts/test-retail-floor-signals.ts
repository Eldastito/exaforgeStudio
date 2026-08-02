/**
 * TESTE — ADR-150 Fatia 8: sinais do Atendimento de Loja pro Orquestrador
 * -----------------------------------------------------------------------
 * Prova, offline (tudo FATO CALCULADO — RN-150-006):
 *   - queue_delay: minutos com o roster inteiro em atendimento simultâneo
 *     (sweep line sobre os intervalos) ≥ 15min publica; abaixo não;
 *   - long_service: atendimentos ≥ 45min com evidência (vendedor + minutos);
 *   - unmet_demand: ruptura do dia agrupada (sem o no_assortment);
 *   - out_of_assortment: EANs fora do mix em sinal separado;
 *   - declared_vs_pdv_gap: unmatched ≥ 1 com valor declarado como impacto;
 *   - network_recovery: reserva/transferência em peça sem estoque local;
 *   - conversion_drop: só com amostra mínima (20+20) e queda ≥ 20% da
 *     conversão CONFIRMADA — nunca a bruta declarada;
 *   - dedupe do ledger: re-sweep ATUALIZA (mesma linha), não duplica;
 *   - loja sem turno no dia não gera sinal; isolamento multi-tenant.
 *
 * Uso:  npm run test:retail-floor-signals
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-retail-floor-f8-"));
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
  const { RetailFloorSignalPublisher } = await import("../src/server/RetailFloorSignalPublisher.js");
  const { BusinessSignalService } = await import("../src/server/BusinessSignalService.js");

  const A = `org_A_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'A', 'active')`).run(randomUUID(), A);
  ModuleService.applyVertical(A, "moda");
  ModuleService.enableModule(A, "retail_floor");

  const store1 = randomUUID(), storeIdle = randomUUID();
  db.prepare(`INSERT INTO retail_stores (id, organization_id, name, code) VALUES (?, ?, 'Loja 1005', '1005')`).run(store1, A);
  db.prepare(`INSERT INTO retail_stores (id, organization_id, name, code) VALUES (?, ?, 'Loja Parada', '1009')`).run(storeIdle, A);
  const vAna = randomUUID(), vBia = randomUUID();
  db.prepare(`INSERT INTO retail_sellers (id, organization_id, matricula, name) VALUES (?, ?, 'M-01', 'Ana')`).run(vAna, A);
  db.prepare(`INSERT INTO retail_sellers (id, organization_id, matricula, name) VALUES (?, ?, 'M-02', 'Bia')`).run(vBia, A);

  const DAY = "2026-08-01";
  const shift = randomUUID();
  db.prepare(`INSERT INTO retail_floor_shifts (id, organization_id, store_id, status, opened_at) VALUES (?, ?, ?, 'closed', ?)`).run(shift, A, store1, `${DAY} 09:00:00`);
  db.prepare(`INSERT INTO retail_floor_queue_state (id, organization_id, shift_id, seller_id, status) VALUES (?, ?, ?, ?, 'offline')`).run(randomUUID(), A, shift, vAna);
  db.prepare(`INSERT INTO retail_floor_queue_state (id, organization_id, shift_id, seller_id, status) VALUES (?, ?, ?, ?, 'offline')`).run(randomUUID(), A, shift, vBia);

  const att = db.prepare(
    `INSERT INTO retail_floor_attendances (id, organization_id, store_id, shift_id, seller_id, started_at, ended_at, outcome, reconciliation_state, declared_value)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  // queue_delay: Ana 10:00–10:50 e Bia 10:10–10:40 → roster inteiro (2) ocupado 10:10–10:40 = 30min.
  // long_service: o da Ana dura 50min (≥45).
  const a1 = randomUUID(), a2 = randomUUID();
  att.run(a1, A, store1, shift, vAna, `${DAY} 10:00:00`, `${DAY} 10:50:00`, "converted", "unmatched", 199.9);
  att.run(a2, A, store1, shift, vBia, `${DAY} 10:10:00`, `${DAY} 10:40:00`, "not_converted", null, null);

  // Demanda: 2 missing_size do mesmo produto + 1 no_assortment (fora do mix).
  const prod = randomUUID();
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name, price) VALUES (?, ?, 'product', 'Camisa Malha', 129.9)`).run(prod, A);
  const unmet = db.prepare(`INSERT INTO retail_floor_unmet_demand (id, organization_id, store_id, attendance_id, product_id, ean, reason, detail_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  unmet.run(randomUUID(), A, store1, a2, prod, null, "missing_size", JSON.stringify({ size: "M" }), `${DAY} 10:20:00`);
  unmet.run(randomUUID(), A, store1, a1, prod, null, "missing_size", JSON.stringify({ size: "G" }), `${DAY} 10:30:00`);
  unmet.run(randomUUID(), A, store1, a2, null, "7891000000001", "no_assortment", null, `${DAY} 10:35:00`);

  // network_recovery: scan com transferência em peça sem estoque local.
  db.prepare(
    `INSERT INTO retail_floor_attendance_scans (id, organization_id, attendance_id, ean, product_id, product_name, local_stock, network_stock, action, created_at)
     VALUES (?, ?, ?, '7891000000002', ?, 'Camisa Malha', 0, 4, 'transfer_requested', ?)`
  ).run(randomUUID(), A, a1, prod, `${DAY} 10:25:00`);

  // ---- 1. sweep publica os sinais do dia ----
  const r1 = RetailFloorSignalPublisher.sweep(A, DAY);
  const signals = () => BusinessSignalService.list(A, { domain: "retail_floor" });
  const byType = (t: string) => signals().find((s: any) => s.signal_type === t);

  check("sweep publica 6 sinais do dia (delay, long, unmet, assortment, gap, recovery — sem drop)", r1.published === 6, `published=${r1.published}`);
  const qd = byType("retail_floor_queue_delay");
  check("queue_delay: 30min de roster inteiro ocupado (≥15) publica", !!qd && qd.evidence.allBusyMinutes === 30 && qd.evidence.rosterSize === 2);
  const ls = byType("retail_floor_long_service");
  check("long_service: atendimento de 50min com evidência (Ana)", !!ls && ls.evidence.items.length === 1 && ls.evidence.items[0].seller === "Ana" && ls.evidence.items[0].minutes === 50);
  const ud = byType("retail_floor_unmet_demand");
  check("unmet_demand: 2 missing_size agrupados no produto (sem o no_assortment)",
    !!ud && Number(ud.impact_amount) === 2 && ud.evidence.items[0].item === "Camisa Malha" && ud.evidence.items[0].count === 2);
  const oa = byType("retail_floor_out_of_assortment");
  check("out_of_assortment: EAN fora do mix em sinal separado", !!oa && oa.evidence.eans[0].ean === "7891000000001");
  const gap = byType("retail_floor_declared_vs_pdv_gap");
  check("declared_vs_pdv_gap: 1 unmatched com valor declarado como impacto", !!gap && Number(gap.impact_amount) === 199.9 && gap.evidence.unmatchedCount === 1);
  const nr = byType("retail_floor_network_recovery");
  check("network_recovery: transferência em peça sem estoque local", !!nr && Number(nr.impact_amount) === 1 && nr.evidence.items[0].action === "transfer_requested");
  check("conversion_drop NÃO publica sem amostra mínima", !byType("retail_floor_conversion_drop"));

  // ---- 2. dedupe: re-sweep atualiza, não duplica ----
  const before = signals().length;
  RetailFloorSignalPublisher.sweep(A, DAY);
  check("re-sweep não duplica (dedupe do ledger)", signals().length === before);

  // ---- 3. conversion_drop com amostra ----
  // Janelas de 7d terminando em 2026-08-01: atual = 26/07..01/08; anterior =
  // 19/07..25/07. Anterior: 24 atendimentos, 12 confirmados (50%). Atual: 24
  // + os 2 da parte 1 = 26, 6 confirmados (~23%) → queda ≥ 20% relativa.
  const mk = (dateStr: string, n: number, confirmed: number, seed: string) => {
    for (let i = 0; i < n; i++) {
      const conv = i < confirmed;
      att.run(`${seed}-${dateStr}-${i}`, A, store1, shift, i % 2 ? vAna : vBia, `${dateStr} 1${i % 8}:0${i % 6}:00`, `${dateStr} 1${i % 8}:2${i % 6}:00`,
        conv ? "converted" : "not_converted", conv ? "confirmed" : null, conv ? 100 : null);
    }
  };
  for (const d of ["2026-07-20", "2026-07-21", "2026-07-22"]) mk(d, 8, 4, "prev");   // anterior: 24, 12 conf
  for (const d of ["2026-07-30", "2026-07-31", "2026-08-01"]) mk(d, 8, 2, "cur");    // atual: 24, 6 conf
  RetailFloorSignalPublisher.sweep(A, DAY);
  const drop = byType("retail_floor_conversion_drop");
  check("conversion_drop publica com amostra 20+ e queda ≥20% (confirmada, não bruta)",
    !!drop && drop.evidence.previous.total >= 20 && drop.evidence.current.total >= 20 &&
    drop.evidence.previous.rate > drop.evidence.current.rate);

  // ---- 4. loja sem turno no dia não gera sinal ----
  check("loja sem turno no dia não gera sinal", signals().every((s: any) => s.source_entity_id !== storeIdle));

  // ---- 5. isolamento ----
  const B = `org_B_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'B', 'active')`).run(randomUUID(), B);
  const rB = RetailFloorSignalPublisher.sweep(B, DAY);
  check("Isolamento: sweep de B não publica nada (sem turnos)", rB.published === 0 && BusinessSignalService.list(B, { domain: "retail_floor" }).length === 0);

  console.log("\n=== ADR-150 Fatia 8: sinais pro Orquestrador ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
