/**
 * RetailQuestionTools — as perguntas simples do gestor (PRD Fase 1, F1.7b) como FERRAMENTAS do Diretor IA.
 *
 * "Quanto falta pra Grande Rio bater a meta?", "Quanto vendemos em dinheiro hoje?", "Quem está há dois meses sem
 * bater meta?", "Qual vendedor vendeu mais esta semana?", "Tenho alguma divergência de estoque?", "Posso comprar
 * R$ 180 mil?". Cada uma é CÓDIGO determinístico sobre serviços que já existem (nada novo calculado aqui) e plugada
 * no cardápio `ExecutiveQueryToolsService` / roteador `ExecutiveQueryRouterService` — o LLM só formata a resposta,
 * nunca calcula (RN-DIR-1/6). Sem motor, tabela ou rota nova.
 *
 * Honestidade (F1.0): sem fechamento = "aguardando" (nunca vendeu R$ 0); parcial do caixa vem rotulado; total com
 * loja sem dado não é total; sem cota = "—". "Posso comprar?" usa o simulador de estoque (ADR-133) e diz o que NÃO
 * entra na conta (entrada/prazo) em vez de fingir que entrou.
 */
import { RetailDayBriefService } from "./RetailDayBriefService.js";
import { RetailAfternoonBriefService } from "./RetailAfternoonBriefService.js";
import { SellerGoalStreakService } from "./SellerGoalStreakService.js";
import { RetailSellerSalesService } from "./RetailSellerSalesService.js";
import { NegativeStockDiagnosisService } from "./NegativeStockDiagnosisService.js";
import { DecisionSimulatorService } from "./DecisionSimulatorService.js";
import { combineMetrics, formatMetric, known, type Metric } from "../lib/metric.js";

type Res = { ok: boolean; tool: string; summary?: string; data?: any; clarify?: string };
type Store = { id: string; name: string } | null | undefined;

const brl = (m: Metric | number) => formatMetric(typeof m === "number" ? known(m, { unit: "brl" }) : m, { unit: "brl" }).replace(/,00(?=$| —)/, "");

/** "R$ 180 mil", "180k", "R$ 180.000,50", "1,5 milhão" → número (null se não achar). */
export function parseMoneyPt(text: string): number | null {
  const t = String(text || "").toLowerCase().replace(/r\$\s*/g, "");
  const mil = t.match(/(\d+(?:[.,]\d+)?)\s*(milh(?:ao|ão|oes|ões)|mi\b|mil\b|k\b)/);
  if (mil) {
    const base = Number(mil[1].replace(",", "."));
    const mult = /^milh/.test(mil[2]) || mil[2] === "mi" ? 1_000_000 : 1_000;   // "mil" NÃO é "mi": R$ 180 mil = 180.000
    return Number.isFinite(base) ? Math.round(base * mult * 100) / 100 : null;
  }
  const n = t.match(/(\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+(?:,\d{1,2})?)/);
  if (!n) return null;
  const v = Number(n[1].replace(/\./g, "").replace(",", "."));
  return Number.isFinite(v) && v > 0 ? v : null;
}

export class RetailQuestionTools {
  /** Vendido "até agora" por loja: fechamento (folha) quando existe; senão parcial do caixa (rotulado); senão nada. */
  private static today(orgId: string, date: string) {
    const night = RetailDayBriefService.nightSnapshot(orgId, date);
    const pdv = RetailAfternoonBriefService.snapshot(orgId, date, { cutoffHour: 24 });
    return night.stores.map((s) => {
      const p = pdv.stores.find((x) => x.storeId === s.storeId);
      const official = s.venda.state === "value";
      const vendido: Metric = official ? s.venda : (p?.vendido.state === "value" ? p.vendido : s.venda);
      const dinheiro: Metric = s.dinheiro.state === "value" ? s.dinheiro : (p?.dinheiro?.state === "value" ? p.dinheiro : s.dinheiro);
      return { storeId: s.storeId, storeName: s.storeName, cota: s.cota, vendido, dinheiro, basis: official ? "fechamento" : (p?.vendido.state === "value" ? "caixa (parcial)" : "none") as "fechamento" | "caixa (parcial)" | "none" };
    });
  }

  /** "Quanto falta pra X bater a meta?" · "Quais lojas estão abaixo da meta hoje?" · "Como estão minhas lojas hoje?" */
  static metaDoDia(orgId: string, date: string, store?: Store): Res {
    let rows = this.today(orgId, date);
    if (store) rows = rows.filter((r) => r.storeId === store.id);
    if (!rows.length) return { ok: true, tool: "meta_do_dia", summary: "Não há loja ativa cadastrada." };
    const lines = rows.map((r) => {
      const cota = r.cota.state === "value" ? (r.cota.value as number) : null;
      const v = r.vendido.state === "value" ? (r.vendido.value as number) : null;
      if (v === null) return `- ${r.storeName}: ainda sem venda disponível (${r.vendido.reason || "aguardando fechamento"})${cota !== null ? ` · cota ${brl(cota)}` : " · cota não cadastrada"}.`;
      const tag = r.basis === "fechamento" ? "fechamento" : "parcial do caixa, não é o fechamento";
      if (cota === null) return `- ${r.storeName}: vendeu ${brl(v)} (${tag}) · cota do dia não cadastrada.`;
      if (cota === 0) return `- ${r.storeName}: vendeu ${brl(v)} (${tag}) · sem meta no dia.`;
      return v >= cota
        ? `- ${r.storeName}: vendeu ${brl(v)} de ${brl(cota)} — META BATIDA (${tag}).`
        : `- ${r.storeName}: vendeu ${brl(v)} de ${brl(cota)} — falta ${brl(Math.round((cota - v) * 100) / 100)} (${tag}).`;
    });
    return { ok: true, tool: "meta_do_dia", data: { date, rows }, summary: `Meta do dia ${date.slice(8, 10)}/${date.slice(5, 7)} por loja:\n${lines.join("\n")}` };
  }

  /** "Quanto vendemos em dinheiro hoje?" */
  static dinheiroDoDia(orgId: string, date: string, store?: Store): Res {
    let rows = this.today(orgId, date);
    if (store) rows = rows.filter((r) => r.storeId === store.id);
    const lines = rows.map((r) => `- ${r.storeName}: ${r.dinheiro.state === "value" ? `${brl(r.dinheiro)} (${r.basis === "fechamento" ? "fechamento" : "caixa, parcial"})` : `sem dado (${r.dinheiro.reason || "aguardando fechamento"})`}`);
    const tot = combineMetrics(rows.map((r) => r.dinheiro), { unit: "brl" });
    const total = rows.length > 1
      ? (tot.fact.state === "value" ? `\nTotal em dinheiro: ${brl(tot.fact)}.` : (tot.partialFact !== null ? `\nTotal NÃO calculado (há loja sem dado); só das lojas com dado: ${brl(tot.partialFact)}.` : ""))
      : "";
    return { ok: true, tool: "dinheiro_do_dia", data: { date, rows }, summary: `Venda em dinheiro, ${date.slice(8, 10)}/${date.slice(5, 7)}:\n${lines.join("\n")}${total}` };
  }

  /** "Quem está há dois meses sem bater meta?" */
  static vendedoresAbaixoMeta(orgId: string, date: string, minMonths = 2): Res {
    const a = SellerGoalStreakService.assess(orgId, date, { monthsBack: 6 });
    const hit = a.people.filter((p) => p.identified && p.streak >= minMonths).sort((x, y) => y.streak - x.streak);
    const extra = a.skippedUnidentified ? ` (${a.skippedUnidentified} matrícula(s) sem nome cadastrado ficaram de fora — não nomeio quem não identifico)` : "";
    if (!hit.length) return { ok: true, tool: "vendedores_abaixo_meta", data: { people: [] }, summary: `Ninguém está há ${minMonths}+ meses seguidos abaixo da meta (só conto meses já fechados; mês de férias/afastamento e mês sem meta não contam contra).${extra}` };
    return { ok: true, tool: "vendedores_abaixo_meta", data: { people: hit.map((p) => ({ name: p.name, streak: p.streak })) }, summary: `Abaixo da meta há ${minMonths}+ meses seguidos:\n${hit.map((p) => `- ${p.name}: ${p.streak} meses seguidos`).join("\n")}${extra}` };
  }

  /** "Qual vendedor vendeu mais esta semana?" */
  static rankingVendedores(orgId: string, from: string, to: string, label: string): Res {
    const top = RetailSellerSalesService.networkTopSellers(orgId, from, to, 5);
    if (!top.length) return { ok: true, tool: "ranking_vendedores", data: { top: [] }, summary: `Sem vendas por vendedor registradas em ${label}.` };
    return { ok: true, tool: "ranking_vendedores", data: { top }, summary: `Vendedores que mais venderam, ${label}:\n${top.map((t, i) => `${i + 1}. ${t.sellerName}${t.storeName ? ` (${t.storeName})` : ""}: ${brl(t.sales)}`).join("\n")}` };
  }

  /** "Tenho alguma divergência de estoque?" */
  static divergenciaEstoque(orgId: string): Res {
    const d = NegativeStockDiagnosisService.diagnose(orgId);
    if (!d.total) return { ok: true, tool: "divergencia_estoque", data: d, summary: "Nenhum item com saldo negativo no estoque das lojas." };
    return { ok: true, tool: "divergencia_estoque", data: d, summary: `Sim — ${d.headline}.\n${d.byCause.map((c) => `- ${c.count}× ${c.label} (${c.stores.map((s) => `${s.storeName} ${s.count}`).join(", ")})`).join("\n")}` };
  }

  /** "Posso comprar R$ 180 mil?" — simulador de estoque (ADR-133). Entrada/prazo NÃO entram: diz isso. */
  static simularCompra(orgId: string, amount: number | null, ignored: string[] = []): Res {
    if (!(amount && amount > 0)) return { ok: true, tool: "simular_compra", clarify: "Qual o valor da compra? (ex.: R$ 180 mil)" };
    const r = DecisionSimulatorService.buyStock(orgId, { amount });
    const nota = ignored.length ? `\nObs.: considero só o valor total da compra — ${ignored.join(" e ")} não entra(m) nesta conta (não simulo o que não modelo).` : "";
    return { ok: !!r.ok, tool: "simular_compra", data: r, summary: `${r.veredito || r.message || "Não consegui simular."}${nota}` };
  }
}

export default RetailQuestionTools;
