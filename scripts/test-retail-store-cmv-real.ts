/**
 * TESTE — CMV REAL por loja via avg_cost × unidades vendidas
 * (Fatia 2 de "fechar precificação" — ADR-083 E6).
 * ---------------------------------------------------------------------------
 * O `gross_margin_percent` do PR #639 é um CHUTE do gestor. Quando a operação
 * já cadastra notas de compra (NF-e), o app tem o custo médio ponderado dos
 * produtos (`inventory_items.avg_cost`) — dá pra derivar o CMV DE VERDADE via
 * `Σ (unidades vendidas no mês × avg_cost)` dos itens do PDV
 * (`retail_pdv_sale_items`). Este teste prova:
 *
 *   - CMV 100% real quando todos os itens vendidos têm avg_cost cadastrado
 *     (source='real', coverage=1);
 *   - CMV blended quando parte dos itens tem custo (source='blended',
 *     coverage < 1): usa avg_cost pros itens cobertos + gross_margin_percent
 *     pros descobertos + pro faturamento fora do PDV;
 *   - Fallback puro pra gross_margin_percent quando não há PDV item a item;
 *   - Guardrail: sem margem cadastrada, blended NÃO extrapola (fica NULL);
 *   - Isolamento multi-tenant (avg_cost e itens de outra org não vazam);
 *   - Regressão numérica: sem PDV item a item + com margem, o resultado é
 *     IDÊNTICO ao do teste da Fatia 1 (as fatias empilham sem quebrar).
 *
 * Determinístico e offline (zero-token).
 *
 * Uso:  npm run test:retail-store-cmv-real
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-retail-cmv-real-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-retail-cmv-real-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}
const near = (a: number, b: number, eps = 0.011) => Math.abs(a - b) < eps;

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { RetailStoreService } = await import("../src/server/RetailStoreService.js");
  const { RetailStoreCostService } = await import("../src/server/RetailStoreCostService.js");

  const period = new Date().toISOString().slice(0, 7);
  const A = `org_A_${randomUUID().slice(0, 6)}`;
  db.prepare(
    `INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'A', 'active')`
  ).run(randomUUID(), A);

  const loja = RetailStoreService.create(A, { name: "Loja CMV", code: "10" });
  RetailStoreService.update(A, loja.id, { grossMarginPercent: 60 });

  // ── Catálogo: 2 produtos com custo cadastrado, 1 SEM custo ───────────────
  const p1 = randomUUID(); // com custo (bermuda)
  const p2 = randomUUID(); // com custo (camiseta)
  const p3 = randomUUID(); // SEM custo (chaveiro — descoberto)
  db.prepare(
    `INSERT INTO products_services (id, organization_id, name, type, active, external_ref) VALUES (?, ?, ?, 'product', 1, ?)`
  ).run(p1, A, "Bermuda", "BERM01");
  db.prepare(
    `INSERT INTO products_services (id, organization_id, name, type, active, external_ref) VALUES (?, ?, ?, 'product', 1, ?)`
  ).run(p2, A, "Camiseta", "CAMI01");
  db.prepare(
    `INSERT INTO products_services (id, organization_id, name, type, active, external_ref) VALUES (?, ?, ?, 'product', 1, ?)`
  ).run(p3, A, "Chaveiro", "CHAV01");

  db.prepare(
    `INSERT INTO inventory_items (id, organization_id, product_service_id, quantity_available, avg_cost) VALUES (?, ?, ?, 0, ?)`
  ).run(randomUUID(), A, p1, 40); // custo médio R$ 40,00
  db.prepare(
    `INSERT INTO inventory_items (id, organization_id, product_service_id, quantity_available, avg_cost) VALUES (?, ?, ?, 0, ?)`
  ).run(randomUUID(), A, p2, 20); // custo médio R$ 20,00
  db.prepare(
    `INSERT INTO inventory_items (id, organization_id, product_service_id, quantity_available, avg_cost) VALUES (?, ?, ?, 0, 0)`
  ).run(randomUUID(), A, p3); // avg_cost = 0 → descoberto

  // ── Vendas do PDV (itens) ────────────────────────────────────────────────
  const insItem = (
    boleta: string, seq: number, produto: string, qty: number, valor: number, day: string
  ) =>
    db.prepare(
      `INSERT INTO retail_pdv_sale_items (id, organization_id, filial, boleta, sale_date, item_seq, produto, quantidade, valor)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(randomUUID(), A, loja.code, boleta, day, seq, produto, qty, valor);
  const insTicket = (boleta: string, valor: number, day: string) =>
    db.prepare(
      `INSERT INTO retail_pdv_sales (id, organization_id, filial, boleta, sale_date, valor, pecas, status) VALUES (?, ?, ?, ?, ?, ?, 1, 'N')`
    ).run(randomUUID(), A, loja.code, boleta, day, valor);
  const insClosing = (informed: number, system: number, day: string) =>
    db.prepare(
      `INSERT INTO retail_daily_closings (id, organization_id, store_id, closing_date, status, informed_total, system_total)
         VALUES (?, ?, ?, ?, 'approved', ?, ?)`
    ).run(randomUUID(), A, loja.id, day, informed, system);

  // ── Cenário 1: CMV 100% REAL (todos os itens vendidos têm avg_cost) ──────
  // 2 bermudas × R$ 180 (custo 40 cada) + 3 camisetas × R$ 60 (custo 20 cada)
  // Receita PDV = 360 + 180 = 540; CMV real = 80 + 60 = 140
  insTicket("R1", 240, `${period}-05`);
  insItem("R1", 1, "BERM01", 1, 180, `${period}-05`);
  insItem("R1", 2, "CAMI01", 1, 60, `${period}-05`);
  insTicket("R2", 300, `${period}-06`);
  insItem("R2", 1, "BERM01", 1, 180, `${period}-06`);
  insItem("R2", 2, "CAMI01", 2, 120, `${period}-06`);
  insClosing(540, 540, `${period}-05`); // faturamento oficial 540 no fechamento

  const cmvBd = RetailStoreCostService.monthlyCogsBreakdown(A, loja.id, period);
  check("cenário REAL: source = 'real'", cmvBd.source === "real", String(cmvBd.source));
  check("cenário REAL: coverage = 1.0", cmvBd.coverage === 1, String(cmvBd.coverage));
  check("cenário REAL: cmvReal = 140 (2×40 + 3×20)", near(cmvBd.cmvReal, 140), String(cmvBd.cmvReal));
  check("cenário REAL: revenueCovered = 540", near(cmvBd.revenueCovered, 540), String(cmvBd.revenueCovered));

  const r1 = RetailStoreCostService.storeResult(A, loja.id, period)!;
  // Faturamento 540; CMV real (ratio 140/540 aplicado a 540) = 140
  // Margem bruta = 540 − 140 = 400 (bem melhor que 540×60% = 324!)
  check("cenário REAL: cmv usado = 140", near(r1.cmv!, 140), String(r1.cmv));
  check("cenário REAL: margemBruta = 400 (não os 324 do chute)", near(r1.margemBruta!, 400), String(r1.margemBruta));
  check("cenário REAL: cmvBreakdown.source = 'real'", r1.cmvBreakdown?.source === "real");
  check("cenário REAL: sem cmvWarning", r1.cmvWarning === null);

  // ── Cenário 2: CMV BLENDED (parte coberta, parte descoberta) ─────────────
  // Loja 2 vende 1 bermuda (BERM01, custo 40) por 200 + 1 chaveiro (CHAV01,
  // SEM custo) por 50. Receita PDV = 250. Coverage = 200/250 = 80%.
  // CMV real (só coberto) = 40; CMV estimado pra 20% + fora-PDV via margem 60%.
  const loja2 = RetailStoreService.create(A, { name: "Loja Blended", code: "20" });
  RetailStoreService.update(A, loja2.id, { grossMarginPercent: 60 });
  insTicket("B1", 250, `${period}-05`); // registra ticket (não obrigatório mas realista)
  db.prepare(
    `INSERT INTO retail_pdv_sale_items (id, organization_id, filial, boleta, sale_date, item_seq, produto, quantidade, valor)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(randomUUID(), A, loja2.code, "B1", `${period}-05`, 1, "BERM01", 1, 200);
  db.prepare(
    `INSERT INTO retail_pdv_sale_items (id, organization_id, filial, boleta, sale_date, item_seq, produto, quantidade, valor)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(randomUUID(), A, loja2.code, "B1", `${period}-05`, 2, "CHAV01", 1, 50);
  db.prepare(
    `INSERT INTO retail_daily_closings (id, organization_id, store_id, closing_date, status, informed_total, system_total)
       VALUES (?, ?, ?, ?, 'approved', 250, 250)`
  ).run(randomUUID(), A, loja2.id, `${period}-05`);

  const cmvBd2 = RetailStoreCostService.monthlyCogsBreakdown(A, loja2.id, period);
  check("cenário BLENDED: source = 'blended'", cmvBd2.source === "blended", String(cmvBd2.source));
  check("cenário BLENDED: coverage ≈ 0.80", near(cmvBd2.coverage, 0.8, 0.005), String(cmvBd2.coverage));
  check("cenário BLENDED: cmvReal = 40 (1×40)", near(cmvBd2.cmvReal, 40), String(cmvBd2.cmvReal));

  const r2 = RetailStoreCostService.storeResult(A, loja2.id, period)!;
  // CMV blended: 40 (real) + (250−200)×(1−0.60) + (250−250)×(1−0.60)
  //            = 40 + 50×0.40 + 0 = 60
  // Margem bruta = 250 − 60 = 190
  check("cenário BLENDED: cmv usado = 60 (40 real + 20 estimado)", near(r2.cmv!, 60), String(r2.cmv));
  check("cenário BLENDED: margemBruta = 190", near(r2.margemBruta!, 190), String(r2.margemBruta));
  check("cenário BLENDED: cmvWarning presente com %", (r2.cmvWarning || "").includes("80%"));

  // ── Cenário 3: Fallback puro (sem PDV item a item, só fechamento) ────────
  const loja3 = RetailStoreService.create(A, { name: "Loja Só Fechamento", code: "30" });
  RetailStoreService.update(A, loja3.id, { grossMarginPercent: 55 });
  db.prepare(
    `INSERT INTO retail_daily_closings (id, organization_id, store_id, closing_date, status, informed_total, system_total)
       VALUES (?, ?, ?, ?, 'approved', 1000, 0)`
  ).run(randomUUID(), A, loja3.id, `${period}-05`);
  const cmvBd3 = RetailStoreCostService.monthlyCogsBreakdown(A, loja3.id, period);
  check("cenário FALLBACK: source = 'estimate' (sem PDV item a item)", cmvBd3.source === "estimate");
  check("cenário FALLBACK: revenueTotalPdv = 0", cmvBd3.revenueTotalPdv === 0);

  const r3 = RetailStoreCostService.storeResult(A, loja3.id, period)!;
  // Sem PDV item a item: cai no fallback puro (comportamento do PR #641).
  // 1000 × 55% = 550
  check("cenário FALLBACK: margemBruta = 550 (comportamento PR #641)", near(r3.margemBruta!, 550), String(r3.margemBruta));
  check("cenário FALLBACK: cmv usado = 450 (1000 − 550)", near(r3.cmv!, 450), String(r3.cmv));
  check("cenário FALLBACK: cmvBreakdown = null (sem PDV item a item)", r3.cmvBreakdown === null);
  check("cenário FALLBACK: sem cmvWarning", r3.cmvWarning === null);

  // ── Guardrail: BLENDED sem margem cadastrada → sem margemBruta ───────────
  const loja4 = RetailStoreService.create(A, { name: "Loja BlendedSemMargem", code: "40" });
  // SEM setar grossMarginPercent — mesmo cenário blended da loja2.
  db.prepare(
    `INSERT INTO retail_pdv_sale_items (id, organization_id, filial, boleta, sale_date, item_seq, produto, quantidade, valor)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(randomUUID(), A, loja4.code, "S1", `${period}-05`, 1, "BERM01", 1, 200);
  db.prepare(
    `INSERT INTO retail_pdv_sale_items (id, organization_id, filial, boleta, sale_date, item_seq, produto, quantidade, valor)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(randomUUID(), A, loja4.code, "S1", `${period}-05`, 2, "CHAV01", 1, 50);
  db.prepare(
    `INSERT INTO retail_daily_closings (id, organization_id, store_id, closing_date, status, informed_total, system_total)
       VALUES (?, ?, ?, ?, 'approved', 250, 250)`
  ).run(randomUUID(), A, loja4.id, `${period}-05`);
  const r4 = RetailStoreCostService.storeResult(A, loja4.id, period)!;
  check("guardrail: sem margem + blended → margemBruta NULL", r4.margemBruta === null);
  check("guardrail: sem margem → resultado NULL (comportamento antigo preservado)", r4.resultado === null);

  // ── Regressão: sem PDV item a item, comportamento é idêntico à Fatia 1 ───
  // (loja3 já validou o valor bruto acima — 1000×55% = 550, PE = fixos ÷ 0.55).
  // Aqui só reasseguramos que MC%, PE e resultado batem SEM CMV real interferir.
  RetailStoreCostService.setMany(A, loja3.id, { aluguel: 200 } as any);
  const r3b = RetailStoreCostService.storeResult(A, loja3.id, period)!;
  // 1000×55% − 200 = 350
  check("regressão: sem PDV item a item, resultado = 350", near(r3b.resultado!, 350), String(r3b.resultado));
  // PE = 200 / 0.55 ≈ 363,64
  check("regressão: sem PDV item a item, PE ≈ 363,64", near(r3b.pontoEquilibrio!, 363.64, 0.05), String(r3b.pontoEquilibrio));

  // ── Isolamento multi-tenant ──────────────────────────────────────────────
  const B = `org_B_${randomUUID().slice(0, 6)}`;
  db.prepare(
    `INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'B', 'active')`
  ).run(randomUUID(), B);
  const cmvBdB = RetailStoreCostService.monthlyCogsBreakdown(B, loja.id, period);
  check("isolamento: org B não vê itens PDV da loja da org A", cmvBdB.revenueTotalPdv === 0);

  console.log("\n=== CMV REAL por loja (ADR-083 E6) ===");
  for (const rr of results) console.log(`${rr.ok ? "PASS" : "FAIL"}  ${rr.name}${rr.ok || !rr.detail ? "" : ` — ${rr.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
