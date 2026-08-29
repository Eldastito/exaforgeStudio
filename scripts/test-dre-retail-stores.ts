/**
 * TESTE — DRE gerencial inclui as LOJAS (varejo/Alterdata) quando a ponte está ligada.
 * ------------------------------------------------------------------------------
 * O ManagerialDreService era core-only (order_items + Comigo), então o
 * faturamento das lojas Toulon (retail_daily_closings) não entrava no DRE.
 * Agora, SÓ com a ponte `retail_revenue_bridge` ligada, entra a receita das
 * lojas E o CMV real dos itens do PDV juntos (margem continua honesta).
 *
 * Prova, offline:
 *   - ponte OFF → breakdown.lojas = 0, DRE idêntico ao core;
 *   - ponte ON  → receitaBruta soma o faturamento dos fechamentos; breakdown.lojas
 *     traz a receita; a identidade da margem se mantém;
 *   - isolamento por organização.
 *
 * Uso:  npm run test:dre-retail-stores
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-dre-retail-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-dre-retail-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }
const near = (a: number, b: number, eps = 0.01) => Math.abs(Number(a) - Number(b)) <= eps;

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { RetailStoreService } = await import("../src/server/RetailStoreService.js");
  const { RetailRevenueBridgeService } = await import("../src/server/RetailRevenueBridgeService.js");
  const { ManagerialDreService } = await import("../src/server/ManagerialDreService.js");

  const period = new Date().toISOString().slice(0, 7);
  const today = new Date().toISOString().slice(0, 10);
  const A = `org_A_${randomUUID().slice(0, 6)}`;
  const B = `org_B_${randomUUID().slice(0, 6)}`;
  for (const org of [A, B]) db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), org);

  // Core: 1 pedido pago (receita 1000 / custo 600).
  const oid = randomUUID();
  db.prepare(`INSERT INTO orders (id, organization_id, status, total_amount) VALUES (?, ?, 'pago', 1000)`).run(oid, A);
  db.prepare(`INSERT INTO order_items (id, order_id, organization_id, name_snapshot, unit_price, quantity, line_total, unit_cost) VALUES (?, ?, ?, 'Produto', 10, 100, 1000, 6)`).run(randomUUID(), oid, A);

  // Lojas: 2 fechamentos aprovados HOJE (faturamento 2300 + 1000 = 3300).
  const s1 = RetailStoreService.create(A, { name: "Loja 1" });
  const s2 = RetailStoreService.create(A, { name: "Loja 2" });
  const closing = (store: string, sys: number) =>
    db.prepare(`INSERT INTO retail_daily_closings (id, organization_id, store_id, closing_date, status, informed_total, system_total, divergence_status) VALUES (?, ?, ?, ?, 'approved', ?, ?, 'ok')`)
      .run(randomUUID(), A, store, today, sys, sys);
  closing(s1.id, 2300);
  closing(s2.id, 1000);

  // ===== 1. Ponte OFF → DRE não vê as lojas =====
  const off: any = ManagerialDreService.monthly(A, period);
  check("ponte OFF: breakdown.lojas = 0", near(off.breakdown.lojas.revenue, 0) && near(off.breakdown.lojas.cost, 0));
  check("ponte OFF: receita bruta = só core (1000)", near(off.linhas.receitaBruta, 1000), `receitaBruta=${off.linhas.receitaBruta}`);

  // ===== 2. Ponte ON → DRE soma o faturamento das lojas =====
  RetailRevenueBridgeService.setEnabled(A, true);
  const on: any = ManagerialDreService.monthly(A, period);
  check("ponte ON: breakdown.lojas.revenue = 3300", near(on.breakdown.lojas.revenue, 3300), `lojas.revenue=${on.breakdown.lojas.revenue}`);
  check("ponte ON: receita bruta = core 1000 + lojas 3300 = 4300", near(on.linhas.receitaBruta, 4300), `receitaBruta=${on.linhas.receitaBruta}`);
  check("ponte ON: core intacto (1000/600)", near(on.breakdown.core.revenue, 1000) && near(on.breakdown.core.cost, 600));
  // Identidade da margem (sem CMV de PDV neste cenário → cmv = core 600).
  check("identidade: margemBruta = receitaLiquida - CMV", near(on.linhas.margemBruta, on.linhas.receitaLiquida - on.linhas.cmv));

  // ===== 3. Isolamento =====
  RetailRevenueBridgeService.setEnabled(B, true);
  const bDre: any = ManagerialDreService.monthly(B, period);
  check("Isolamento: org B não vê as lojas de A", near(bDre.breakdown.lojas.revenue, 0) && near(bDre.linhas.receitaBruta, 0));

  console.log("\n=== DRE inclui as lojas com a ponte ligada ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
