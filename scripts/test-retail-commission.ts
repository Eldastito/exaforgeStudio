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

  // ---- 3.5. Ajuste manual do gerente (updateItem / deleteItem) ----
  // Antes de aprovar: sobrescrever o valor de uma linha e excluir outra;
  // o total_commission tem que refletir a mudança na hora.
  const runEdit = RetailCommissionService.createRun(A, START, END, "u1");
  const itA1 = runEdit.items.find((i: any) => i.store_id === s1.id);
  const itA2 = runEdit.items.find((i: any) => i.store_id === s2.id);
  const overwritten = RetailCommissionService.updateItem(A, runEdit.id, itA1.id, { commissionAmount: 620.5 }, "gestor");
  const itA1u = overwritten.items.find((i: any) => i.id === itA1.id);
  check("updateItem: comissão sobrescrita (500 → 620,50)", itA1u.commission_amount === 620.5);
  check("updateItem: total_commission recalculou (620,50 + 250 = 870,50)", overwritten.total_commission === 870.5, `total=${overwritten.total_commission}`);
  const afterDelete = RetailCommissionService.deleteItem(A, runEdit.id, itA2.id, "gestor");
  check("deleteItem: loja 2 fora da apuração", !afterDelete.items.some((i: any) => i.id === itA2.id));
  check("deleteItem: total_commission = só a loja 1 sobrescrita (620,50)", afterDelete.total_commission === 620.5, `total=${afterDelete.total_commission}`);
  let editBlocked = false;
  try { RetailCommissionService.updateItem(A, runEdit.id, itA1.id, { commissionAmount: -1 }, "gestor"); } catch (e: any) { editBlocked = e.message === "negative_commission"; }
  check("updateItem bloqueia comissão negativa", editBlocked);
  RetailCommissionService.setStatus(A, runEdit.id, "approved", "gestor");
  let approvedBlocked = false;
  try { RetailCommissionService.updateItem(A, runEdit.id, itA1.id, { commissionAmount: 999 }, "gestor"); } catch (e: any) { approvedBlocked = e.message === "run_not_editable"; }
  check("updateItem bloqueia edição em run APROVADO (congelado)", approvedBlocked);
  let approvedDeleteBlocked = false;
  try { RetailCommissionService.deleteItem(A, runEdit.id, itA1.id, "gestor"); } catch (e: any) { approvedDeleteBlocked = e.message === "run_not_editable"; }
  check("deleteItem bloqueia remoção em run APROVADO (congelado)", approvedDeleteBlocked);
  const editAudit = db.prepare(`SELECT event_type FROM auth_audit_logs WHERE organization_id = ? AND event_type IN ('RETAIL_COMMISSION_ITEM_ADJUSTED', 'RETAIL_COMMISSION_ITEM_REMOVED')`).all(A) as any[];
  check("Audit: ajuste e remoção registrados", editAudit.some((e) => e.event_type === "RETAIL_COMMISSION_ITEM_ADJUSTED") && editAudit.some((e) => e.event_type === "RETAIL_COMMISSION_ITEM_REMOVED"));

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
  // ---- SELL-007: matrícula sem nome = pendência de identidade no relatório ----
  db.prepare(`INSERT INTO retail_pdv_sales (id, organization_id, filial, boleta, sale_date, vendedor, vendedor_codigo, valor, pecas) VALUES (?, ?, 'X', '1', '2026-07-10', 'op', '7777', 300, 2)`).run(randomUUID(), A);
  db.prepare(`INSERT INTO retail_sellers (id, organization_id, matricula, name, active) VALUES (?, ?, '8888', 'Bia', 1)`).run(randomUUID(), A);
  db.prepare(`INSERT INTO retail_pdv_sales (id, organization_id, filial, boleta, sale_date, vendedor, vendedor_codigo, valor, pecas) VALUES (?, ?, 'X', '2', '2026-07-10', 'op', '8888', 400, 1)`).run(randomUUID(), A);
  const rep = RetailCommissionService.report(A, START, END);
  const pend = (rep.bySeller || []).find((s: any) => s.matricula === '7777');
  const named = (rep.bySeller || []).find((s: any) => s.sellerName === 'Bia');
  check("matrícula 7777 sem nome → pendingIdentity + source pdv", !!pend && pend.pendingIdentity === true && String(pend.source).includes('pdv'));
  check("matrícula 8888 com nome (Bia) → não é pendência", !!named && named.pendingIdentity === false);
  check("relatório conta as pendências de identidade", rep.pendingIdentityCount >= 1);

  check("Isolamento: B não vê regras/runs de A", RetailCommissionService.listRules(B).length === 0 && RetailCommissionService.listRuns(B).length === 0);

  console.log("\n=== Retail Ops — Fase G: premiação/comissão (ADR-083) ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
