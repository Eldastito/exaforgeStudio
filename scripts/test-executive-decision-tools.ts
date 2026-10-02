/**
 * TESTE — PRD Fase 1 §24/§25 (S4b): `decision_analysis` pelo MOTOR EXISTENTE (DecisionEngine) e "Como está minha operação?" como
 * panorama composto, ambos como ferramentas do Diretor IA. Prova: extração do que o gestor disse (valor/entrada/prazo — a frase
 * exata do PRD); roteamento (decisão → motor; "Posso comprar R$ 180 mil?" puro segue no simulador; "como estão minhas lojas hoje"
 * segue em meta_do_dia); a análise NÃO afirma liquidez com caixa que é só venda registrada (diz que não sabe o saldo) e compara
 * entrada×caixa quando o saldo é real; não exibe cenários/upside inventados; não executa nada (0 decision_actions); baixo impacto
 * pula a análise profunda; dinheiro role-gated; panorama traz atenção/exceções/aprovações/estoque; isolamento por org; sem LLM.
 * Uso:  npm run test:executive-decision-tools
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-execdec-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-execdec-1234567890";

let failures = 0;
function check(name: string, ok: boolean, detail = "") { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` — ${detail}`}`); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const T = (await import("../src/server/ExecutiveDecisionTools.js")).ExecutiveDecisionTools;
  const Tools = (await import("../src/server/ExecutiveQueryToolsService.js")).ExecutiveQueryToolsService;
  const R = (await import("../src/server/ExecutiveQueryRouterService.js")).ExecutiveQueryRouterService;
  const { FinancialLedgerService: F } = await import("../src/server/FinancialLedgerService.js");
  const { BusinessSignalService } = await import("../src/server/BusinessSignalService.js");
  R.llmFn = async () => { throw new Error("sem LLM no teste"); };          // offline: devolve os fatos crus

  const mkOrg = () => { const id = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), id); return id; };
  const PRD = "Estou pensando em comprar R$ 180 mil de coleção. 30% de entrada e o restante em 60 dias. Vale a pena?";

  // ── extração ──
  const p = T.parse(PRD);
  check("a frase do PRD: compra 180.000, entrada 30%, prazo 60 dias (o '30' e o '60' não viram dinheiro)", p.amount === 180000 && p.downPct === 30 && p.termDays === 60 && p.downAmount === null);
  const p2 = T.parse("Quero comprar 180k, entrada de R$ 54 mil e o resto em 3 meses");
  check("entrada em R$ (não confunde com o valor da compra) e prazo em meses", p2.amount === 180000 && p2.downAmount === 54000 && p2.downPct === null && p2.termDays === 90);
  const p3 = T.parse("Estou pensando em investir R$ 50 mil em 4x");
  check("sem entrada/prazo: nada inventado; parcelas reconhecidas", p3.amount === 50000 && p3.downPct === null && p3.downAmount === null && p3.termDays === null && p3.installments === 4);
  check("sem valor: amount null", T.parse("vale a pena comprar mais estoque?").amount === null);

  // ── roteamento ──
  const A = mkOrg();
  check("decisão com condições → analisar_decisao (motor), não o simulador de estoque", R.detect(A, PRD)?.tool === "analisar_decisao");
  check("'Posso comprar R$ 180 mil em mercadoria?' (§25, sem condições) segue no simulador", R.detect(A, "Posso comprar R$ 180 mil em mercadoria?")?.tool === "simular_compra");
  check("'Como está minha operação?' → panorama_operacao", R.detect(A, "Como está minha operação?")?.tool === "panorama_operacao" && R.detect(A, "como anda o negócio hoje")?.tool === "panorama_operacao");
  check("'Como estão minhas lojas hoje?' continua em meta_do_dia; pergunta analítica não roteia", R.detect(A, "Como estão minhas lojas hoje?")?.tool === "meta_do_dia" && R.detect(A, "por que a operação caiu?") === null);

  // ── análise: caixa que NÃO é saldo ──
  const U = mkOrg(); F.recordEvent(U, { direction: "in", amount: 5000 });          // só entrada registrada ≠ saldo
  const before = (db.prepare(`SELECT COUNT(*) AS c FROM decision_actions WHERE organization_id = ?`).get(U) as any).c;
  const r = T.analisarDecisao(U, { text: PRD });
  const s = r.summary || "";
  check("resumo traz as condições: entrada R$ 54.000 e R$ 126.000 em 60 dias", /R\$ 180\.000/.test(s) && /R\$ 54\.000/.test(s) && /R\$ 126\.000/.test(s) && /60 dias/.test(s), s);
  check("caixa só de entradas: diz que NÃO sabe o saldo (não afirma que o caixa suporta)", /Não tenho o saldo real do caixa/.test(s) && !/Caixa hoje:/.test(s), s);
  check("não exibe cenários/upside inventados (não há retorno esperado informado)", !/Cenário base|upside|Agressivo/i.test(s) && /não projeto retorno/i.test(s), s);
  check("traz riscos (pré-mortem), premissa frágil (red team) e recomendação advisória do motor", /Riscos \(pré-mortem\)/.test(s) && /Premissas frágeis/.test(s) && /Recomendação \(advisória\)/.test(s), s);
  check("a recomendação NÃO contradiz o aviso: liquidez desconhecida em gasto grande = cautela (nunca 'sem riscos altos')", /Prosseguir com cautela/.test(s) && !/sem riscos altos/.test(s), s);
  check("é só apoio e NÃO executa nada (0 decision_actions criadas)", /análise de apoio/.test(s) && (db.prepare(`SELECT COUNT(*) AS c FROM decision_actions WHERE organization_id = ?`).get(U) as any).c === before);

  // ── análise: saldo real ──
  const S = mkOrg(); F.recordEvent(S, { direction: "in", amount: 60000 }); F.recordEvent(S, { direction: "out", amount: 10000 });   // saldo 50.000
  const s2 = T.analisarDecisao(S, { text: PRD }).summary || "";
  check("saldo real: compara a entrada com o caixa (R$ 54.000 > R$ 50.000 = 108%) e cita a previsão", /Caixa hoje: R\$ 50\.000/.test(s2) && /108%/.test(s2) && /previsão de caixa/.test(s2), s2);
  check("sem nenhuma conta a pagar cadastrada: não diz 'a pagar R$ 0' (diz que não há registro)", /não há contas a pagar cadastradas/.test(s2) && !/a pagar em aberto: R\$ 0/.test(s2), s2);
  check("saldo real e entrada maior que o caixa: recomendação com cautela/pressão de caixa", /cautela|Pressão de caixa/i.test(s2), s2);

  // ── limites ──
  check("sem valor: pergunta de volta (não chuta)", /Qual o valor/.test(T.analisarDecisao(S, { text: "vale a pena comprar?" }).clarify || ""));
  const low = T.analisarDecisao(S, { text: "Estou pensando em comprar R$ 300, 30% de entrada" }).summary || "";
  check("baixo impacto: o motor pula a análise profunda e diz isso", /Baixo impacto/.test(low) && !/Riscos \(pré-mortem\)/.test(low), low);

  // ── §73 dinheiro ──
  check("papel sem dinheiro não recebe nenhuma das duas ferramentas", Tools.run(S, "analisar_decisao", { text: PRD }, { canSeeMoney: false }).error === "forbidden_money" && Tools.run(S, "panorama_operacao", {}, { canSeeMoney: false }).error === "forbidden_money" && !Tools.list({ canSeeMoney: false }).some((t) => ["analisar_decisao", "panorama_operacao"].includes(t.name)));

  // ── ponta a ponta pelo roteador (sem LLM) ──
  const e2e = (await R.answer(U, PRD, { canSeeMoney: true })) || "";
  check("pelo roteador: a pergunta do PRD recebe a análise (sem LLM devolve os fatos)", /Análise da compra de R\$ 180\.000/.test(e2e), e2e);

  // ── panorama ──
  const P = mkOrg();
  const store = (org: string, name: string) => { const id = randomUUID(); db.prepare(`INSERT INTO retail_stores (id, organization_id, name, code) VALUES (?, ?, ?, ?)`).run(id, org, name, name.slice(0, 4)); return id; };
  const d = new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
  const bangu = store(P, "Bangu"), carioca = store(P, "Carioca");
  db.prepare(`INSERT INTO retail_store_quotas (id, organization_id, store_id, quota_date, quota_amount) VALUES (?, ?, ?, ?, 2000)`).run(randomUUID(), P, bangu, d);
  db.prepare(`INSERT INTO retail_store_quotas (id, organization_id, store_id, quota_date, quota_amount) VALUES (?, ?, ?, ?, 3000)`).run(randomUUID(), P, carioca, d);
  db.prepare(`INSERT INTO retail_schedule_entries (id, organization_id, store_id, work_date, seller_key, seller_name, status) VALUES (?, ?, ?, ?, 'mat:1', 'Ana', 'work')`).run(randomUUID(), P, carioca, d);
  db.prepare(`INSERT INTO retail_schedule_entries (id, organization_id, store_id, work_date, seller_key, seller_name, status) VALUES (?, ?, ?, date(?, '-5 days'), 'mat:2', 'Rui', 'work')`).run(randomUUID(), P, bangu, d);   // Bangu usa escala mas hoje está sem
  const calm = T.panoramaOperacao(P, d).summary || "";
  check("panorama traz as lojas de hoje e a exceção 'Bangu está sem escala' (e a operação sob controle quando nada exige ação)", /Panorama da operação/.test(calm) && /Bangu/.test(calm) && /Bangu está sem escala/.test(calm) && /sob controle/.test(calm), calm);
  BusinessSignalService.publish(P, { domain: "retail_ops", signalType: "retail_store_stockout", severity: "risk", basis: "fact", confidence: 0.9, impactAmount: 4, impactUnit: "units", sourceService: "test", sourceEntityType: "retail_store", sourceEntityId: bangu, evidence: { store: "Bangu", alerts: 4 }, dedupeKey: `t:stockout:${bangu}` } as any);
  const busy = T.panoramaOperacao(P, d);
  check("com um assunto aberto: 'precisa de atenção' (nunca 'sob controle' ao mesmo tempo)", /precisa de atenção/.test(busy.summary || "") && !/sob controle/.test(busy.summary || "") && busy.data.atencao >= 1, busy.summary);
  const empty = T.panoramaOperacao(mkOrg()).summary || "";
  check("org sem dados: não inventa (nem 'sob controle' sem saber)", !/Bangu|sob controle/.test(empty) || /Nenhuma ação humana/.test(empty));
  check("isolamento: o panorama da org A não vê lojas/exceções da P", !/Bangu|Carioca/.test(T.panoramaOperacao(U).summary || ""));

  console.log(failures ? `\n${failures} FALHA(S)` : "\nTodas as verificações OK");
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
