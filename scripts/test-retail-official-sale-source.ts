/**
 * TESTE — Fonte oficial da venda (Fase 4 Toulon): folha × caixa, por org.
 * ----------------------------------------------------------------------------
 * A rede confirmou que a venda oficial (meta e comissão) é a FOLHA (informado),
 * não o caixa da AlterData. Prova:
 *   - política POR ORG: default 'system' (legado, caixa primeiro); 'folha' faz
 *     o informado mandar. Trocar a de uma org NÃO afeta a outra;
 *   - CONTRATO: numa org 'folha', dashboard (realizado) e comissão da loja
 *     usam o MESMO total (a folha) — não divergem mais;
 *   - CONGELAMENTO: apuração já criada (retail_commission_items) é snapshot;
 *     trocar a política depois não altera a comissão apurada.
 *
 * Uso:  npm run test:retail-official-sale-source
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-official-src-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-official-src-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { RetailStoreService } = await import("../src/server/RetailStoreService.js");
  const { RetailQuotaService } = await import("../src/server/RetailOpsService.js");
  const { RetailCommissionService } = await import("../src/server/RetailCommissionService.js");
  const { RetailDashboardService } = await import("../src/server/RetailDashboardService.js");
  const { officialSaleSourceOf } = await import("../src/server/RetailSalesPolicy.js");

  const setSource = (org: string, src: string) => db.prepare(`UPDATE organization_settings SET retail_official_sale_source = ? WHERE organization_id = ?`).run(src, org);
  const mkOrg = (label: string) => { const id = `org_${label}_${randomUUID().slice(0, 6)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, ?, 'active')`).run(randomUUID(), id, label); return id; };
  const DAY = "2026-09-19";
  const seed = (org: string) => {
    const loja = RetailStoreService.create(org, { name: "Loja", code: "L1" });
    RetailQuotaService.set(org, { storeId: loja.id, quotaDate: DAY, quotaAmount: 5000 }, "t");
    db.prepare(`INSERT INTO retail_daily_closings (id, organization_id, store_id, closing_date, status, informed_total, system_total, system_turnos_json) VALUES (?, ?, ?, ?, 'approved', 5476.70, 5476.80, ?)`)
      .run(randomUUID(), org, loja.id, DAY, JSON.stringify({ "1": 5476.8 }));
    // Regra de 100% da rede: comissão = base × 100% → lê a BASE efetiva.
    RetailCommissionService.createRule(org, { name: "100%", scope: "global", calculationType: "percent_sales", config: { percent: 100 } }, "t");
    return loja;
  };

  const A = mkOrg("A"), lojaA = seed(A); // vira 'folha' (Toulon)
  const B = mkOrg("B"), lojaB = seed(B); // fica 'system' (outro tenant)

  // ── 0. Default é 'system' (não muda ninguém sem configurar) ──
  check("0.1 default da org = 'system'", officialSaleSourceOf(A) === "system" && officialSaleSourceOf(B) === "system");

  // ── 1. A → 'folha'; B fica 'system' (per-org, sem vazar) ──
  setSource(A, "folha");
  check("1.1 A='folha', B='system'", officialSaleSourceOf(A) === "folha" && officialSaleSourceOf(B) === "system");

  const dashA = RetailDashboardService.daily(A, DAY, lojaA.id).realized;
  const dashB = RetailDashboardService.daily(B, DAY, lojaB.id).realized;
  check("1.2 dashboard usa a folha nas duas (já era informado): 5.476,70", dashA === 5476.70 && dashB === 5476.70, JSON.stringify({ dashA, dashB }));

  // ── 2. CONTRATO: base de comissão = fonte oficial da org ──
  const commA = RetailCommissionService.estimateTotal(A, DAY, DAY);
  const commB = RetailCommissionService.estimateTotal(B, DAY, DAY);
  check("2.1 A('folha'): base comissão = folha 5.476,70 = dashboard", commA === 5476.70 && commA === dashA, `commA=${commA}`);
  check("2.2 B('system'): base comissão = caixa 5.476,80 (legado inalterado)", commB === 5476.80, `commB=${commB}`);
  check("2.3 CONTRATO org folha: dashboard == comissão (mesma venda oficial)", dashA === commA);

  // ── 3. CONGELAMENTO: snapshot de apuração não recalcula ao trocar a política ──
  const runId = randomUUID();
  db.prepare(`INSERT INTO retail_commission_runs (id, organization_id, period_start, period_end, status, total_sales, total_commission, created_by) VALUES (?, ?, '2026-09-01', '2026-09-30', 'approved', 5476.80, 54.77, 't')`).run(runId, A);
  db.prepare(`INSERT INTO retail_commission_items (id, organization_id, run_id, store_id, seller_name, base_amount, commission_amount, calculation_details_json) VALUES (?, ?, ?, ?, 'Vend', 5476.80, 54.77, '{}')`).run(randomUUID(), A, runId, lojaA.id);
  setSource(A, "system"); // troca a política DEPOIS de apurar
  const item = db.prepare(`SELECT base_amount, commission_amount FROM retail_commission_items WHERE run_id = ?`).get(runId) as any;
  check("3.1 apuração aprovada (snapshot) intocada pela troca de política", Number(item.base_amount) === 5476.80 && Number(item.commission_amount) === 54.77, JSON.stringify(item));
  const run = db.prepare(`SELECT status, total_sales FROM retail_commission_runs WHERE id = ?`).get(runId) as any;
  check("3.2 run aprovado permanece com o total pago", run.status === "approved" && Number(run.total_sales) === 5476.80);
  // Volta A p/ folha e confirma que a base viva mudou (mas o snapshot não).
  setSource(A, "folha");
  check("3.3 base viva reflete a política atual (folha), snapshot separado", RetailCommissionService.estimateTotal(A, DAY, DAY) === 5476.70 && Number(item.base_amount) === 5476.80);

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name} ${x.detail ? `(${x.detail})` : ""}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} retail-official-sale-source: ${passed}/${results.length} checks`);
  if (failures > 0) process.exit(1);
}

main().finally(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ } });
