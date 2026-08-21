/**
 * TEST — PnlCostReconciliationService.monthlyCost (ADR-184 F1). DB-backed, determinístico.
 * Prova: CMV core (unit_cost) + cobertura + unknownCostRisk (custo desconhecido ≠ zero);
 * operatingExpenses fixas×variáveis + byCategory; operationalLosses exclui desconto/devolucao e
 * inclui perdas puras; storeCosts null sem loja e honesto-null sem margem; total = cogs+despesas
 * (perdas/loja NÃO somadas); excludedFromResultado; isolamento; período vazio → zeros.
 *
 * Uso: npm run test:pnl-cost-reconciliation
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-pnlcost-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-pnlcost-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

const PERIOD = "2026-06";

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { PnlCostReconciliationService: COST } = await import("../src/server/PnlCostReconciliationService.js");

  const A = `org_${randomUUID().slice(0, 8)}`, B = `org_${randomUUID().slice(0, 8)}`;
  for (const o of [A, B]) db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'O', 'active')`).run(randomUUID(), o);

  // Pedido pago com 2 itens: um COM custo (unit_cost 40, line 100), um SEM custo (unit_cost 0, line 100).
  const mkOrder = (org: string, items: { price: number; qty: number; cost: number }[]) => {
    const oid = randomUUID();
    const total = items.reduce((a, i) => a + i.price * i.qty, 0);
    db.prepare(`INSERT INTO orders (id, organization_id, status, total_amount, created_at) VALUES (?, ?, 'pago', ?, '2026-06-10 10:00:00')`).run(oid, org, total);
    for (const i of items) db.prepare(`INSERT INTO order_items (id, order_id, organization_id, name_snapshot, unit_price, quantity, line_total, unit_cost) VALUES (?, ?, ?, 'P', ?, ?, ?, ?)`).run(randomUUID(), oid, org, i.price, i.qty, i.price * i.qty, i.cost);
    return oid;
  };
  mkOrder(A, [{ price: 100, qty: 1, cost: 40 }, { price: 100, qty: 1, cost: 0 }]);

  // Despesas: 1 fixa mensal (aluguel 500), 1 fixa weekly (limpeza 80), 1 variável avulsa (marketing 120).
  const mkPayable = (org: string, cat: string, amount: number, rec: string) =>
    db.prepare(`INSERT INTO payables (id, organization_id, description, category, amount, due_date, recurrence, status) VALUES (?, ?, ?, ?, ?, '2026-06-15', ?, 'open')`).run(randomUUID(), org, cat, cat, amount, rec);
  mkPayable(A, "aluguel", 500, "monthly");
  mkPayable(A, "limpeza", 80, "weekly");
  mkPayable(A, "marketing", 120, "none");

  // Perdas: merma 30 + quebra 20 (puras) + desconto 15 + devolucao 10 (dedução de receita → excluir).
  const mkLoss = (org: string, driver: string, amount: number) =>
    db.prepare(`INSERT INTO loss_events (id, organization_id, period, driver, amount) VALUES (?, ?, ?, ?, ?)`).run(randomUUID(), org, PERIOD, driver, amount);
  mkLoss(A, "merma", 30); mkLoss(A, "quebra", 20); mkLoss(A, "desconto", 15); mkLoss(A, "devolucao", 10);

  const r = COST.monthlyCost(A, PERIOD);

  // ── cogs (CMV core) + cobertura + unknownCostRisk ──
  check("1.1 CMV core = unit_cost*qty (40)", r.segments.cogs.core === 40);
  check("1.2 cobertura = receita com custo / total (100/200 = 0.5)", r.segments.cogs.coverage === 0.5);
  check("1.3 unknownCostRisk false em 0.5 (limiar < 0.5)", r.segments.cogs.unknownCostRisk === false);
  check("1.4 cogs.total = core + comigo (40)", r.segments.cogs.total === 40);

  // ── operatingExpenses ──
  check("2.1 fixas = aluguel + limpeza (580)", r.segments.operatingExpenses.fixas === 580);
  check("2.2 variáveis = marketing (120)", r.segments.operatingExpenses.variaveis === 120);
  check("2.3 total despesas = 700", r.segments.operatingExpenses.total === 700);
  check("2.4 byCategory tem aluguel 500 e marketing 120", r.segments.operatingExpenses.byCategory.aluguel === 500 && r.segments.operatingExpenses.byCategory.marketing === 120);

  // ── operationalLosses (exclui desconto/devolucao) ──
  check("3.1 perdas puras = merma + quebra (50)", r.segments.operationalLosses.total === 50);
  check("3.2 exclui desconto/devolucao do byDriver", !("desconto" in r.segments.operationalLosses.byDriver) && !("devolucao" in r.segments.operationalLosses.byDriver));
  check("3.3 byDriver tem merma 30 e quebra 20", r.segments.operationalLosses.byDriver.merma === 30 && r.segments.operationalLosses.byDriver.quebra === 20);

  // ── total = cogs + despesas (perdas/loja NÃO somadas) ──
  check("4.1 total = cogs(40) + despesas(700) = 740", r.total === 740);
  check("4.2 perdas fora do total (excludedFromResultado)", r.excludedFromResultado.operationalLosses === 50);
  check("4.3 scope = dre_core", r.scope === "dre_core");

  // ── storeCosts: null sem loja ──
  check("5.1 storeCosts null sem loja", r.segments.storeCosts === null && r.excludedFromResultado.storeCosts === null);

  // ── unknownCostRisk: pedido só SEM custo → risco true, note avisa ──
  const C = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'O', 'active')`).run(randomUUID(), C);
  mkOrder(C, [{ price: 100, qty: 1, cost: 0 }, { price: 100, qty: 1, cost: 0 }]);
  const rc = COST.monthlyCost(C, PERIOD);
  check("6.1 sem custo cadastrado → coverage 0", rc.segments.cogs.coverage === 0);
  check("6.2 unknownCostRisk true (maioria sem custo)", rc.segments.cogs.unknownCostRisk === true && rc.unknownCostRisk === true);
  check("6.3 note avisa da margem superestimada", /superestimada/.test(rc.note));

  // ── storeCosts populado: loja com custo fixo, sem margem → cogs null (honesto), fixed presente ──
  const D = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'O', 'active')`).run(randomUUID(), D);
  const sid = randomUUID();
  db.prepare(`INSERT INTO retail_stores (id, organization_id, name, active) VALUES (?, ?, 'Loja 1', 1)`).run(sid, D);
  db.prepare(`INSERT INTO retail_store_fixed_costs (id, organization_id, store_id, category, amount) VALUES (?, ?, ?, 'aluguel', 300)`).run(randomUUID(), D, sid);
  const rd = COST.monthlyCost(D, PERIOD);
  check("7.1 storeCosts presente (rail paralelo)", rd.segments.storeCosts !== null);
  check("7.2 storeCosts.fixed = 300", rd.segments.storeCosts?.fixed === 300);
  check("7.3 storeCosts.cogs null sem margem (honesto)", rd.segments.storeCosts?.cogs === null);
  check("7.4 storeCosts NÃO entra no total do DRE", rd.total === 0 && rd.excludedFromResultado.storeCosts !== null);

  // ── isolamento: B não afetado ──
  const rb = COST.monthlyCost(B, PERIOD);
  check("8.1 B isolado (custo zero)", rb.total === 0 && rb.segments.operationalLosses.total === 0);

  // ── honesto: período vazio → zeros, sem risco ──
  const empty = COST.monthlyCost(A, "2019-01");
  check("9.1 período vazio → total 0, sem unknownCostRisk", empty.total === 0 && empty.unknownCostRisk === false);

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} pnl-cost-reconciliation: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
