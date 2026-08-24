/**
 * TEST — Resultado consolidado all-channels (ADR-186 F1). DB-backed, determinístico.
 * Prova: consolidated = core + lojas (composição correta); core INTACTO (0-regressão) + escopo
 * rotulado; partial+honesto quando loja material sem resultado computável (não inventa lucro);
 * doubleCountRisk quando custo aparece em payable E custo de loja; sem loja → consolidado = core;
 * isolamento.
 *
 * Uso: npm run test:consolidated-result
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-consol-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-consol-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

const PERIOD = "2026-06";

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { ConsolidatedResultService: CR } = await import("../src/server/ConsolidatedResultService.js");
  const { ManagerialDreService } = await import("../src/server/ManagerialDreService.js");
  const { RetailStoreCostService } = await import("../src/server/RetailStoreCostService.js");
  const { FinancialLedgerService } = await import("../src/server/FinancialLedgerService.js");

  const mkOrg = () => { const o = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'O', 'active')`).run(randomUUID(), o); return o; };
  const mkCoreSale = (org: string, line: number, cost: number) => {
    const oid = randomUUID();
    db.prepare(`INSERT INTO orders (id, organization_id, status, total_amount, created_at) VALUES (?, ?, 'pago', ?, '2026-06-10 10:00:00')`).run(oid, org, line);
    db.prepare(`INSERT INTO order_items (id, order_id, organization_id, name_snapshot, unit_price, quantity, line_total, unit_cost) VALUES (?, ?, ?, 'P', ?, 1, ?, ?)`).run(randomUUID(), oid, org, line, line, cost);
  };
  const mkStore = (org: string, opts: { margin?: number | null } = {}) => {
    const sid = randomUUID();
    db.prepare(`INSERT INTO retail_stores (id, organization_id, name, active, gross_margin_percent) VALUES (?, ?, 'Loja', 1, ?)`).run(sid, org, opts.margin ?? null);
    return sid;
  };
  const mkClosing = (org: string, storeId: string, total: number) =>
    db.prepare(`INSERT INTO retail_daily_closings (id, organization_id, store_id, closing_date, status, system_total) VALUES (?, ?, ?, '2026-06-15', 'approved', ?)`).run(randomUUID(), org, storeId, total);
  const mkFixedCost = (org: string, storeId: string, cat: string, amount: number) =>
    db.prepare(`INSERT INTO retail_store_fixed_costs (id, organization_id, store_id, category, amount) VALUES (?, ?, ?, ?, ?)`).run(randomUUID(), org, storeId, cat, amount);

  // ── A: core (margem 600 − despesa 100 = 500) + loja com margem → consolidado = core + lojas ──
  const A = mkOrg();
  mkCoreSale(A, 1000, 400);                                                        // margemBruta 600
  FinancialLedgerService.addPayable(A, { description: "Compras", amount: 100, dueDate: "2026-06-05", category: "compras" });
  const sA = mkStore(A, { margin: 50 });
  mkClosing(A, sA, 2000);
  mkFixedCost(A, sA, "aluguel", 300);

  const rA = CR.monthly(A, PERIOD);
  const coreDre = ManagerialDreService.monthly(A, PERIOD) as any;
  const storesA = RetailStoreCostService.allStoresResult(A, PERIOD) as any;
  check("1.1 core = resultadoOperacional do DRE (0-regressão, intacto)", rA.core.resultadoOperacional === Math.round((coreDre.linhas.resultadoOperacional + Number.EPSILON) * 100) / 100 && rA.core.scope === "core");
  check("1.2 consolidado = core + resultado das lojas (composição)", rA.consolidated.resultadoOperacional === Math.round((coreDre.linhas.resultadoOperacional + storesA.totals.resultado + Number.EPSILON) * 100) / 100);
  check("1.3 consolidado > core (loja somou resultado)", rA.consolidated.resultadoOperacional > rA.core.resultadoOperacional);
  check("1.4 escopo all_channels + não parcial (loja tem margem)", rA.consolidated.scope === "all_channels" && rA.consolidated.partial === false);
  check("1.5 stores: 1 loja, 1 com resultado", rA.stores.storesTotal === 1 && rA.stores.storesWithResult === 1 && rA.stores.materialMissing === 0);
  check("1.6 doubleCountRisk false (payable 'compras' não bate 'aluguel')", rA.doubleCountRisk === false);

  // ── B: loja com faturamento mas SEM margem/custo → resultado null → PARCIAL (não inventa lucro) ──
  const B = mkOrg();
  mkCoreSale(B, 500, 200);
  const sB = mkStore(B, { margin: null });   // sem margem → resultado null
  mkClosing(B, sB, 3000);                     // tem faturamento
  const rB = CR.monthly(B, PERIOD);
  check("2.1 loja material sem resultado → materialMissing 1", rB.stores.materialMissing === 1 && rB.stores.storesWithResult === 0);
  check("2.2 consolidado PARCIAL (não inventa lucro de loja)", rB.consolidated.partial === true);
  check("2.3 consolidado = core (loja sem resultado não soma)", rB.consolidated.resultadoOperacional === rB.core.resultadoOperacional);
  check("2.4 note avisa parcial", /PARCIAL/.test(rB.note));

  // ── C: dupla contagem — 'aluguel' como custo fixo de loja E como payable ──
  const C = mkOrg();
  const sC = mkStore(C, { margin: 40 });
  mkClosing(C, sC, 1000);
  mkFixedCost(C, sC, "aluguel", 200);
  FinancialLedgerService.addPayable(C, { description: "Aluguel da loja 1", amount: 200, dueDate: "2026-06-05", category: "Aluguel loja 1" });
  const rC = CR.monthly(C, PERIOD);
  check("3.1 doubleCountRisk true (aluguel em payable E custo de loja)", rC.doubleCountRisk === true);
  check("3.2 categoria 'aluguel' listada", rC.doubleCountCategories.includes("aluguel"));
  check("3.3 note avisa dupla contagem", /duas vezes/.test(rC.note));

  // ── D: sem loja → consolidado = core, all_channels, não parcial ──
  const D = mkOrg();
  mkCoreSale(D, 800, 300);
  const rD = CR.monthly(D, PERIOD);
  check("4.1 sem loja → consolidado = core", rD.consolidated.resultadoOperacional === rD.core.resultadoOperacional && rD.stores.storesTotal === 0);
  check("4.2 all_channels, não parcial, sem risco", rD.consolidated.scope === "all_channels" && rD.consolidated.partial === false && rD.doubleCountRisk === false);

  // ── isolamento ──
  check("5.1 orgs isoladas (A não vê loja/despesa de C)", rA.stores.storesTotal === 1 && rA.doubleCountRisk === false);

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} consolidated-result: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
