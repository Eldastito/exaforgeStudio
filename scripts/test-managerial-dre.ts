/**
 * TEST — DRE Gerencial Simplificada (ADR-128 Fatia 1).
 *
 * Venda × lucro × caixa: receita/CMV somando core + Comigo, descontos abatem a
 * receita, despesas reduzem o resultado, disclaimer sempre presente, isolado
 * por org. Sem chave de IA.
 *
 * Uso: npm run test:managerial-dre
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-dre-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-dre-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }
const near = (a: number, b: number, eps = 0.02) => Math.abs(a - b) <= eps;

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { LossMarginService: L } = await import("../src/server/LossMarginService.js");
  const { ManagerialDreService: D } = await import("../src/server/ManagerialDreService.js");

  const period = new Date().toISOString().slice(0, 7);
  const today = new Date().toISOString().slice(0, 10);
  const orgId = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), orgId);

  // ===== Core: 1 pedido pago, item 1000 de receita, custo 600 =====
  const oid = randomUUID();
  db.prepare(`INSERT INTO orders (id, organization_id, status, total_amount) VALUES (?, ?, 'pago', 1000)`).run(oid, orgId);
  db.prepare(`INSERT INTO order_items (id, order_id, organization_id, name_snapshot, unit_price, quantity, line_total, unit_cost) VALUES (?, ?, ?, 'Produto', 10, 100, 1000, 6)`).run(randomUUID(), oid, orgId);

  // ===== Comigo: venda à vista, receita 500, custo 200 =====
  const cid = randomUUID();
  db.prepare(`INSERT INTO comigo_orders (id, organization_id, status, total) VALUES (?, ?, 'paid', 500)`).run(cid, orgId);
  db.prepare(`INSERT INTO comigo_order_items (id, order_id, name, qty, unit_price, unit_cost_snapshot) VALUES (?, ?, 'Marmita', 50, 10, 4)`).run(randomUUID(), cid);

  // ===== Descontos (perdas) + despesas (conta a pagar do mês) =====
  L.recordLoss(orgId, { driver: "desconto", amount: 100 });
  db.prepare(`INSERT INTO payables (id, organization_id, description, amount, due_date, status) VALUES (?, ?, 'Aluguel', 300, ?, 'open')`).run(randomUUID(), orgId, today);

  const dre: any = D.monthly(orgId, period);
  const l = dre.linhas;

  // ===== 1. Receita soma core + Comigo =====
  check("receita bruta = core 1000 + comigo 500 = 1500", near(l.receitaBruta, 1500));
  check("breakdown core (1000/600) e comigo (500/200)", near(dre.breakdown.core.revenue, 1000) && near(dre.breakdown.core.cost, 600) && near(dre.breakdown.comigo.revenue, 500) && near(dre.breakdown.comigo.cost, 200));

  // ===== 2. Descontos abatem a receita =====
  check("descontos = 100", near(l.descontos, 100));
  check("receita líquida = 1500 - 100 = 1400", near(l.receitaLiquida, 1400));

  // ===== 3. CMV e margem bruta =====
  check("CMV = 600 + 200 = 800", near(l.cmv, 800));
  check("margem bruta = 1400 - 800 = 600", near(l.margemBruta, 600));
  check("margem % = 600/1400 ≈ 42.86", near(l.margemPct as number, 42.86, 0.05));

  // ===== 4. Despesas e resultado =====
  check("despesas (competência do mês) = 300", near(l.despesas, 300));
  check("resultado operacional = 600 - 300 = 300", near(l.resultadoOperacional, 300));
  check("retiradas = 0 (placeholder Empresa × Proprietário)", l.retiradas === 0);
  check("sobra = resultado - retiradas = 300", near(l.sobra, 300));
  check("identidade: sobra = receitaLiq - CMV - despesas - retiradas", near(l.sobra, l.receitaLiquida - l.cmv - l.despesas - l.retiradas));

  // ===== 4b. Despesas fixas × variáveis + comparação mês a mês (Fatia 2) =====
  check("despesa avulsa entra como variável (300) e fixa 0", near(l.despesasVariaveis, 300) && near(l.despesasFixas, 0));
  check("comparação mês a mês presente (sem mês anterior → delta = atual)", dre.comparacao && near(dre.comparacao.receitaBruta.atual, 1500) && near(dre.comparacao.receitaBruta.anterior, 0) && near(dre.comparacao.receitaBruta.delta, 1500));

  // Split fixa × variável num org dedicado.
  const split = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'S', 'active')`).run(randomUUID(), split);
  db.prepare(`INSERT INTO payables (id, organization_id, description, amount, due_date, recurrence, status) VALUES (?, ?, 'Aluguel', 200, ?, 'monthly', 'open')`).run(randomUUID(), split, today);
  db.prepare(`INSERT INTO payables (id, organization_id, description, amount, due_date, recurrence, status) VALUES (?, ?, 'Compra avulsa', 300, ?, 'none', 'open')`).run(randomUUID(), split, today);
  const ds = D.monthly(split, period).linhas;
  check("recorrente = fixa (200), avulsa = variável (300)", near(ds.despesasFixas, 200) && near(ds.despesasVariaveis, 300) && near(ds.despesas, 500));

  // Devolução (driver próprio) abate a receita, num org dedicado.
  const dev = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'D', 'active')`).run(randomUUID(), dev);
  const doid = randomUUID();
  db.prepare(`INSERT INTO orders (id, organization_id, status, total_amount) VALUES (?, ?, 'pago', 1000)`).run(doid, dev);
  db.prepare(`INSERT INTO order_items (id, order_id, organization_id, name_snapshot, unit_price, quantity, line_total, unit_cost) VALUES (?, ?, ?, 'P', 10, 100, 1000, 5)`).run(randomUUID(), doid, dev);
  L.recordLoss(dev, { driver: "devolucao", amount: 150 });
  const dd = D.monthly(dev, period).linhas;
  check("devolução vira linha própria (150)", near(dd.devolucoes, 150));
  check("devolução abate a receita líquida (1000 - 150 = 850)", near(dd.receitaLiquida, 850));

  // ===== 5. Disclaimer obrigatório =====
  check("disclaimer 'não substitui a contabilidade' presente", /não substitui a contabilidade/i.test(dre.disclaimer));

  // ===== 6. Org vazia: zerada, margem % null, sem quebrar + isolamento =====
  const empty = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Y', 'active')`).run(randomUUID(), empty);
  const de = D.monthly(empty, period);
  check("org vazia: receita 0 e margem % null", de.linhas.receitaBruta === 0 && de.linhas.margemPct === null);
  check("org vazia: resultado 0 (isolamento)", de.linhas.resultadoOperacional === 0 && de.linhas.sobra === 0);

  // ===== 7. LOJA FÍSICA (PDV) entra no DRE (antes zerava numa rede física) =====
  const rorg = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical) VALUES (?, ?, 'R', 'active', 'varejo')`).run(randomUUID(), rorg);
  const prod = randomUUID();
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name, price, active) VALUES (?, ?, 'product', 'Calça', 100, 1)`).run(prod, rorg);
  db.prepare(`INSERT INTO inventory_items (id, organization_id, product_service_id, quantity_available, avg_cost) VALUES (?, ?, ?, 10, 30)`).run(randomUUID(), rorg, prod);
  db.prepare(`INSERT INTO retail_pdv_sales (id, organization_id, filial, boleta, sale_date, valor, pecas, status) VALUES (?, ?, '1', 'B1', ?, 200, 2, 'N')`).run(randomUUID(), rorg, today);
  db.prepare(`INSERT INTO retail_pdv_sale_items (id, organization_id, filial, boleta, sale_date, item_seq, produto, quantidade, valor, product_service_id) VALUES (?, ?, '1', 'B1', ?, 1, 'REF', 2, 200, ?)`).run(randomUUID(), rorg, today, prod);
  const rr: any = D.monthly(rorg, period);
  check("7.1 DRE inclui receita da loja física (200)", near(rr.linhas.receitaBruta, 200));
  check("7.2 breakdown retail (200/60, source pdv)", near(rr.breakdown.retail.revenue, 200) && near(rr.breakdown.retail.cost, 60) && rr.breakdown.retail.source === "pdv");
  check("7.3 CMV inclui custo do varejo (2 × 30 = 60)", near(rr.linhas.cmv, 60));
  check("7.4 margem bruta = 200 - 60 = 140", near(rr.linhas.margemBruta, 140));
  check("7.5 custo 100% coberto → sem nota de varejo parcial", !rr.notas.varejo && rr.retailCostPartial === false);

  // 7b. item SEM custo conhecido → cobertura parcial → receita entra, nota avisa.
  const rorg2 = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical) VALUES (?, ?, 'R2', 'active', 'varejo')`).run(randomUUID(), rorg2);
  const prodNoCost = randomUUID();
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name, price, active) VALUES (?, ?, 'product', 'Blusa', 50, 1)`).run(prodNoCost, rorg2);
  db.prepare(`INSERT INTO retail_pdv_sales (id, organization_id, filial, boleta, sale_date, valor, pecas, status) VALUES (?, ?, '1', 'B9', ?, 150, 1, 'N')`).run(randomUUID(), rorg2, today);
  db.prepare(`INSERT INTO retail_pdv_sale_items (id, organization_id, filial, boleta, sale_date, item_seq, produto, quantidade, valor, product_service_id) VALUES (?, ?, '1', 'B9', ?, 1, 'REF2', 1, 150, ?)`).run(randomUUID(), rorg2, today, prodNoCost);
  const rr2: any = D.monthly(rorg2, period);
  check("7.6 receita física entra mesmo sem custo (150)", near(rr2.linhas.receitaBruta, 150));
  check("7.7 sem custo → CMV varejo 0, retailCostPartial + nota", near(rr2.breakdown.retail.cost, 0) && rr2.retailCostPartial === true && /parcial/i.test(rr2.notas.varejo || ""));

  // 7c. fechamento-only (sem PDV) → receita in, custo 0, parcial.
  const rorg3 = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical) VALUES (?, ?, 'R3', 'active', 'varejo')`).run(randomUUID(), rorg3);
  db.prepare(`INSERT INTO retail_daily_closings (id, organization_id, store_id, closing_date, status, informed_total) VALUES (?, ?, ?, ?, 'received', 800)`).run(randomUUID(), rorg3, randomUUID(), today);
  const rr3: any = D.monthly(rorg3, period);
  check("7.8 fechamento-only: receita 800 (source fechamento), custo 0, parcial", near(rr3.linhas.receitaBruta, 800) && rr3.breakdown.retail.source === "fechamento" && rr3.retailCostPartial === true);
  check("7.9 isolamento: org do core (1500) não recebeu varejo", near(l.receitaBruta, 1500) && (dre.breakdown.retail?.revenue || 0) === 0);

  // --- Relatório ---
  console.log("\n=== TEST: DRE Gerencial Simplificada (ADR-128 Fatia 1) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ DRE gerencial OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
