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

  // --- Relatório ---
  console.log("\n=== TEST: DRE Gerencial Simplificada (ADR-128 Fatia 1) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ DRE gerencial OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
