/**
 * TESTE — Custos VARIÁVEIS por loja + cadeia completa do resultado
 * (RetailStoreCostService — ADR-083 E5).
 * ---------------------------------------------------------------------------
 * O gestor pediu para "fechar a precificação de ponta a ponta". A camada de
 * custos FIXOS (E1–E4) subestimava o lucro por loja porque ignorava os ralos
 * proporcionais à venda: taxa de cartão/Pix, imposto (Simples), embalagem por
 * ticket, frete. Este teste prova a nova cadeia:
 *
 *   - upsert dos custos VARIÁVEIS por categoria (percent + fixedPerSale),
 *     clamp de percent 0..100, ignora categoria desconhecida, valor <= 0 zera;
 *   - contagem de vendas do mês vem do PDV (retail_pdv_sales) e, na ausência
 *     de PDV, cai pra contagem de fechamentos aprovados;
 *   - cadeia: Faturamento → −CMV (via margem bruta) → Margem BRUTA →
 *     −Variáveis (percent×fat + fixed×vendas) → Margem CONTRIBUIÇÃO →
 *     −Fixos → Resultado; PE = fixos ÷ MC% efetiva;
 *   - guardrail: fixedPerSale > 0 sem contagem de vendas → parcela IGNORADA
 *     e sinalizada em variableCostsWarning;
 *   - totais da rede somam custos variáveis das lojas com margem;
 *   - isolamento multi-tenant.
 *
 * Determinístico e offline (zero-token).
 *
 * Uso:  npm run test:retail-store-variable-costs
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-retail-store-varcosts-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-retail-store-varcosts-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}
const near = (a: number, b: number) => Math.abs(a - b) < 0.011;

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { RetailStoreService } = await import("../src/server/RetailStoreService.js");
  const { RetailStoreCostService } = await import("../src/server/RetailStoreCostService.js");

  const period = new Date().toISOString().slice(0, 7);

  const A = `org_A_${randomUUID().slice(0, 6)}`;
  db.prepare(
    `INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'A', 'active')`
  ).run(randomUUID(), A);
  const loja = RetailStoreService.create(A, { name: "Loja Centro", code: "10" });

  // ── Custos variáveis: estado inicial ─────────────────────────────────────
  const v0 = RetailStoreCostService.listVariable(A, loja.id);
  check("sem variáveis: totalPercent 0 e totalFixedPerSale 0", v0.totalPercent === 0 && v0.totalFixedPerSale === 0);
  check(
    "sem variáveis: expõe as 6 categorias zeradas",
    Object.keys(v0.byCategory).length === 6 &&
      v0.byCategory.card_fee.percent === 0 &&
      v0.byCategory.card_fee.fixedPerSale === 0,
    JSON.stringify(v0.byCategory)
  );

  // ── Upsert por categoria ─────────────────────────────────────────────────
  RetailStoreCostService.setManyVariable(A, loja.id, {
    card_fee: { percent: 3.5 },
    pix_fee: { percent: 0.99 },
    tax_sale: { percent: 6 },
    packaging: { fixedPerSale: 1.5 },
    freight: { percent: 1, fixedPerSale: 0.5 },
    other: { percent: 0.5 },
  } as any);
  const v1 = RetailStoreCostService.listVariable(A, loja.id);
  check("card_fee gravado (3.5%)", v1.byCategory.card_fee.percent === 3.5);
  check("packaging gravado (R$ 1,50 por venda)", v1.byCategory.packaging.fixedPerSale === 1.5);
  check("freight tem as duas naturezas (1% + R$ 0,50/venda)", v1.byCategory.freight.percent === 1 && v1.byCategory.freight.fixedPerSale === 0.5);
  check("totalPercent = 3.5 + 0.99 + 6 + 1 + 0.5 = 11.99", near(v1.totalPercent, 11.99), String(v1.totalPercent));
  check("totalFixedPerSale = 1.5 + 0.5 = 2.0", near(v1.totalFixedPerSale, 2.0), String(v1.totalFixedPerSale));

  // Upsert parcial: valor <= 0 zera a natureza; não mexe no que não veio.
  RetailStoreCostService.setManyVariable(A, loja.id, { card_fee: { percent: 0 } } as any);
  const v2 = RetailStoreCostService.listVariable(A, loja.id);
  check("card_fee percent zerado por valor <= 0", v2.byCategory.card_fee.percent === 0);
  check("tax_sale intacto após upsert parcial", v2.byCategory.tax_sale.percent === 6);

  // Categoria desconhecida ignorada.
  RetailStoreCostService.setManyVariable(A, loja.id, { desconhecida: { percent: 99 } } as any);
  const v3 = RetailStoreCostService.listVariable(A, loja.id);
  check("categoria desconhecida ignorada", (v3.byCategory as any).desconhecida === undefined);

  // Clamp: percent > 100 vira 100.
  RetailStoreCostService.setManyVariable(A, loja.id, { other: { percent: 250 } } as any);
  const v4 = RetailStoreCostService.listVariable(A, loja.id);
  check("percent > 100 clampeado para 100", v4.byCategory.other.percent === 100);

  // Restaura other para 0.5% (pra manter a cadeia limpa nos casos abaixo).
  RetailStoreCostService.setManyVariable(A, loja.id, { other: { percent: 0.5 }, card_fee: { percent: 3.5 } } as any);

  // ── Fatura + vendas do mês (PDV) ─────────────────────────────────────────
  // Cadastra custos fixos e margem para exercitar a cadeia inteira.
  RetailStoreCostService.setMany(A, loja.id, {
    aluguel: 5000, energia: 800, condominio: 1200, agua: 150, internet: 250, folha: 9000, outros: 600,
  } as any); // total 17.000
  RetailStoreService.update(A, loja.id, { grossMarginPercent: 50 });

  // Fechamentos + PDV (a loja se identifica em retail_pdv_sales pelo `filial` = store.code).
  const insClose = (status: string, informed: number, system: number, day: string) =>
    db.prepare(
      `INSERT INTO retail_daily_closings (id, organization_id, store_id, closing_date, status, informed_total, system_total)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(randomUUID(), A, loja.id, day, status, informed, system);
  const insPdv = (boleta: string, valor: number, day: string) =>
    db.prepare(
      `INSERT INTO retail_pdv_sales (id, organization_id, filial, boleta, sale_date, valor, pecas, status)
         VALUES (?, ?, ?, ?, ?, ?, 1, 'N')`
    ).run(randomUUID(), A, loja.code, boleta, day, valor);

  insClose("approved", 20000, 0, `${period}-05`);      // usa informed (20.000)
  insClose("reconciled", 15000, 15500, `${period}-06`); // prefere system_total (15.500)
  insClose("rejected", 99999, 99999, `${period}-07`);   // ignorado
  // 4 vendas no PDV do mesmo mês (tickets: 100, 200, 100, 100 = 500 no PDV;
  // faturamento oficial vem dos fechamentos — 35.500)
  insPdv("b1", 100, `${period}-05`);
  insPdv("b2", 200, `${period}-05`);
  insPdv("b3", 100, `${period}-06`);
  insPdv("b4", 100, `${period}-06`);

  const fat = RetailStoreCostService.monthlyRevenue(A, loja.id, period);
  const cnt = RetailStoreCostService.monthlySalesCount(A, loja.id, period);
  check("faturamento do mês = 35.500 (fechamentos)", near(fat, 35500), String(fat));
  check("contagem de vendas do mês = 4 (PDV)", cnt === 4, String(cnt));

  // ── Cadeia completa do resultado ─────────────────────────────────────────
  const r = RetailStoreCostService.storeResult(A, loja.id, period)!;
  // Faturamento: 35.500
  // Margem bruta: 35.500 × 50% = 17.750
  // Custo variável: 35.500 × 11.99% + 4 × 2.0
  //                = 4.256,45 + 8,00 = 4.264,45
  // Margem contribuição: 17.750 − 4.264,45 = 13.485,55
  // MC% efetiva: 13.485,55 / 35.500 = 37,9945% (≈ 38,00 com round2)
  // Resultado: 13.485,55 − 17.000 = -3.514,45 (prejuízo)
  // PE: 17.000 / 0,38 (MC% efetiva arredondada) — checamos com tolerância
  check("cadeia: margemBruta = 17.750", near(r.margemBruta!, 17750), String(r.margemBruta));
  check("cadeia: custoVariavelTotal ≈ 4.264,45", near(r.custoVariavelTotal!, 4264.45), String(r.custoVariavelTotal));
  check("cadeia: margemContribuicao ≈ 13.485,55", near(r.margemContribuicao!, 13485.55), String(r.margemContribuicao));
  check(
    "cadeia: margemContribuicaoPercent ≈ 37,99..38,00%",
    r.margemContribuicaoPercent! >= 37.98 && r.margemContribuicaoPercent! <= 38.01,
    String(r.margemContribuicaoPercent)
  );
  check("cadeia: resultado ≈ -3.514,45 (prejuízo)", near(r.resultado!, -3514.45), String(r.resultado));
  check("cadeia: pontoEquilibrio > 0", (r.pontoEquilibrio || 0) > 40000, String(r.pontoEquilibrio));
  check("cadeia: sem warning quando há contagem de vendas", r.variableCostsWarning === null);
  check("cadeia: vendasCount exposto (4)", r.vendasCount === 4);

  // ── Guardrail: fixedPerSale > 0 sem contagem de vendas ───────────────────
  // Loja 2: mesma configuração de variáveis, mas SEM PDV e SEM fechamentos.
  const loja2 = RetailStoreService.create(A, { name: "Loja Vazia", code: "20" });
  RetailStoreCostService.setMany(A, loja2.id, { aluguel: 1000 } as any);
  RetailStoreService.update(A, loja2.id, { grossMarginPercent: 40 });
  RetailStoreCostService.setManyVariable(A, loja2.id, { packaging: { fixedPerSale: 3 } } as any);
  const r2 = RetailStoreCostService.storeResult(A, loja2.id, period)!;
  check("guardrail: sem venda no mês, vendasCount = null", r2.vendasCount === null);
  check("guardrail: warning presente quando fixedPerSale > 0 sem contagem", (r2.variableCostsWarning || "").includes("Sem contagem"));
  check("guardrail: custoVariavelTotal = 0 (nada faturado × nada vendido)", r2.custoVariavelTotal === 0);

  // ── Fallback pra contagem em fechamentos quando não há PDV ───────────────
  const loja3 = RetailStoreService.create(A, { name: "Loja Só Fechamento", code: "30" });
  db.prepare(
    `INSERT INTO retail_daily_closings (id, organization_id, store_id, closing_date, status, informed_total, system_total)
       VALUES (?, ?, ?, ?, 'approved', ?, 0)`
  ).run(randomUUID(), A, loja3.id, `${period}-10`, 500);
  db.prepare(
    `INSERT INTO retail_daily_closings (id, organization_id, store_id, closing_date, status, informed_total, system_total)
       VALUES (?, ?, ?, ?, 'approved', ?, 0)`
  ).run(randomUUID(), A, loja3.id, `${period}-11`, 500);
  const cnt3 = RetailStoreCostService.monthlySalesCount(A, loja3.id, period);
  check("fallback: sem PDV, conta pelos fechamentos aprovados (2)", cnt3 === 2, String(cnt3));

  // ── Totais da rede somam custos variáveis das lojas com margem ───────────
  const rede = RetailStoreCostService.allStoresResult(A, period);
  const encontrada = rede.perStore.find((p) => p.storeId === loja.id)!;
  check("rede: loja principal presente", !!encontrada);
  check(
    "rede: totals.custosVariaveis soma os custos variáveis calculados",
    near(rede.totals.custosVariaveis, (encontrada.custoVariavelTotal || 0) + (rede.perStore.find((p) => p.storeId === loja2.id)?.custoVariavelTotal || 0)),
    String(rede.totals.custosVariaveis)
  );
  check("rede: categories.variableCategories exposto", Array.isArray((rede as any).variableCategories) && (rede as any).variableCategories.length === 6);

  // ── Loja inexistente ─────────────────────────────────────────────────────
  let threw = false;
  try {
    RetailStoreCostService.setManyVariable(A, "loja-fantasma", { card_fee: { percent: 1 } } as any);
  } catch { threw = true; }
  check("setManyVariable em loja inexistente lança erro", threw);
  check(
    "listVariable de loja inexistente retorna zeros (não erra)",
    RetailStoreCostService.listVariable(A, "loja-fantasma").totalPercent === 0
  );

  // ── Isolamento multi-tenant ──────────────────────────────────────────────
  const B = `org_B_${randomUUID().slice(0, 6)}`;
  db.prepare(
    `INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'B', 'active')`
  ).run(randomUUID(), B);
  check(
    "isolamento: org B não vê custos variáveis da loja da org A",
    RetailStoreCostService.listVariable(B, loja.id).totalPercent === 0
  );
  check(
    "isolamento: org B não computa resultado da loja da org A",
    RetailStoreCostService.storeResult(B, loja.id, period) === null
  );
  check(
    "isolamento: org B não conta vendas da loja da org A",
    RetailStoreCostService.monthlySalesCount(B, loja.id, period) === null
  );

  console.log("\n=== Custos variáveis por loja + cadeia do resultado (ADR-083 E5) ===");
  for (const rr of results) console.log(`${rr.ok ? "PASS" : "FAIL"}  ${rr.name}${rr.ok || !rr.detail ? "" : ` — ${rr.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
