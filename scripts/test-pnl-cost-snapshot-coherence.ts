/**
 * TEST — Coerência de CUSTO no snapshot executivo (ADR-184 F2). DB-backed, determinístico.
 * Prova: FinanceSnapshotAdapter.dre ganha costScope/cmvCoverage/unknownCostRisk/excludedFromResultado
 * + costScopeNote (derivados do read-model reconciliado); 0-regressão nas linhas do DRE + no
 * scope/scopeNote de receita (ADR-182 F3); honesto sem dado.
 *
 * Uso: npm run test:pnl-cost-snapshot-coherence
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-pnlcostsnap-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-pnlcostsnap-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

const PERIOD = "2026-06";

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { FinanceSnapshotAdapter } = await import("../src/server/FinanceSnapshotAdapter.js");
  const { ManagerialDreService } = await import("../src/server/ManagerialDreService.js");

  const A = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'O', 'active')`).run(randomUUID(), A);

  // Pedido pago: 1 item COM custo, 1 SEM custo → cobertura 0.5.
  const oid = randomUUID();
  db.prepare(`INSERT INTO orders (id, organization_id, status, total_amount, created_at) VALUES (?, ?, 'pago', 200, '2026-06-10 10:00:00')`).run(oid, A);
  db.prepare(`INSERT INTO order_items (id, order_id, organization_id, name_snapshot, unit_price, quantity, line_total, unit_cost) VALUES (?, ?, ?, 'P', 100, 1, 100, 40)`).run(randomUUID(), oid, A);
  db.prepare(`INSERT INTO order_items (id, order_id, organization_id, name_snapshot, unit_price, quantity, line_total, unit_cost) VALUES (?, ?, ?, 'P', 100, 1, 100, 0)`).run(randomUUID(), oid, A);
  // Despesa + perda operacional (fora do resultado).
  db.prepare(`INSERT INTO payables (id, organization_id, description, category, amount, due_date, recurrence, status) VALUES (?, ?, 'Aluguel', 'aluguel', 500, '2026-06-15', 'monthly', 'open')`).run(randomUUID(), A);
  db.prepare(`INSERT INTO loss_events (id, organization_id, period, driver, amount) VALUES (?, ?, ?, 'merma', 30)`).run(randomUUID(), A, PERIOD);

  const snap = FinanceSnapshotAdapter.build(A, PERIOD);
  const dre = snap.dre;

  // ── F2 adiciona os campos de coerência de custo ──
  check("1.1 costScope = dre_core", dre.costScope === "dre_core");
  check("1.2 cmvCoverage = 0.5 (metade da receita com custo)", dre.cmvCoverage === 0.5);
  check("1.3 unknownCostRisk false em 0.5", dre.unknownCostRisk === false);
  check("1.4 excludedFromResultado carrega perdas (30)", dre.excludedFromResultado?.operationalLosses === 30);
  check("1.5 costScopeNote presente e cita a base do resultado", typeof dre.costScopeNote === "string" && /margem dos canais core/.test(dre.costScopeNote));

  // ── 0-regressão: linhas do DRE + escopo de receita (ADR-182 F3) intactos ──
  const raw = ManagerialDreService.monthly(A, PERIOD);
  check("2.1 linhas do DRE inalteradas (receitaLiquida)", dre.receitaLiquida === raw.linhas.receitaLiquida);
  check("2.2 cmv do DRE inalterado", dre.cmv === raw.linhas.cmv);
  check("2.3 scope de receita segue 'core' (ADR-182)", dre.scope === "core");
  check("2.4 scopeNote de receita intacto", /all_channels/.test(dre.scopeNote));

  // ── unknownCostRisk TRUE quando a maioria não tem custo ──
  const C = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'O', 'active')`).run(randomUUID(), C);
  const oc = randomUUID();
  db.prepare(`INSERT INTO orders (id, organization_id, status, total_amount, created_at) VALUES (?, ?, 'pago', 200, '2026-06-10 10:00:00')`).run(oc, C);
  db.prepare(`INSERT INTO order_items (id, order_id, organization_id, name_snapshot, unit_price, quantity, line_total, unit_cost) VALUES (?, ?, ?, 'P', 200, 1, 200, 0)`).run(randomUUID(), oc, C);
  const dc = FinanceSnapshotAdapter.build(C, PERIOD).dre;
  check("3.1 unknownCostRisk true (nada com custo)", dc.unknownCostRisk === true);
  check("3.2 costScopeNote avisa que margem/lucro não são fato", /NÃO podem ser afirmados como fato/.test(dc.costScopeNote));

  // ── honesto: org sem movimento → campos existem, sem risco ──
  const E = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'O', 'active')`).run(randomUUID(), E);
  const de = FinanceSnapshotAdapter.build(E, "2019-01").dre;
  check("4.1 sem movimento → costScope presente, unknownCostRisk false", de.costScope === "dre_core" && de.unknownCostRisk === false);

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} pnl-cost-snapshot-coherence: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
