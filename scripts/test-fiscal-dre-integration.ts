/**
 * TEST — Projeção CBS/IBS na DRE gerencial (ADR-181 F7). DB-backed, determinístico, isolado.
 * Prova: read-only (NÃO altera o sobra da DRE → sem dupla contagem estrutural); honesto sem
 * regime; Simples → informative_embedded + aviso de dupla contagem com tax_sale; regime regular
 * → operating_expense; alíquota não curada → amount null; isolamento.
 *
 * Uso: npm run test:fiscal-dre-integration
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-fdre-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-fdre-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { FiscalProfileService: FP } = await import("../src/server/FiscalProfileService.js");
  const { TaxReferenceService: TAX } = await import("../src/server/TaxReferenceService.js");
  const { ManagerialDreService: DRE } = await import("../src/server/ManagerialDreService.js");
  const { FiscalDreProjectionService: PROJ } = await import("../src/server/FiscalDreProjectionService.js");

  const A = `org_${randomUUID().slice(0, 8)}`, B = `org_${randomUUID().slice(0, 8)}`;
  for (const o of [A, B]) db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical) VALUES (?, ?, 'Org', 'active', 'moda')`).run(randomUUID(), o);

  // Semeia R$1000 de receita no período 2026-06 (order pago + item).
  const PERIOD = "2026-06";
  const seedRevenue = (org: string, total: number) => {
    const oid = randomUUID();
    db.prepare(`INSERT INTO orders (id, organization_id, status, total_amount, created_at) VALUES (?, ?, 'pago', ?, '2026-06-10 12:00:00')`).run(oid, org, total);
    db.prepare(`INSERT INTO order_items (id, order_id, organization_id, name_snapshot, unit_price, quantity, line_total) VALUES (?, ?, ?, 'Produto', ?, 1, ?)`).run(randomUUID(), oid, org, total, total);
  };
  seedRevenue(A, 1000);

  // Cura a fase-teste 2026.
  TAX.curate({ tribute: "cbs", phase: "teste_2026", ratePercent: 0.9, reviewedBy: "aud", effectiveFrom: "2026-01-01", effectiveTo: "2026-12-31" }, "m");
  TAX.curate({ tribute: "ibs", phase: "teste_2026", ratePercent: 0.1, reviewedBy: "aud", effectiveFrom: "2026-01-01", effectiveTo: "2026-12-31" }, "m");

  // 0. Sem regime → projeção indisponível (honesto).
  const p0 = PROJ.project(A, PERIOD);
  check("0.1 sem regime → indisponível", p0.available === false && p0.reason === "profile_incomplete");
  check("0.2 amounts null (não inventa)", p0.taxes.cbs.amount === null && p0.totalTax === null);

  // 1. Simples → projeta sobre a receita líquida (1000): CBS 9, IBS 1; informative_embedded.
  FP.save(A, { regime: "simples" }, "u");
  const p1 = PROJ.project(A, PERIOD);
  check("1.1 base = receita líquida 1000", p1.baseReceitaLiquida === 1000);
  check("1.2 CBS 0,9% = 9,00", p1.taxes.cbs.amount === 9);
  check("1.3 IBS 0,1% = 1,00", p1.taxes.ibs.amount === 1);
  check("1.4 total 10,00", p1.totalTax === 10);
  check("1.5 Simples → informative_embedded", p1.treatment === "informative_embedded" && p1.collectionMode === "das_embedded");

  // 2. SEM DUPLA CONTAGEM: a DRE (sobra) NÃO muda com a projeção (read-only, fora do bottom line).
  const dreBefore = DRE.monthly(A, PERIOD).linhas.sobra;
  PROJ.project(A, PERIOD); // roda a projeção
  const dreAfter = DRE.monthly(A, PERIOD).linhas.sobra;
  check("2.1 projeção NÃO altera o sobra da DRE", dreBefore === dreAfter);

  // 3. Aviso de dupla contagem quando a org usa tax_sale (imposto de venda como custo variável).
  check("3.1 sem tax_sale → usesTaxSaleCost false", PROJ.project(A, PERIOD).doubleCount.usesTaxSaleCost === false);
  db.prepare(`INSERT INTO retail_store_variable_costs (id, organization_id, store_id, category, percent) VALUES (?, ?, 'loja1', 'tax_sale', 4.0)`).run(randomUUID(), A);
  const p3 = PROJ.project(A, PERIOD);
  check("3.2 com tax_sale → usesTaxSaleCost true + aviso de não somar", p3.doubleCount.usesTaxSaleCost === true && /MESMO ônus|NÃO some/i.test(p3.doubleCount.note || ""));

  // 4. Regime regular → operating_expense (recolhe por fora).
  FP.save(A, { regime: "presumido" }, "u");
  const p4 = PROJ.project(A, PERIOD);
  check("4.1 Presumido → operating_expense/separate", p4.treatment === "operating_expense" && p4.collectionMode === "separate");

  // 5. Alíquota não curada (fora da vigência) → amount null (RN-FISCAL-1).
  const p5 = PROJ.project(A, "2025-06");
  check("5.1 período sem alíquota → cbs amount null (partial)", p5.taxes.cbs.amount === null && p5.partial === true);

  // 6. Isolamento: B (sem receita, sem regime) → indisponível, base 0.
  const pB = PROJ.project(B, PERIOD);
  check("6.1 B isolado (sem regime → indisponível)", pB.available === false && pB.baseReceitaLiquida === 0);

  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} fiscal-dre-integration: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
