/**
 * TEST — Consolidado no snapshot executivo (ADR-186 F2). DB-backed, determinístico.
 * Prova: FinanceSnapshotAdapter.dre ganha bloco `consolidated` (all_channels) AO LADO do resultado
 * core; core (`resultadoOperacional`) INTACTO (0-regressão) + escopo core preservado (ADR-182);
 * partial/doubleCountRisk propagados; honesto sem loja.
 *
 * Uso: npm run test:consolidated-snapshot
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-consolsnap-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-consolsnap-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

const PERIOD = "2026-06";

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { FinanceSnapshotAdapter } = await import("../src/server/FinanceSnapshotAdapter.js");
  const { ManagerialDreService } = await import("../src/server/ManagerialDreService.js");
  const { ConsolidatedResultService } = await import("../src/server/ConsolidatedResultService.js");
  const { FinancialLedgerService } = await import("../src/server/FinancialLedgerService.js");

  const mkOrg = () => { const o = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'O', 'active')`).run(randomUUID(), o); return o; };
  const mkCoreSale = (org: string, line: number, cost: number) => {
    const oid = randomUUID();
    db.prepare(`INSERT INTO orders (id, organization_id, status, total_amount, created_at) VALUES (?, ?, 'pago', ?, '2026-06-10 10:00:00')`).run(oid, org, line);
    db.prepare(`INSERT INTO order_items (id, order_id, organization_id, name_snapshot, unit_price, quantity, line_total, unit_cost) VALUES (?, ?, ?, 'P', ?, 1, ?, ?)`).run(randomUUID(), oid, org, line, line, cost);
  };
  const mkStore = (org: string, margin: number | null) => { const sid = randomUUID(); db.prepare(`INSERT INTO retail_stores (id, organization_id, name, active, gross_margin_percent) VALUES (?, ?, 'Loja', 1, ?)`).run(sid, org, margin); return sid; };
  const mkClosing = (org: string, sid: string, total: number) => db.prepare(`INSERT INTO retail_daily_closings (id, organization_id, store_id, closing_date, status, system_total) VALUES (?, ?, ?, '2026-06-15', 'approved', ?)`).run(randomUUID(), org, sid, total);
  const mkFixed = (org: string, sid: string, cat: string, amt: number) => db.prepare(`INSERT INTO retail_store_fixed_costs (id, organization_id, store_id, category, amount) VALUES (?, ?, ?, ?, ?)`).run(randomUUID(), org, sid, cat, amt);

  // A: core + loja com margem → consolidado presente ao lado do core.
  const A = mkOrg();
  mkCoreSale(A, 1000, 400);
  FinancialLedgerService.addPayable(A, { description: "Compras", amount: 100, dueDate: "2026-06-05", category: "compras" });
  const sA = mkStore(A, 50); mkClosing(A, sA, 2000); mkFixed(A, sA, "aluguel", 300);

  const dre = FinanceSnapshotAdapter.build(A, PERIOD).dre;
  const raw = ManagerialDreService.monthly(A, PERIOD) as any;
  const cr = ConsolidatedResultService.monthly(A, PERIOD);

  check("1.1 bloco consolidated presente (all_channels)", dre.consolidated?.scope === "all_channels");
  check("1.2 consolidado bate com o service", dre.consolidated.resultadoOperacional === cr.consolidated.resultadoOperacional);
  check("1.3 core (resultadoOperacional) INTACTO = DRE (0-regressão)", dre.resultadoOperacional === raw.linhas.resultadoOperacional);
  check("1.4 escopo de receita core preservado (ADR-182)", dre.scope === "core");
  check("1.5 coreResult do bloco = resultado core", dre.consolidated.coreResult === raw.linhas.resultadoOperacional);
  check("1.6 consolidado > core (loja somou)", dre.consolidated.resultadoOperacional > dre.resultadoOperacional);
  check("1.7 não parcial (loja tem margem), sem doubleCount", dre.consolidated.partial === false && dre.consolidated.doubleCountRisk === false);

  // B: loja sem margem → partial propagado.
  const B = mkOrg(); mkCoreSale(B, 500, 200); const sB = mkStore(B, null); mkClosing(B, sB, 3000);
  const dreB = FinanceSnapshotAdapter.build(B, PERIOD).dre;
  check("2.1 partial propagado (loja sem resultado)", dreB.consolidated.partial === true);

  // C: dupla contagem → doubleCountRisk propagado.
  const C = mkOrg(); const sC = mkStore(C, 40); mkClosing(C, sC, 1000); mkFixed(C, sC, "aluguel", 200);
  FinancialLedgerService.addPayable(C, { description: "Aluguel loja", amount: 200, dueDate: "2026-06-05", category: "Aluguel loja 1" });
  const dreC = FinanceSnapshotAdapter.build(C, PERIOD).dre;
  check("3.1 doubleCountRisk propagado + categorias", dreC.consolidated.doubleCountRisk === true && dreC.consolidated.doubleCountCategories.includes("aluguel"));

  // D: sem loja → consolidado = core; snapshot honesto.
  const D = mkOrg(); mkCoreSale(D, 800, 300);
  const dreD = FinanceSnapshotAdapter.build(D, PERIOD).dre;
  check("4.1 sem loja → consolidado = core", dreD.consolidated.resultadoOperacional === dreD.resultadoOperacional && dreD.consolidated.partial === false);

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} consolidated-snapshot: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
