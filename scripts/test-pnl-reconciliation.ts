/**
 * TEST — PnlReconciliationService (ADR-182 F1). DB-backed, determinístico, isolado.
 * Prova: decompõe a receita por segmento (core/comigo/fechamentos); total = a+b+c (0-regressão
 * vs LossMarginService.monthlyRevenue); ponte off → fechamentos 0; overlapRisk só quando há
 * receita nos DOIS rails; honesto; isolamento.
 *
 * Uso: npm run test:pnl-reconciliation
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-pnlrec-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-pnlrec-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { PnlReconciliationService: PNL } = await import("../src/server/PnlReconciliationService.js");
  const { LossMarginService: LOSS } = await import("../src/server/LossMarginService.js");

  const PERIOD = "2026-06";
  const mkOrg = (name: string) => { const o = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical) VALUES (?, ?, ?, 'active', 'moda')`).run(randomUUID(), o, name); return o; };
  const seedOrder = (o: string, total: number) => db.prepare(`INSERT INTO orders (id, organization_id, status, total_amount, created_at) VALUES (?, ?, 'pago', ?, '2026-06-10 10:00:00')`).run(randomUUID(), o, total);
  const seedComigo = (o: string, total: number) => db.prepare(`INSERT INTO comigo_orders (id, organization_id, status, total, created_at) VALUES (?, ?, 'paid', ?, '2026-06-11 10:00:00')`).run(randomUUID(), o, total);
  const seedClosing = (o: string, sys: number) => db.prepare(`INSERT INTO retail_daily_closings (id, organization_id, store_id, closing_date, status, system_total) VALUES (?, ?, 'loja1', '2026-06-12', 'approved', ?)`).run(randomUUID(), o, sys);
  const setBridge = (o: string, on: boolean) => db.prepare(`UPDATE organization_settings SET retail_revenue_bridge = ? WHERE organization_id = ?`).run(on ? 1 : 0, o);

  // Org A: pedido 1000 + comigo 200 + fechamento 500.
  const A = mkOrg('A');
  seedOrder(A, 1000); seedComigo(A, 200); seedClosing(A, 500);

  // 1. Ponte OFF → só core (1000 + 200 = 1200); fechamentos 0; sem overlap.
  setBridge(A, false);
  const off = PNL.monthlyRevenue(A, PERIOD);
  check("1.1 segmentos: core 1000, comigo 200, fechamentos 0", off.segments.coreOrders === 1000 && off.segments.comigo === 200 && off.segments.storeClosings === 0);
  check("1.2 total 1200", off.total === 1200);
  check("1.3 bridgeEnabled false, overlapRisk false", off.bridgeEnabled === false && off.overlapRisk === false);

  // 2. 0-REGRESSÃO: o total bate com o LossMarginService (fonte legada) com a ponte off.
  check("2.1 total = LossMargin.monthlyRevenue (ponte off)", off.total === LOSS.monthlyRevenue(A, PERIOD));

  // 3. Ponte ON → soma fechamentos (500); total 1700; overlapRisk true (core E loja > 0).
  setBridge(A, true);
  const on = PNL.monthlyRevenue(A, PERIOD);
  check("3.1 fechamentos 500", on.segments.storeClosings === 500);
  check("3.2 total 1700", on.total === 1700);
  check("3.3 bridgeEnabled true", on.bridgeEnabled === true);
  check("3.4 overlapRisk true (receita nos DOIS rails)", on.overlapRisk === true);
  check("3.5 nota avisa da dobra possível", /duas vezes|conte|contada/i.test(on.note));

  // 3b. 0-REGRESSÃO com a ponte ON também.
  check("3.6 total = LossMargin.monthlyRevenue (ponte on)", on.total === LOSS.monthlyRevenue(A, PERIOD));

  // 4. overlapRisk é FALSE quando só existe um rail (loja pura, sem pedidos core).
  const B = mkOrg('B'); seedClosing(B, 800); setBridge(B, true);
  const bOnly = PNL.monthlyRevenue(B, PERIOD);
  check("4.1 loja pura: core 0, fechamentos 800", bOnly.segments.coreOrders === 0 && bOnly.segments.storeClosings === 800);
  check("4.2 overlapRisk false (só um rail)", bOnly.overlapRisk === false);
  check("4.3 total 800", bOnly.total === 800);

  // 4b. Core puro (sem fechamento) → overlapRisk false mesmo com ponte on.
  const C = mkOrg('C'); seedOrder(C, 300); setBridge(C, true);
  check("4.4 core puro → overlapRisk false", PNL.monthlyRevenue(C, PERIOD).overlapRisk === false);

  // 5. monthlyRevenueTotal = total do read-model.
  check("5.1 monthlyRevenueTotal bate com total", PNL.monthlyRevenueTotal(A, PERIOD) === on.total);

  // 6. Isolamento: A não vaza pra B.
  check("6.1 B não tem a receita core de A", PNL.monthlyRevenue(B, PERIOD).segments.coreOrders === 0);

  // 7. Período vazio → tudo 0, honesto.
  const empty = PNL.monthlyRevenue(A, "2020-01");
  check("7.1 período sem dados → total 0, overlap false", empty.total === 0 && empty.overlapRisk === false);

  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} pnl-reconciliation: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
