/**
 * TESTE — "Comissão total do período" espelha a CORRIDA (COMM-SRC-001).
 *
 * Pedido da dona: o bloco "Comissão total do período" deve seguir os percentuais
 * do "Configurar a corrida" (não as Regras de comissão separadas). Prova:
 *  - flag default = 'rules' (0-regressão);
 *  - setReportSource(true) → 'race';
 *  - reportView(mês) ESPELHA a apuração da corrida: totals idênticos ao
 *    raceMonth (grand/sellers/managers) e soma das linhas = grand;
 *  - vendedores E gerentes viram linhas; produto/loja não entram (corrida);
 *  - isolamento multi-tenant.
 *
 * Uso:  npm run test:retail-commission-report-source
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-commsrc-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-commsrc-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }
const near = (a: any, b: number) => Math.abs(Number(a) - b) < 0.02;

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { RetailStoreService } = await import("../src/server/RetailStoreService.js");
  const { RetailCommissionService: C } = await import("../src/server/RetailCommissionService.js");
  const { RetailCommissionRaceService: Race } = await import("../src/server/RetailCommissionRaceService.js");

  const A = `org_A_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), A);
  const mgr = randomUUID();
  db.prepare(`INSERT INTO users (id, organization_id, name, email, role) VALUES (?, ?, 'Gerente Ana', ?, 'admin')`).run(mgr, A, `mgr_${mgr.slice(0, 6)}@x.com`);
  const store = RetailStoreService.create(A, { name: "Av Brasil", code: "1" }).id;
  db.prepare(`UPDATE retail_stores SET manager_user_id = ? WHERE id = ?`).run(mgr, store);

  // Venda da loja no mês (fechamento) → base do gerente (1% min:0 da corrida).
  db.prepare(`INSERT INTO retail_daily_closings (id, organization_id, store_id, closing_date, status, informed_total, quota_amount) VALUES (?, ?, ?, '2026-09-10', 'approved', 5000, 4000)`).run(randomUUID(), A, store);
  // Venda por vendedor (folha manual) → linha do vendedor na corrida.
  db.prepare(`INSERT INTO retail_seller_sales (id, organization_id, store_id, sale_date, seller_name, matricula, valor, pecas) VALUES (?, ?, ?, '2026-09-10', 'Bruno', '20', 3000, 10)`).run(randomUUID(), A, store);

  const month = "2026-09";
  const race = Race.raceMonth(A, month);

  // ===== 1. flag default = rules (0-regressão) =====
  check("1.1 fonte default = rules", C.reportSource(A) === "rules");

  // ===== 2. toggle =====
  check("2.1 setReportSource(true) → race", C.setReportSource(A, true) === "race" && C.reportSource(A) === "race");

  // ===== 3. reportView ESPELHA a corrida =====
  const rv = Race.reportView(A, month);
  check("3.1 mode = 'race'", rv.mode === "race" && rv.raceMonth === month);
  check("3.2 totalCommission = grand da corrida", near(rv.totals.totalCommission, race.totals.grand), `${rv.totals.totalCommission} vs ${race.totals.grand}`);
  check("3.3 sellerCommission = sellers da corrida", near(rv.totals.sellerCommission, race.totals.sellers), `${rv.totals.sellerCommission} vs ${race.totals.sellers}`);
  check("3.4 managerCommission = managers da corrida", near(rv.totals.managerCommission, race.totals.managers), `${rv.totals.managerCommission} vs ${race.totals.managers}`);
  const somaLinhas = rv.bySeller.reduce((a: number, s: any) => a + Number(s.commission || 0), 0);
  check("3.5 soma das linhas = grand (nada perdido/duplicado)", near(somaLinhas, race.totals.grand), `${somaLinhas} vs ${race.totals.grand}`);

  // ===== 4. gerente 1% (min:0) entra sem cota → grand > 0 e há linha de gerente =====
  check("4.1 grand > 0 (gerente 1% da loja)", race.totals.grand > 0, String(race.totals.grand));
  check("4.2 há linha de gerente", rv.bySeller.some((s: any) => s.source === "gerente" && s.commission > 0), JSON.stringify(rv.bySeller.map((s: any) => [s.source, s.commission])));
  check("4.3 há linha do vendedor Bruno", rv.bySeller.some((s: any) => s.sellerName === "Bruno"));

  // ===== 5. produto/loja não entram (corrida) =====
  check("5.1 byProduct e byStore vazios no modo corrida", rv.byProduct.length === 0 && rv.byStore.length === 0);

  // ===== 6. voltar pra rules =====
  check("6.1 setReportSource(false) → rules", C.setReportSource(A, false) === "rules");
  const rep = C.report(A, "2026-09-01", "2026-09-30");
  check("6.2 report() clássico não tem mode='race'", rep.mode !== "race");

  // ===== 7. isolamento =====
  const B = `org_B_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Y', 'active')`).run(randomUUID(), B);
  check("7.1 org B fonte default rules (não herda A)", C.reportSource(B) === "rules");
  check("7.2 reportView de B não vê Bruno de A", !Race.reportView(B, month).bySeller.some((s: any) => s.sellerName === "Bruno"));

  console.log("\n=== TEST: Comissão total do período espelha a Corrida ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
