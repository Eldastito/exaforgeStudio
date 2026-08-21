/**
 * TEST — Sinal advisory de sobreposição de P&L (ADR-182 F4). DB-backed, determinístico.
 * Prova: publica business_signal quando overlapRisk (core E loja); hipótese + sem dinheiro;
 * dedupe por período; self-healing (risco some → resolve; recorre → reopen, respeita dismissed);
 * pass só orgs com a ponte ligada; nunca corrige sozinho (nenhuma decision_action).
 *
 * Uso: npm run test:pnl-overlap-signal
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-pnlovl-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-pnlovl-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { PnlReconciliationService: PNL } = await import("../src/server/PnlReconciliationService.js");

  const PERIOD = "2026-06";
  const dedupe = `pnl_overlap:${PERIOD}`;
  const A = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical, retail_revenue_bridge) VALUES (?, ?, 'A', 'active', 'moda', 1)`).run(randomUUID(), A);
  const seedOrder = () => db.prepare(`INSERT INTO orders (id, organization_id, status, total_amount, created_at) VALUES (?, ?, 'pago', 1000, '2026-06-10 10:00:00')`).run(randomUUID(), A);
  const closing = randomUUID();
  const seedClosing = () => db.prepare(`INSERT INTO retail_daily_closings (id, organization_id, store_id, closing_date, status, system_total) VALUES (?, ?, 'loja1', '2026-06-12', 'approved', 500)`).run(closing, A);
  const rowFor = () => db.prepare(`SELECT * FROM business_signals WHERE organization_id = ? AND dedupe_key = ?`).get(A, dedupe) as any;

  // 1. Só core (sem fechamento) → sem overlap → não publica.
  seedOrder();
  const r0 = PNL.publishOverlapSignal(A, PERIOD);
  check("1.1 só core → não publica", r0.published === false && !rowFor());

  // 2. Core + loja → overlapRisk → publica sinal (attention, hipótese, sem dinheiro).
  seedClosing();
  const r1 = PNL.publishOverlapSignal(A, PERIOD);
  check("2.1 publica sinal", r1.published === true);
  const s = rowFor();
  check("2.2 domain/type corretos", s.domain === "pnl_reconciliation" && s.signal_type === "overlap_risk");
  check("2.3 severidade attention", s.severity === "attention");
  check("2.4 hipótese + sem dinheiro (impact null)", s.basis === "hypothesis" && s.impact_amount === null);
  check("2.5 status open", s.status === "open");

  // 3. Dedupe por período: rodar de novo não cria segundo sinal.
  PNL.publishOverlapSignal(A, PERIOD);
  const count = (db.prepare(`SELECT COUNT(*) n FROM business_signals WHERE organization_id = ? AND dedupe_key = ?`).get(A, dedupe) as any).n;
  check("3.1 dedupe: 1 sinal só", Number(count) === 1);

  // 4. Self-healing: some o risco (remove o fechamento) → resolve.
  db.prepare(`DELETE FROM retail_daily_closings WHERE id = ?`).run(closing);
  const r2 = PNL.publishOverlapSignal(A, PERIOD);
  check("4.1 risco sumiu → resolved", r2.resolved === true);
  check("4.2 sinal marcado resolved", rowFor().status === "resolved");

  // 5. Recorrência: volta o fechamento → reabre (reopenByDedupe só reabre auto-resolved).
  seedClosing();
  PNL.publishOverlapSignal(A, PERIOD);
  check("5.1 recorre → reaberto (open)", rowFor().status === "open");

  // 6. §65 — dismissed humano NÃO reabre.
  db.prepare(`UPDATE business_signals SET status='dismissed' WHERE organization_id=? AND dedupe_key=?`).run(A, dedupe);
  PNL.publishOverlapSignal(A, PERIOD);
  check("6.1 dismissed não reabre", rowFor().status === "dismissed");

  // 7. NUNCA corrige sozinho: nenhuma decision_action criada pelo sinal.
  const da = (db.prepare(`SELECT COUNT(*) n FROM decision_actions WHERE organization_id = ?`).get(A) as any).n;
  check("7.1 zero decision_actions (não corrige sozinho)", Number(da) === 0);

  // 8. pass() só toca orgs com a ponte ligada.
  const B = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, retail_revenue_bridge) VALUES (?, ?, 'B', 'active', 0)`).run(randomUUID(), B);
  db.prepare(`INSERT INTO orders (id, organization_id, status, total_amount, created_at) VALUES (?, ?, 'pago', 1000, ?)`).run(randomUUID(), B, new Date().toISOString());
  db.prepare(`INSERT INTO retail_daily_closings (id, organization_id, store_id, closing_date, status, system_total) VALUES (?, ?, 'loja1', ?, 'approved', 500)`).run(randomUUID(), B, new Date().toISOString().slice(0, 10));
  PNL.pass();
  check("8.1 org com ponte OFF não recebe sinal", !(db.prepare(`SELECT 1 FROM business_signals WHERE organization_id = ? AND domain='pnl_reconciliation'`).get(B)));

  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} pnl-overlap-signal: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
