/**
 * TESTE — Retail Ops Fase G: premiação/comissão (ADR-083)
 * ------------------------------------------------------
 * Prova, offline, o motor de premiação e a guarda de aprovação humana:
 *   - os 4 tipos de cálculo (percent_sales, fixed, quota_bonus, tiered);
 *   - a apuração (run) gera prévia por loja a partir dos fechamentos do período;
 *   - comparação com a premiação informada → divergências;
 *   - regra global agrega todas as lojas;
 *   - aprovação SEMPRE humana (draft → approved); isolamento por org.
 *
 * Uso:  npm run test:retail-commission
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-retail-g-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-retail-g-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { RetailStoreService } = await import("../src/server/RetailStoreService.js");
  const { RetailQuotaService } = await import("../src/server/RetailOpsService.js");
  const { RetailCommissionService, computeCommission } = await import("../src/server/RetailCommissionService.js");

  // ---- 1. computeCommission (os 4 tipos) ----
  check("percent_sales: 5% de 10000 = 500", computeCommission("percent_sales", { percent: 5 }, 10000, 8000).amount === 500);
  check("fixed: valor fixo", computeCommission("fixed", { amount: 300 }, 10000, 8000).amount === 300);
  check("quota_bonus: bate a cota → bônus", computeCommission("quota_bonus", { bonus: 500 }, 10000, 8000).amount === 500);
  check("quota_bonus: não bate → 0", computeCommission("quota_bonus", { bonus: 500 }, 5000, 8000).amount === 0);
  check("tiered: escolhe a faixa certa", computeCommission("tiered", { tiers: [{ min: 0, percent: 1 }, { min: 8000, percent: 3 }] }, 10000, 0).amount === 300);

  // ---- 2. Apuração por loja ----
  const A = `org_A_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'A', 'active')`).run(randomUUID(), A);
  const s1 = RetailStoreService.create(A, { name: "Loja 1" });
  const s2 = RetailStoreService.create(A, { name: "Loja 2" });
  const START = "2026-07-01", END = "2026-07-31";
  // fechamentos do período (realizado)
  const closing = (store: string, date: string, total: number) =>
    db.prepare(`INSERT INTO retail_daily_closings (id, organization_id, store_id, closing_date, status, informed_total) VALUES (?, ?, ?, ?, 'approved', ?)`).run(randomUUID(), A, store, date, total);
  closing(s1.id, "2026-07-05", 6000); closing(s1.id, "2026-07-15", 4000); // s1 = 10000
  closing(s2.id, "2026-07-05", 5000);                                     // s2 = 5000
  RetailQuotaService.set(A, { storeId: s1.id, quotaDate: "2026-07-05", quotaAmount: 8000 });

  const rule = RetailCommissionService.createRule(A, { name: "5% das vendas", scope: "store", calculationType: "percent_sales", config: { percent: 5 } }, "u1");
  const run = RetailCommissionService.createRun(A, START, END, "u1");
  check("Run nasce 'draft'", run.status === "draft");
  const it1 = run.items.find((i: any) => i.store_id === s1.id);
  const it2 = run.items.find((i: any) => i.store_id === s2.id);
  check("Comissão da Loja 1 = 5% de 10000 = 500", it1.base_amount === 10000 && it1.commission_amount === 500);
  check("Comissão da Loja 2 = 5% de 5000 = 250", it2.base_amount === 5000 && it2.commission_amount === 250);
  check("total_sales e total_commission agregam", run.total_sales === 15000 && run.total_commission === 750);

  // ---- 3. Comparação com a premiação informada → divergência ----
  const cmp = RetailCommissionService.compare(A, run.id, [{ storeId: s1.id, amount: 500 }, { storeId: s2.id, amount: 200 }], "u1");
  check("Detecta divergência (Loja 2: 250 calc vs 200 informado)", cmp.divergence_count === 1 && cmp.items.find((i: any) => i.store_id === s2.id).status === "divergent");

  // ---- 4. Aprovação humana ----
  const appr = RetailCommissionService.setStatus(A, run.id, "approved", "gestor");
  check("Aprovação humana → 'approved' com aprovador", appr.status === "approved" && appr.approved_by === "gestor");

  // ---- 5. Regra global agrega todas as lojas ----
  RetailCommissionService.setRuleActive(A, rule.id, false); // desliga a de loja
  RetailCommissionService.createRule(A, { name: "1% global", scope: "global", calculationType: "percent_sales", config: { percent: 1 } }, "u1");
  const runG = RetailCommissionService.createRun(A, START, END, "u1");
  check("Regra global gera 1 item agregando as lojas (1% de 15000 = 150)", runG.items.length === 1 && runG.items[0].store_id === null && runG.items[0].commission_amount === 150);

  // ---- 6. Isolamento ----
  const B = `org_B_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'B', 'active')`).run(randomUUID(), B);
  check("Isolamento: B não vê regras/runs de A", RetailCommissionService.listRules(B).length === 0 && RetailCommissionService.listRuns(B).length === 0);

  console.log("\n=== Retail Ops — Fase G: premiação/comissão (ADR-083) ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
