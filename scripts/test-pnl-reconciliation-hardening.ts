/**
 * TEST — Reconciliação de P&L hardening (ADR-182 F5). Doc-of-record EXECUTÁVEL de dupla função:
 * (A) codifica RN-PNL-1..7 como REGRESSÃO sobre os serviços REAIS F1–F4;
 * (B) verifica a FIAÇÃO de produção (pass no Scheduler, testes wired, runbook/ADR presentes).
 *
 * Uso: npm run test:pnl-reconciliation-hardening
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
import { fileURLToPath } from "url";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-pnlhard-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-pnlhard-123456";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { PnlReconciliationService: PNL } = await import("../src/server/PnlReconciliationService.js");
  const { LossMarginService: LOSS } = await import("../src/server/LossMarginService.js");
  const { FinanceSnapshotAdapter } = await import("../src/server/FinanceSnapshotAdapter.js");
  const { SalesSnapshotAdapter } = await import("../src/server/BusinessSnapshotAdapters.js");

  const PERIOD = "2026-06";
  const A = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical, retail_revenue_bridge) VALUES (?, ?, 'A', 'active', 'moda', 1)`).run(randomUUID(), A);
  const oid = randomUUID();
  db.prepare(`INSERT INTO orders (id, organization_id, status, total_amount, created_at) VALUES (?, ?, 'pago', 1000, '2026-06-10 10:00:00')`).run(oid, A);
  db.prepare(`INSERT INTO order_items (id, order_id, organization_id, name_snapshot, unit_price, quantity, line_total) VALUES (?, ?, ?, 'P', 1000, 1, 1000)`).run(randomUUID(), oid, A);
  db.prepare(`INSERT INTO retail_daily_closings (id, organization_id, store_id, closing_date, status, system_total) VALUES (?, ?, 'loja1', '2026-06-12', 'approved', 500)`).run(randomUUID(), A);

  // ── RN-PNL-1: segmentos, não duplicatas — cada segmento de UMA fonte; total = soma. ──
  const r = PNL.monthlyRevenue(A, PERIOD);
  check("RN-1 segmentos de fontes distintas (core 1000, loja 500)", r.segments.coreOrders === 1000 && r.segments.storeClosings === 500);
  check("RN-1 total = soma dos segmentos (1500)", r.total === r.segments.coreOrders + r.segments.comigo + r.segments.storeClosings);

  // ── RN-PNL-2: sobreposição DETECTADA (não somada em silêncio). ──
  check("RN-2 overlapRisk true (dois rails)", r.overlapRisk === true);
  const sig = PNL.publishOverlapSignal(A, PERIOD);
  check("RN-2 sinal publicado (advisory)", sig.published === true && !!db.prepare(`SELECT 1 FROM business_signals WHERE organization_id=? AND domain='pnl_reconciliation'`).get(A));

  // ── RN-PNL-3: escopo SEMPRE rotulado (core ≠ all_channels). ──
  check("RN-3 dre.scope = core", FinanceSnapshotAdapter.build(A, PERIOD).dre?.scope === "core");
  check("RN-3 sales.scope = all_channels", SalesSnapshotAdapter.build(A, PERIOD).receitaMes?.scope === "all_channels");

  // ── RN-PNL-4: read-only — computar NÃO muta orders/closings. ──
  const beforeO = (db.prepare(`SELECT COUNT(*) n FROM orders WHERE organization_id=?`).get(A) as any).n;
  const beforeC = (db.prepare(`SELECT COUNT(*) n FROM retail_daily_closings WHERE organization_id=?`).get(A) as any).n;
  PNL.monthlyRevenue(A, PERIOD); PNL.monthlyRevenueTotal(A, PERIOD);
  check("RN-4 read-only (orders/closings intactos)",
    (db.prepare(`SELECT COUNT(*) n FROM orders WHERE organization_id=?`).get(A) as any).n === beforeO &&
    (db.prepare(`SELECT COUNT(*) n FROM retail_daily_closings WHERE organization_id=?`).get(A) as any).n === beforeC);

  // ── RN-PNL-5: ponte opt-in — off → segmento de fechamentos 0. ──
  db.prepare(`UPDATE organization_settings SET retail_revenue_bridge = 0 WHERE organization_id=?`).run(A);
  const off = PNL.monthlyRevenue(A, PERIOD);
  check("RN-5 ponte off → storeClosings 0 + overlapRisk false", off.segments.storeClosings === 0 && off.overlapRisk === false);
  db.prepare(`UPDATE organization_settings SET retail_revenue_bridge = 1 WHERE organization_id=?`).run(A);

  // ── RN-PNL-6: 0-regressão numérica — total == LossMargin (fonte legada). ──
  check("RN-6 total == LossMargin.monthlyRevenue (on)", PNL.monthlyRevenueTotal(A, PERIOD) === LOSS.monthlyRevenue(A, PERIOD));

  // ── RN-PNL-7: honesto — período vazio → 0 (não inventa). ──
  const empty = PNL.monthlyRevenue(A, "2019-01");
  check("RN-7 período vazio → 0, overlap false", empty.total === 0 && empty.overlapRisk === false);

  // ── (B) FIAÇÃO DE PRODUÇÃO ──
  const scheduler = fs.readFileSync(path.join(ROOT, "src/server/Scheduler.ts"), "utf8");
  check("wiring: PnlReconciliationService.pass no Scheduler", scheduler.includes("PnlReconciliationService.pass"));
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const needed = ["test:pnl-reconciliation", "test:pnl-delegation", "test:pnl-snapshot-coherence", "test:pnl-overlap-signal", "test:pnl-reconciliation-hardening"];
  check("wiring: 5 testes de P&L wired", needed.every((t) => pkg.scripts[t]));
  check("wiring: runbook presente", fs.existsSync(path.join(ROOT, "docs/runbook/pnl-reconciliacao-operacao.md")));
  check("wiring: ADR-182 presente", fs.existsSync(path.join(ROOT, "docs/adr/ADR-182-reconciliacao-pnl-rails-receita.md")));

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} pnl-reconciliation-hardening: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
