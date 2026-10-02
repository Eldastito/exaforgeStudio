/**
 * TESTE — PRD Fase 1, F1.7b: as perguntas simples do gestor viram FERRAMENTAS do Diretor IA (determinísticas).
 * Prova as 8 perguntas do PRD roteando SEM LLM para a ferramenta certa e respondendo com o número do sistema:
 * "quanto falta pra Grande Rio bater a meta" · "quais lojas estão abaixo da meta hoje" · "como estão minhas lojas
 * hoje" · "quanto vendemos em dinheiro hoje" · "quem está há dois meses sem bater meta" · "qual vendedor vendeu mais
 * esta semana" · "tenho alguma divergência de estoque" · "posso comprar R$ 180 mil". Honestidade: sem fechamento =
 * "aguardando" (nunca R$ 0), parcial do caixa rotulado, total com loja sem dado não é total, sem dado de giro o
 * simulador diz que não sabe, entrada/prazo declarados como NÃO modelados; §73 (dinheiro só com permissão);
 * "por que caiu?" continua NÃO roteando (é do panorama); isolamento multi-tenant.
 * Uso:  npm run test:retail-questions
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-retailq-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-retailq-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const R = (await import("../src/server/ExecutiveQueryRouterService.js")).ExecutiveQueryRouterService;
  const { parseMoneyPt } = await import("../src/server/RetailQuestionTools.js");
  const Tools = (await import("../src/server/ExecutiveQueryToolsService.js")).ExecutiveQueryToolsService;

  const tz = process.env.TZ_DISPLAY || "America/Sao_Paulo";
  const hoje = new Date().toLocaleDateString("en-CA", { timeZone: tz });
  R.llmFn = async () => { throw new Error("LLM fora do ar"); };            // prova: nada aqui depende de LLM (devolve os fatos crus)

  const A = `org_A_${randomUUID().slice(0, 6)}`, B = `org_B_${randomUUID().slice(0, 6)}`;
  for (const o of [A, B]) db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), o);
  const store = (org: string, name: string, code: string) => { const id = randomUUID(); db.prepare(`INSERT INTO retail_stores (id, organization_id, name, code, active) VALUES (?, ?, ?, ?, 1)`).run(id, org, name, code); return id; };
  const grande = store(A, "Grande Rio", "3001"), carioca = store(A, "Carioca", "3002"), bangu = store(A, "Bangu", "3003"); store(B, "Loja B", "9001");
  const quota = (org: string, st: string, v: number) => db.prepare(`INSERT INTO retail_store_quotas (id, organization_id, store_id, quota_date, quota_amount) VALUES (?, ?, ?, ?, ?)`).run(randomUUID(), org, st, hoje, v);
  quota(A, grande, 2500); quota(A, carioca, 1000); quota(A, bangu, 800);
  db.prepare(`INSERT INTO retail_daily_closings (id, organization_id, store_id, closing_date, status, informed_total, details_json) VALUES (?, ?, ?, ?, 'received', 1100, ?)`).run(randomUUID(), A, carioca, hoje, JSON.stringify({ dinheiro: 300 }));   // Carioca já fechou
  let n = 0;
  const pdv = (filial: string, valor: number, cash: number) => db.prepare(`INSERT INTO retail_pdv_sales (id, organization_id, filial, boleta, sale_date, sale_time, valor, pecas, status, payments_json) VALUES (?, ?, ?, ?, ?, '10:00', ?, 1, 'N', ?)`).run(randomUUID(), A, filial, `b${++n}`, hoje, valor, JSON.stringify({ dinheiro: cash }));
  pdv("3001", 1050, 280);                                                   // Grande Rio: só caixa parcial; Bangu: nada

  const ask = (q: string, money = true) => R.answer(A, q, { canSeeMoney: money });
  const pick = (q: string) => R.detect(A, q)?.tool;

  check("roteia as 8 perguntas do PRD para a ferramenta certa, SEM LLM", pick("Quanto falta pra Grande Rio bater a meta?") === "meta_do_dia" && pick("Quais lojas estão abaixo da meta hoje?") === "meta_do_dia" && pick("Como estão minhas lojas hoje?") === "meta_do_dia" && pick("Quanto vendemos em dinheiro hoje?") === "dinheiro_do_dia" && pick("Quem está há dois meses sem bater meta?") === "vendedores_abaixo_meta" && pick("Qual vendedor vendeu mais esta semana?") === "ranking_vendedores" && pick("Tenho alguma divergência de estoque?") === "divergencia_estoque" && pick("Posso comprar R$ 180 mil?") === "simular_compra");
  check("'dinheiro em caixa' continua indo para o caixa (não virou venda em dinheiro)", pick("quanto tenho de dinheiro em caixa") === "caixa_resumo");
  check("'por que as vendas caíram?' NÃO roteia (análise de causa é do panorama)", pick("por que as vendas caíram?") === undefined);

  const meta = (await ask("Quanto falta pra Grande Rio bater a meta?"))!;
  check("Grande Rio: vendeu 1.050 (parcial do caixa, rotulado) de 2.500 → falta 1.450", /Grande Rio: vendeu R\$ 1\.050 de R\$ 2\.500 — falta R\$ 1\.450 \(parcial do caixa, não é o fechamento\)/.test(meta) && !/Carioca/.test(meta), meta);
  const lojas = (await ask("Como estão minhas lojas hoje?"))!;
  check("todas as lojas: Carioca fechamento 1.100/1.000 = META BATIDA; Grande Rio parcial", /Carioca: vendeu R\$ 1\.100 de R\$ 1\.000 — META BATIDA \(fechamento\)/.test(lojas) && /Grande Rio: vendeu/.test(lojas), lojas);
  check("HONESTIDADE: Bangu sem venda = 'sem venda disponível' + cota, nunca R$ 0", /Bangu: ainda sem venda disponível/.test(lojas) && /cota R\$ 800/.test(lojas) && !/R\$ 0,00/.test(lojas));

  const cash = (await ask("Quanto vendemos em dinheiro hoje?"))!;
  check("dinheiro: Carioca 300 (fechamento), Grande Rio 280 (caixa parcial)", /Carioca: R\$ 300 \(fechamento\)/.test(cash) && /Grande Rio: R\$ 280 \(caixa, parcial\)/.test(cash), cash);
  check("HONESTIDADE: com Bangu sem dado o total NÃO é total (parcial 580 à parte)", /Total NÃO calculado/.test(cash) && /R\$ 580/.test(cash) && !/Total em dinheiro/.test(cash));

  // vendedores: 2 meses seguidos abaixo da meta (mês anterior e retrasado)
  const pm = (k: number) => { const d = new Date(`${hoje}T12:00:00Z`); d.setUTCMonth(d.getUTCMonth() - k, 15); return d.toISOString().slice(0, 10); };
  const seller = (mat: string, name: string) => db.prepare(`INSERT INTO retail_sellers (id, organization_id, matricula, name) VALUES (?, ?, ?, ?)`).run(randomUUID(), A, mat, name);
  seller("501", "Paulo Alves"); seller("502", "Marina Souza");
  const weekQuota = (mat: string, date: string, q: number) => db.prepare(`INSERT INTO retail_seller_quotas (id, organization_id, store_id, seller_key, seller_name, week_start, quota_amount) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(randomUUID(), A, grande, mat, mat, date, q);
  const sale = (mat: string, date: string, v: number) => db.prepare(`INSERT INTO retail_seller_sales (id, organization_id, store_id, seller_name, matricula, sale_date, valor, pecas) VALUES (?, ?, ?, ?, ?, ?, ?, 1)`).run(randomUUID(), A, grande, mat, mat, date, v);
  void pm; void weekQuota; void sale;
  const streak = (await ask("Quem está há dois meses sem bater meta?"))!;
  check("vendedores sem meta/sem histórico: responde honesto (ninguém), nunca inventa nome", /Ninguém está há 2\+ meses seguidos abaixo da meta/.test(streak) && !/Paulo|Marina/.test(streak), streak);

  const rank = (await ask("Qual vendedor vendeu mais esta semana?"))!;
  check("ranking sem vendas por vendedor: diz que não há, sem inventar", /Sem vendas por vendedor registradas/.test(rank), rank);
  sale("501", hoje, 900); sale("502", hoje, 1500);
  const rank2 = (await ask("Qual vendedor vendeu mais esta semana?"))!;
  check("ranking com vendas: ordena (Marina 1.500 antes de Paulo 900)", rank2.indexOf("Marina") > -1 && rank2.indexOf("Marina") < rank2.indexOf("Paulo") && /R\$ 1\.500/.test(rank2), rank2);

  // estoque
  const none = (await ask("Tenho alguma divergência de estoque?"))!;
  check("sem saldo negativo: 'nenhum item' (não 'sim')", /Nenhum item com saldo negativo/.test(none), none);
  const prod = randomUUID(); db.prepare(`INSERT INTO products_services (id, organization_id, type, name, price, active, stock_control_enabled) VALUES (?, ?, 'product', 'Camisa', 50, 1, 1)`).run(prod, A);
  db.prepare(`INSERT INTO retail_store_inventory (id, organization_id, store_id, product_service_id, variant_id, quantity_available) VALUES (?, ?, ?, ?, '', -2)`).run(randomUUID(), A, carioca, prod);
  const div = (await ask("Tenho alguma divergência de estoque?"))!;
  check("com negativo: 'Sim — N ocorrência(s) em M loja(s)' agrupado por causa (F1.3)", /^Sim — 1 ocorrência em 1 loja/.test(div) && /Produto sem nenhuma entrada/.test(div), div);

  // posso comprar
  const buy = (await ask("Posso comprar R$ 180 mil em mercadoria?"))!;
  check("'Posso comprar?' usa o simulador: sem dado de giro diz que não sabe (não finge cobertura)", /Ainda não tenho velocidade de venda/.test(buy), buy);
  // S4b (PRD §24): com entrada/prazo a pergunta é uma DECISÃO → motor de decisão (analisar_decisao), que trata entrada e prazo como condições
  // declaradas em vez de "não modelados" (o simulador de estoque só vê o total). Ver test:executive-decision-tools.
  check("com entrada e prazo a pergunta vira análise de decisão (não o simulador)", R.detect(A, "Posso comprar R$ 180 mil, com 30% de entrada e 60 dias?")?.tool === "analisar_decisao" && R.detect(A, "Posso comprar R$ 180 mil em mercadoria?")?.tool === "simular_compra");
  check("sem valor: pergunta de volta (não chuta)", /Qual o valor da compra/.test((await ask("Posso comprar estoque agora?"))!));
  check("parseMoneyPt: R$ 180 mil · 180k · R$ 180.000,50 · 1,5 milhão", parseMoneyPt("R$ 180 mil") === 180000 && parseMoneyPt("180k") === 180000 && parseMoneyPt("R$ 180.000,50") === 180000.5 && parseMoneyPt("1,5 milhão") === 1500000 && parseMoneyPt("sem número") === null);

  // §73 + isolamento
  check("§73: papel sem dinheiro não recebe venda em dinheiro/meta (cai no panorama = null); divergência de estoque (sem R$) responde", (await ask("Quanto vendemos em dinheiro hoje?", false)) === null && (await ask("Quanto falta pra Grande Rio bater a meta?", false)) === null && /Sim — /.test((await ask("Tenho alguma divergência de estoque?", false)) || ""));
  check("cardápio do papel sem dinheiro só oferece divergencia_estoque entre as novas", Tools.list({ canSeeMoney: false }).filter((t) => ["meta_do_dia", "dinheiro_do_dia", "vendedores_abaixo_meta", "ranking_vendedores", "divergencia_estoque", "simular_compra"].includes(t.name)).map((t) => t.name).join() === "divergencia_estoque");
  const bMeta = (await R.answer(B, "Como estão minhas lojas hoje?", { canSeeMoney: true })) || "";
  check("isolamento: a org B não vê lojas/cotas da A", /Loja B/.test(bMeta) && !/Grande Rio|Carioca|Bangu/.test(bMeta), bMeta);

  console.log("\n=== PRD Fase 1 · F1.7b: perguntas simples do gestor ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
