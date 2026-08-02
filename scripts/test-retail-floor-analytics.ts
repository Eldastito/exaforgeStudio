/**
 * TESTE — ADR-150 Fatia 9: indicadores da loja + modo calibração
 * --------------------------------------------------------------
 * Prova, offline:
 *   - conversão SEMPRE em dois números rotulados: declarada × confirmada
 *     (RN-150-004), denominador excluindo `unknown` (auto-encerrado não é
 *     sucesso nem fracasso);
 *   - TMA derivado de timestamps server-side; valor confirmado soma só os
 *     confirmed;
 *   - quebra por vendedor em ordem ALFABÉTICA (não é ranking — RN-150-006);
 *   - Pareto de perdas dos motivos hierárquicos (nível 1 + product:detalhe);
 *   - top rupturas evidenciadas + atendimentos por hora;
 *   - calibração (RN-150-011): inCalibration/calibrationUntil na resposta;
 *   - filtro de período respeitado; guards de data/loja;
 *   - escopo: rota exige gestor (validado no service da Fatia 1 — aqui o
 *     assert vem da rota; o teste chama o service direto e valida datas);
 *   - isolamento multi-tenant.
 *
 * Uso:  npm run test:retail-floor-analytics
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-retail-floor-f9-"));
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
  const { RetailFloorAnalyticsService } = await import("../src/server/RetailFloorAnalyticsService.js");

  const A = `org_A_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'A', 'active')`).run(randomUUID(), A);
  ModuleService.applyVertical(A, "moda");
  ModuleService.enableModule(A, "retail_floor");

  const store1 = randomUUID();
  db.prepare(`INSERT INTO retail_stores (id, organization_id, name, code) VALUES (?, ?, 'Loja 1005', '1005')`).run(store1, A);
  const vAna = randomUUID(), vBia = randomUUID();
  db.prepare(`INSERT INTO retail_sellers (id, organization_id, matricula, name) VALUES (?, ?, 'M-01', 'Ana')`).run(vAna, A);
  db.prepare(`INSERT INTO retail_sellers (id, organization_id, matricula, name) VALUES (?, ?, 'M-02', 'Bia')`).run(vBia, A);

  const DAY = "2026-08-01";
  const shift = randomUUID();
  const att = db.prepare(
    `INSERT INTO retail_floor_attendances (id, organization_id, store_id, shift_id, seller_id, started_at, ended_at, outcome, outcome_reason_json, reconciliation_state, declared_value)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  // 6 atendimentos no dia:
  //  Ana: confirmado 200 (20min, 10h) + unmatched 150 (30min, 11h) + not_converted product:missing_size (10min, 17h)
  //  Bia: pendente 100 (40min, 17h) + not_converted price (20min, 18h) + unknown (auto-encerrado, 12h) — fora do denominador
  att.run(randomUUID(), A, store1, shift, vAna, `${DAY} 10:00:00`, `${DAY} 10:20:00`, "converted", null, "confirmed", 200);
  att.run(randomUUID(), A, store1, shift, vAna, `${DAY} 11:00:00`, `${DAY} 11:30:00`, "converted", null, "unmatched", 150);
  att.run(randomUUID(), A, store1, shift, vAna, `${DAY} 17:00:00`, `${DAY} 17:10:00`, "not_converted", JSON.stringify({ category: "product", productDetail: { reason: "missing_size", size: "M" } }), null, null);
  att.run(randomUUID(), A, store1, shift, vBia, `${DAY} 17:30:00`, `${DAY} 18:10:00`, "converted", null, "pending", 100);
  att.run(randomUUID(), A, store1, shift, vBia, `${DAY} 18:20:00`, `${DAY} 18:40:00`, "not_converted", JSON.stringify({ category: "price" }), null, null);
  att.run(randomUUID(), A, store1, shift, vBia, `${DAY} 12:00:00`, `${DAY} 13:30:00`, "unknown", null, null, null);
  // Fora do período (dia anterior) — não pode entrar.
  att.run(randomUUID(), A, store1, shift, vAna, `2026-07-31 10:00:00`, `2026-07-31 10:30:00`, "converted", null, "confirmed", 999);
  // Ruptura evidenciada.
  const prod = randomUUID();
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name, price) VALUES (?, ?, 'product', 'Camisa Malha', 129.9)`).run(prod, A);
  db.prepare(`INSERT INTO retail_floor_unmet_demand (id, organization_id, store_id, attendance_id, product_id, reason, detail_json, created_at) VALUES (?, ?, ?, ?, ?, 'missing_size', ?, ?)`)
    .run(randomUUID(), A, store1, "x", prod, JSON.stringify({ size: "M" }), `${DAY} 17:05:00`);

  RetailFloorSettingsService.update(A, { calibrationUntil: "2099-12-31" }, "u1");
  const r = RetailFloorAnalyticsService.store(A, store1, DAY, DAY);

  // ---- 1. conversão em dois números ----
  check("período filtra: 6 atendimentos do dia (o de 31/07 fora)", r.totals.attendances === 6);
  check("denominador exclui unknown: decided=5", r.totals.decided === 5);
  check("declarada 3/5 = 60%", r.totals.conversionDeclaredPct === 60);
  check("confirmada 1/5 = 20% (só o PDV sustentou 1)", r.totals.conversionConfirmedPct === 20);
  check("estados da conciliação: 1 confirmed, 1 unmatched, 1 pending",
    r.totals.confirmedCount === 1 && r.totals.unmatchedCount === 1 && r.totals.pendingCount === 1);
  check("valor confirmado soma SÓ confirmed (200)", r.totals.confirmedValue === 200);
  // TMA: 20+30+10+40+20+90 = 210 / 6 = 35min.
  check("TMA derivado server-side (35min)", r.totals.avgServiceMinutes === 35);

  // ---- 2. por vendedor (alfabético, não ranking) ----
  check("por vendedor: ordem alfabética (Ana, Bia)", r.bySeller[0].sellerName === "Ana" && r.bySeller[1].sellerName === "Bia");
  check("Ana: 3 atend., 2 decl., 1 conf., TMA 20min", r.bySeller[0].attendances === 3 && r.bySeller[0].declared === 2 && r.bySeller[0].confirmed === 1 && r.bySeller[0].avgMinutes === 20);
  check("Bia: 3 atend., 1 decl., 0 conf.", r.bySeller[1].attendances === 3 && r.bySeller[1].declared === 1 && r.bySeller[1].confirmed === 0);

  // ---- 3. Pareto + rupturas + horas ----
  check("Pareto de perdas: product:missing_size e price (1 cada)",
    r.lossPareto.length === 2 && r.lossPareto.some((l: any) => l.reason === "product:missing_size") && r.lossPareto.some((l: any) => l.reason === "price"));
  check("top rupturas: Camisa Malha missing_size", r.topUnmet.length === 1 && r.topUnmet[0].item === "Camisa Malha" && r.topUnmet[0].count === 1);
  const h10 = r.byHour.find((h: any) => h.hour === 10), h17 = r.byHour.find((h: any) => h.hour === 17);
  check("por hora: 10h=1, 17h=2 (pico visível)", h10?.count === 1 && h17?.count === 2);

  // ---- 4. calibração (RN-150-011) ----
  check("calibração vigente na resposta", r.inCalibration === true && r.calibrationUntil === "2099-12-31");
  RetailFloorSettingsService.update(A, { calibrationUntil: "2026-01-01" }, "u1");
  const r2 = RetailFloorAnalyticsService.store(A, store1, DAY, DAY);
  check("calibração expirada: inCalibration=false", r2.inCalibration === false);

  // ---- 5. guards ----
  let badDate = false;
  try { RetailFloorAnalyticsService.store(A, store1, "01/08/2026", DAY); } catch (e: any) { badDate = /YYYY-MM-DD/.test(e.message); }
  check("guard: data inválida rejeitada", badDate);
  let badStore = false;
  try { RetailFloorAnalyticsService.store(A, randomUUID(), DAY, DAY); } catch (e: any) { badStore = /não encontrada/.test(e.message); }
  check("guard: loja inexistente rejeitada", badStore);

  // ---- 6. isolamento ----
  const B = `org_B_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'B', 'active')`).run(randomUUID(), B);
  let cross = false;
  try { RetailFloorAnalyticsService.store(B, store1, DAY, DAY); } catch { cross = true; }
  check("Isolamento: org B não lê indicadores da loja de A", cross);

  console.log("\n=== ADR-150 Fatia 9: indicadores + calibração ===");
  for (const r2 of results) console.log(`${r2.ok ? "PASS" : "FAIL"}  ${r2.name}${r2.ok || !r2.detail ? "" : ` — ${r2.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
