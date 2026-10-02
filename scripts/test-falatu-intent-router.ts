/**
 * TESTE — Fase 2 / F2.1 (ADR-203): roteador de intenções do FalaTu.
 * Prova: (1) as 19 frases obrigatórias do PRD (§8/§45) caem numa FERRAMENTA determinística (antes: 9 sem rota, 2 misroteadas);
 * (2) a frase-âncora ("comprar R$ 180 mil… fornecedor quer 30% de entrada… analisa") vira ANÁLISE DE DECISÃO — nunca lançamento de
 * despesa — e "crie uma campanha…" nunca vira análise de decisão; registros explícitos de despesa continuam sendo registro;
 * (3) "90 dias"/"30%" não são dinheiro; (4) as ferramentas novas são honestas: produtos parados só com giro MEDIDO (S9), ranking de
 * lojas só sobre fechamento enviado, campanha é PRÉVIA (não cria nem envia); (5) a venda "até agora" carrega o carimbo de frescor do
 * PDV ("último dado às HH:MM", ATRASADO quando passa de 90 min); (6) dinheiro role-gated; (7) isolamento por org; sem LLM.
 * Uso:  npm run test:falatu-intent-router
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-f21-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-falatu-intent-1234567890";

let failures = 0;
function check(name: string, ok: boolean, detail = "") { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` — ${detail}`}`); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const R = (await import("../src/server/ExecutiveQueryRouterService.js")).ExecutiveQueryRouterService;
  const T = (await import("../src/server/ExecutiveQueryToolsService.js")).ExecutiveQueryToolsService;
  const F = (await import("../src/server/FalaTuAskService.js")).FalaTuAskService;
  const { hasMoneyMarker, isDecisionInquiry, isCampaignRequest, inactiveDaysFrom } = await import("../src/server/ConversationalIntentRules.js");
  const { PermissionService: P } = await import("../src/server/PermissionService.js");
  const { RetailMonthlyGoalService: G } = await import("../src/server/RetailMonthlyGoalService.js");
  R.llmFn = async () => "";   // sem LLM: a resposta é o fato do sistema

  const mkOrg = () => { const id = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), id); return id; };
  const A = mkOrg(), O = mkOrg();
  P.seedSystemProfiles(A);
  const owner = { id: "u1", userId: "u1", role: "owner" };
  const mkStore = (org: string, name: string, code: string) => { const id = randomUUID(); db.prepare(`INSERT INTO retail_stores (id, organization_id, name, code) VALUES (?, ?, ?, ?)`).run(id, org, name, code); return id; };
  const grande = mkStore(A, "Grande Rio", "2001"), carioca = mkStore(A, "Carioca", "2002"), bangu = mkStore(A, "Bangu", "2003"), nova = mkStore(A, "Nova Iguaçu", "2004");

  // ── (1) as 19 frases do PRD → ferramenta ──
  const table: Array<[string, string]> = [
    ["Como estão minhas lojas hoje?", "meta_do_dia"], ["Quem não bate meta há dois meses?", "vendedores_abaixo_meta"],
    ["Quanto falta para a Grande Rio?", "meta_do_dia"], ["Qual loja está com pior desempenho?", "ranking_lojas"],
    ["Quem vendeu mais esta semana?", "ranking_vendedores"], ["Tem problema no estoque?", "divergencia_estoque"],
    ["Quanto vendemos em dinheiro?", "dinheiro_do_dia"], ["Como fechou ontem?", "vendas_por_loja"],
    ["Estou pensando em comprar R$180 mil de coleção. O fornecedor quer 30% de entrada e o restante em 60 dias. Analisa para mim.", "analisar_decisao"],
    ["Como estão minhas lojas?", "meta_do_dia"], ["Quanto a Carioca precisa vender hoje?", "meta_do_dia"],
    ["Quem está no segundo mês sem bater meta?", "vendedores_abaixo_meta"], ["Como foi a semana?", "vendas_por_loja"],
    ["Tem alguém abaixo da meta?", "metas_abaixo_cota"], ["Qual foi a venda em dinheiro?", "dinheiro_do_dia"],
    ["O que está acontecendo na Grande Rio?", "meta_do_dia"], ["Posso comprar R$180 mil de coleção?", "simular_compra"],
    ["Crie uma campanha para quem não compra há 90 dias.", "proposta_campanha"], ["Mostra os produtos parados.", "produtos_parados"],
  ];
  const bad = table.filter(([q, tool]) => R.detect(A, q)?.tool !== tool).map(([q, t]) => `${q.slice(0, 40)}→${R.detect(A, q)?.tool}≠${t}`);
  check(`as 19 frases do PRD caem na ferramenta certa (antes: 9 sem rota + 2 misroteadas)`, bad.length === 0, bad.join(" | "));
  check("'Quanto a Carioca precisa vender hoje' e 'o que acontece na Grande Rio' carregam a LOJA certa", R.detect(A, "Quanto a Carioca precisa vender hoje?")?.args.store === "Carioca" && R.detect(A, "O que está acontecendo na Grande Rio?")?.args.store === "Grande Rio");
  check("'Qual a melhor loja?' inverte a ordem; 'qual vendedor vendeu mais' continua em ranking_vendedores (0-regressão)", R.detect(A, "Qual a melhor loja do mês?")?.args.best === true && R.detect(A, "Qual vendedor vendeu mais esta semana?")?.tool === "ranking_vendedores");
  check("campanha: dias vêm da frase ('há 90 dias' → 90)", R.detect(A, "Crie uma campanha para quem não compra há 90 dias.")?.args.days === 90);

  // ── (2)(3) regras puras + FalaTu ──
  check("'90 dias' e '30%' NÃO são dinheiro; 'R$ 180 mil', '180k' e '1.500' são", !hasMoneyMarker("não compra há 90 dias") && !hasMoneyMarker("30% de entrada") && hasMoneyMarker("R$ 180 mil") && hasMoneyMarker("180k") && hasMoneyMarker("1.500"));
  check("decisão: a âncora é; 'Posso comprar R$ 180 mil?' puro NÃO é (segue no simulador); registro explícito NÃO é", isDecisionInquiry("Estou pensando em comprar R$180 mil de coleção. O fornecedor quer 30% de entrada. Analisa.") && !isDecisionInquiry("Posso comprar R$180 mil de coleção?") && !isDecisionInquiry("lança a despesa de R$ 5 mil, compra de tecido, 30 dias"));
  check("campanha é detectada e nunca é decisão", isCampaignRequest("Crie uma campanha para quem não compra há 90 dias") && !isDecisionInquiry("Crie uma campanha para quem não compra há 90 dias") && inactiveDaysFrom("há 90 dias") === 90 && inactiveDaysFrom("clientes antigos") === null);
  const today = "2026-10-02";
  check("FalaTu: a âncora é open_question (decisão), NÃO record_expense", F.classify("Estou pensando em comprar R$180 mil de coleção. O fornecedor quer 30% de entrada e o restante em 60 dias. Analisa para mim.", today).kind === "open_question");
  check("FalaTu: registro de despesa explícito continua registro (0-regressão)", F.classify("lança a despesa de R$200 com o fornecedor Silva", today).kind === "record_expense" && F.classify("paguei R$ 500 de boleto do fornecedor", today).kind === "record_expense");
  const dec = await F.answer(A, owner, "Estou pensando em comprar R$180 mil de coleção. O fornecedor quer 30% de entrada e o restante em 60 dias. Analisa para mim.", { now: new Date("2026-10-02T15:00:00Z") });
  check("ponta a ponta: a âncora devolve a análise de decisão (valor/entrada) e NÃO grava despesa nem ação", dec.kind === "open_question" && /180/.test(dec.answer) && /(entrada|54)/i.test(dec.answer) && (db.prepare(`SELECT COUNT(*) c FROM decision_actions WHERE organization_id = ?`).get(A) as any).c === 0, dec.answer.slice(0, 200));

  // ── (4a) produtos parados — honestidade do giro ──
  const inv = (org: string, pid: string, qty: number, cost: number) => db.prepare(`INSERT INTO inventory_items (id, organization_id, product_service_id, quantity_available, avg_cost) VALUES (?, ?, ?, ?, ?)`).run(randomUUID(), org, pid, qty, cost);
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name, price, active, stock_control_enabled) VALUES ('pa', ?, 'product', 'Malha', 100, 1, 1)`).run(A);
  inv(A, "pa", 91, 29.85); inv(A, "pb", 10, 0);
  const pp1 = T.run(A, "produtos_parados", {}, { canSeeMoney: true }) as any;
  check("sem saídas registradas: NÃO lista 'parados' — diz que o giro não é medido (S9)", /Não consigo afirmar o que está parado/.test(pp1.summary) && /não prova "sem venda"/.test(pp1.summary) && pp1.data.giroMeasured === false, pp1.summary);
  db.prepare(`INSERT INTO stock_movements (id, organization_id, product_service_id, type, quantity) VALUES (?, ?, 'pVende', 'saida', 1)`).run(randomUUID(), A);
  const pp2 = T.run(A, "produtos_parados", {}, { canSeeMoney: true }) as any;
  check("com saídas registradas: lista os parados; item sem custo mostra '—', não R$ 0,00", /Malha|pa/.test(pp2.summary) && /sem custo cadastrado/.test(pp2.summary) && !/R\$ 0\b/.test(pp2.summary.split("pb")[0] || "") && pp2.data.giroMeasured === true, pp2.summary);

  // ── (4b) ranking de lojas ──
  const month = new Date().toISOString().slice(0, 7);
  const dayNow = Number(new Date().toISOString().slice(8, 10));
  G.set(A, { storeId: grande, month, goalAmount: 100000 }); G.set(A, { storeId: carioca, month, goalAmount: 60000 }); G.set(A, { storeId: bangu, month, goalAmount: 80000 });
  const cl = (st: string, d: string, v: number) => db.prepare(`INSERT INTO retail_daily_closings (id, organization_id, store_id, closing_date, status, informed_total, system_total) VALUES (?, ?, ?, ?, 'received', ?, 0)`).run(randomUUID(), A, st, d, v);
  const d1 = `${month}-01`;
  cl(grande, d1, 20000); cl(carioca, d1, 30000);   // Grande 20% · Carioca 50% · Bangu sem fechamento · Nova sem meta
  const rk: any = T.run(A, "ranking_lojas", {}, { canSeeMoney: true });
  if (dayNow <= 1) { check("1º dia do mês: diz que ainda não há fechamento (não compara)", /1º dia/.test(rk.summary)); }
  else {
    check("ranking: pior primeiro (Grande Rio 20% antes de Carioca 50%) e só fechamento enviado", rk.data.ranked[0].name === "Grande Rio" && rk.data.ranked[0].pct === 20 && rk.data.ranked[1].pct === 50 && /só fechamentos já enviados/.test(rk.summary), rk.summary);
    check("ranking: Bangu (meta, sem fechamento) e Nova Iguaçu (sem meta) vão À PARTE — nunca 0%", /Sem fechamento enviado no mês: Bangu/.test(rk.summary) && /Sem meta mensal cadastrada: Nova Iguaçu/.test(rk.summary) && !rk.data.ranked.some((r: any) => r.name === "Bangu"));
    check("ranking: 'melhores' inverte; avisa que dia sem fechamento não é venda zero", (T.run(A, "ranking_lojas", { best: true }, { canSeeMoney: true }) as any).data.ranked[0].name === "Carioca" && /não conta como venda zero/.test(rk.summary));
  }

  // ── (4c) campanha = prévia ──
  const ct = (org: string, name: string, ident: string, count: number, last: string | null, optOut = 0) =>
    db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier, purchase_count, last_purchase_at, marketing_opt_out) VALUES (?, ?, 'ch', ?, ?, ?, ?, ?)`).run(randomUUID(), org, name, ident, count, last, optOut);
  ct(A, "Ana", "5521900000001", 3, "2026-05-01"); ct(A, "Bia", "5521900000002", 1, "2026-06-01"); ct(A, "Caio", "5521900000003", 2, "2026-05-10", 1);   // opt-out
  ct(A, "Duda", "", 2, "2026-04-01"); ct(A, "Edu", "5521900000005", 0, null); ct(A, "Fábio", "5521900000006", 2, new Date().toISOString().slice(0, 10)); ct(O, "Outra", "5521911111111", 5, "2026-01-01");
  const before = (db.prepare(`SELECT COUNT(*) c FROM campaigns WHERE organization_id = ?`).get(A) as any).c;
  const cp: any = T.run(A, "proposta_campanha", { days: 90 }, { canSeeMoney: false });
  check("campanha: conta SÓ quem comprou e está há >90 dias, com contato válido e sem opt-out (Ana, Bia = 2)", cp.data.audience === 2 && /Encontrei 2 cliente/.test(cp.summary), cp.summary);
  check("campanha é PRÉVIA: nada criado, nada enviado, e o texto diz isso; não é ferramenta de dinheiro", (db.prepare(`SELECT COUNT(*) c FROM campaigns WHERE organization_id = ?`).get(A) as any).c === before && /Nada foi criado nem enviado/.test(cp.summary));
  check("campanha sem dias: pergunta 'há quantos dias' (não chuta); isolamento: outra org vê o seu público", /há quantos dias/.test((T.run(A, "proposta_campanha", {}, {}) as any).clarify) && (T.run(O, "proposta_campanha", { days: 90 }, {}) as any).data.audience === 1);

  // ── (5) frescor do PDV ──
  const pdvSale = (org: string, filial: string) => db.prepare(`INSERT INTO retail_pdv_sales (id, organization_id, filial, boleta, sale_date, sale_time, valor, pecas, status, payments_json) VALUES (?, ?, ?, ?, ?, '10:00', 100, 1, 'N', NULL)`).run(randomUUID(), org, filial, `b${Math.random()}`, new Date().toISOString().slice(0, 10));
  pdvSale(A, "2001");
  const md0: any = T.run(A, "meta_do_dia", { store: "Grande Rio" }, { canSeeMoney: true });
  check("sem sincronização do PDV registrada: sem carimbo (org sem PDV não vira 'atrasado')", !/Último dado do PDV/.test(md0.summary));
  const cur = (when: string) => { db.prepare(`DELETE FROM alterdata_sync_cursors WHERE organization_id = ?`).run(A); db.prepare(`INSERT INTO alterdata_sync_cursors (id, organization_id, module, resource, last_synced_at) VALUES (?, ?, 'sales', 'VendaMalote', ?)`).run(randomUUID(), A, when); };
  const iso = (minAgo: number) => new Date(Date.now() - minAgo * 60_000).toISOString().replace("T", " ").slice(0, 19);
  cur(iso(10));
  const mdF: any = T.run(A, "meta_do_dia", { store: "Grande Rio" }, { canSeeMoney: true });
  check("PDV sincronizado há 10 min: 'Último dado do PDV confirmado às HH:MM', sem ATRASADO", /Último dado do PDV confirmado às \d{2}:\d{2}/.test(mdF.summary) && !/ATRASADO/.test(mdF.summary), mdF.summary);
  cur(iso(180));
  const mdS: any = T.run(A, "meta_do_dia", { store: "Grande Rio" }, { canSeeMoney: true });
  check("PDV há 3h: ATRASADO — a venda de agora pode estar maior que a mostrada", /ATRASADO/.test(mdS.summary), mdS.summary);
  check("o mesmo vale para 'dinheiro do dia'", /Último dado do PDV confirmado às/.test((T.run(A, "dinheiro_do_dia", { store: "Grande Rio" }, { canSeeMoney: true }) as any).summary));

  // ── (6) dinheiro role-gated · (7) isolamento ──
  check("papel sem dinheiro: ranking_lojas e produtos_parados barrados; proposta_campanha (sem R$) liberada", (T.run(A, "ranking_lojas", {}, { canSeeMoney: false }) as any).error === "forbidden_money" && (T.run(A, "produtos_parados", {}, { canSeeMoney: false }) as any).error === "forbidden_money" && (T.run(A, "proposta_campanha", { days: 90 }, { canSeeMoney: false }) as any).error !== "forbidden_money");
  check("isolamento: ranking/produtos da org O não enxergam a A", /Não há loja ativa/.test((T.run(O, "ranking_lojas", {}, { canSeeMoney: true }) as any).summary) && /Não há estoque/.test((T.run(O, "produtos_parados", {}, { canSeeMoney: true }) as any).summary));

  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (failures) { console.log(`\n${failures} FALHA(S)`); process.exit(1); }
  console.log("\nTODOS OS CHECKS PASSARAM");
}
main().catch((e) => { console.error(e); process.exit(1); });
