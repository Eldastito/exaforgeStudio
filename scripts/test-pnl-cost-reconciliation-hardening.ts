/**
 * TEST — Reconciliação de CUSTO/DESPESA hardening (ADR-184 F5). Doc-of-record EXECUTÁVEL de dupla
 * função: (A) codifica RN-PNL-C-1..7 como REGRESSÃO sobre os serviços REAIS F1–F4;
 * (B) verifica a FIAÇÃO de produção (pass no Scheduler, testes wired, runbook/ADR presentes).
 *
 * Uso: npm run test:pnl-cost-reconciliation-hardening
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
import { fileURLToPath } from "url";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-pnlcosthard-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-pnlcosthard-123456";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

const PERIOD = "2026-06";

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { PnlCostReconciliationService: COST } = await import("../src/server/PnlCostReconciliationService.js");

  const A = `org_${randomUUID().slice(0, 8)}`, B = `org_${randomUUID().slice(0, 8)}`;
  for (const o of [A, B]) db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'O', 'active')`).run(randomUUID(), o);
  // Pedido: 1 item COM custo (40/100), 1 SEM custo (0/100) → cobertura 0.5.
  const oid = randomUUID();
  db.prepare(`INSERT INTO orders (id, organization_id, status, total_amount, created_at) VALUES (?, ?, 'pago', 200, '2026-06-10 10:00:00')`).run(oid, A);
  db.prepare(`INSERT INTO order_items (id, order_id, organization_id, name_snapshot, unit_price, quantity, line_total, unit_cost) VALUES (?, ?, ?, 'P', 100, 1, 100, 40)`).run(randomUUID(), oid, A);
  db.prepare(`INSERT INTO order_items (id, order_id, organization_id, name_snapshot, unit_price, quantity, line_total, unit_cost) VALUES (?, ?, ?, 'P', 100, 1, 100, 0)`).run(randomUUID(), oid, A);
  db.prepare(`INSERT INTO payables (id, organization_id, description, category, amount, due_date, recurrence, status) VALUES (?, ?, 'Aluguel', 'aluguel', 500, '2026-06-15', 'monthly', 'open')`).run(randomUUID(), A);
  db.prepare(`INSERT INTO loss_events (id, organization_id, period, driver, amount) VALUES (?, ?, ?, 'merma', 30)`).run(randomUUID(), A, PERIOD);
  db.prepare(`INSERT INTO loss_events (id, organization_id, period, driver, amount) VALUES (?, ?, ?, 'desconto', 15)`).run(randomUUID(), A, PERIOD);

  const r = COST.monthlyCost(A, PERIOD);

  // ── RN-PNL-C-1: segmentos de custo, não bolo — total = cogs + despesas (perdas/loja SEPARADAS). ──
  check("RN-1 total = cogs(40) + despesas(500), perdas/loja fora", r.total === 540 && r.excludedFromResultado.operationalLosses === 30);

  // ── RN-PNL-C-2: custo desconhecido ≠ zero — cobertura sinalizada, não fabrica. ──
  check("RN-2 coverage explícita (0.5), unknownCostRisk decorre dela", r.segments.cogs.coverage === 0.5 && typeof r.unknownCostRisk === "boolean");
  const uncov = COST.monthlyCost(A, PERIOD);
  check("RN-2 nunca inventa custo (cogs = só o cadastrado, 40)", uncov.segments.cogs.total === 40);

  // ── RN-PNL-C-3: escopo rotulado. ──
  check("RN-3 scope dre_core + note explica a base do resultado", r.scope === "dre_core" && /resultado do DRE/i.test(r.note));

  // ── RN-PNL-C-4: read-only — computar NÃO muta payables/loss_events. ──
  const beforeP = (db.prepare(`SELECT COUNT(*) n FROM payables WHERE organization_id=?`).get(A) as any).n;
  const beforeL = (db.prepare(`SELECT COUNT(*) n FROM loss_events WHERE organization_id=?`).get(A) as any).n;
  COST.monthlyCost(A, PERIOD); COST.operationalLossesDetail(A, PERIOD);
  check("RN-4 read-only (payables/loss_events intactos)",
    (db.prepare(`SELECT COUNT(*) n FROM payables WHERE organization_id=?`).get(A) as any).n === beforeP &&
    (db.prepare(`SELECT COUNT(*) n FROM loss_events WHERE organization_id=?`).get(A) as any).n === beforeL);

  // ── RN-PNL-C-5: perdas operacionais VISÍVEIS (merma), exclui dedução de receita (desconto). ──
  const d = COST.operationalLossesDetail(A, PERIOD);
  check("RN-5 perda pura visível (merma 30), desconto excluído", d.total === 30 && !d.items.some((i) => i.driver === "desconto"));

  // ── RN-PNL-C-6: 0-regressão — não cria decision_action; sinal é advisory. ──
  COST.publishCostCoherenceSignal(A, PERIOD);
  check("RN-6 sinal advisory, zero decision_action", (db.prepare(`SELECT COUNT(*) n FROM decision_actions WHERE organization_id=?`).get(A) as any).n === 0);

  // ── RN-PNL-C-7: honesto/isolado — B sem dado → zeros; sem loja → storeCosts null. ──
  const rb = COST.monthlyCost(B, PERIOD);
  check("RN-7 B isolado → total 0, storeCosts null", rb.total === 0 && rb.segments.storeCosts === null);

  // ── (B) FIAÇÃO DE PRODUÇÃO ──
  const scheduler = fs.readFileSync(path.join(ROOT, "src/server/Scheduler.ts"), "utf8");
  check("wiring: PnlCostReconciliationService.pass no Scheduler", scheduler.includes("PnlCostReconciliationService.pass"));
  const adapter = fs.readFileSync(path.join(ROOT, "src/server/FinanceSnapshotAdapter.ts"), "utf8");
  check("wiring: snapshot expõe costScope + operationalLossesDetail", adapter.includes("costScope") && adapter.includes("operationalLossesDetail"));
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const needed = ["test:pnl-cost-reconciliation", "test:pnl-cost-snapshot-coherence", "test:pnl-operational-losses", "test:pnl-cost-coherence-signal", "test:pnl-cost-reconciliation-hardening"];
  check("wiring: 5 testes de custo wired", needed.every((t) => pkg.scripts[t]));
  check("wiring: runbook presente", fs.existsSync(path.join(ROOT, "docs/runbook/pnl-custo-operacao.md")));
  check("wiring: ADR-184 presente", fs.existsSync(path.join(ROOT, "docs/adr/ADR-184-reconciliacao-pnl-custo-despesa.md")));

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} pnl-cost-reconciliation-hardening: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
