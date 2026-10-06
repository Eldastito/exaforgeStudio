import { SellerDiagnosisService } from "./SellerDiagnosisService.js";
import { SellerGoalStreakService } from "./SellerGoalStreakService.js";
import { RetailFloorAnalyticsService } from "./RetailFloorAnalyticsService.js";
import { RetailFloorSettingsService } from "./RetailFloorService.js";
import { RetailSellerIdentityService } from "./RetailSellerIdentityService.js";

/**
 * SellerRecommendationService — "POR QUE provavelmente" + PLANO DE 14 DIAS do vendedor (ADR-204 F3.5, PRD Fase 3 §14/§15).
 *
 * Liga o que JÁ existe, sem motor novo: `SellerDiagnosisService` (vendas × nº de vendas × ticket × P.A. × dias escalados, janela
 * atual × anterior) + `SellerGoalStreakService` (meses seguidos abaixo da meta) + `RetailFloorAnalyticsService` (atendimentos) e
 * os transforma em (1) um texto de causa com EVIDÊNCIA, fato separado de hipótese, e (2) um plano de 14 dias que o GERENTE lê.
 *
 * REGRAS:
 *  - READ-ONLY e determinístico (sem LLM, sem tabela, não cria tarefa/ação/alerta). Criar tarefas do plano é decisão de uma
 *    PESSOA, em outro serviço (`SellerPlanTaskService`) — a IA só recomenda (RN-F3-3, Coach advisório ADR-202).
 *  - FATO = número lido do sistema. HIPÓTESE = leitura possível, rotulada `hypothesis`, NUNCA promovida a causa. O texto descreve
 *    o NÚMERO, não o motivo humano; nunca fala em culpa, punição, desligamento, salário ou comissão.
 *  - O plano só nasce de um fator sustentado pelos números (`driver`). Sem fator claro ("unclear") o plano é uma CONVERSA para
 *    entender o contexto, não uma intervenção inventada. Vendas que não caíram ou dado insuficiente → sem plano, com o motivo.
 *  - Metas do plano são REFERÊNCIAS reais (o próprio período anterior da pessoa), nunca um número inventado.
 *  - Atendimentos (Retail Floor): só entram FORA do período de calibração (RN-150-011) e com amostra mínima; senão o texto diz
 *    que não usou. Nunca é ranking: compara a pessoa com a média da PRÓPRIA loja.
 *  - Dinheiro (R$) no texto → a rota é dono/admin (§73). Isolado por organização.
 */
const DAY = 86400e3;
const MIN_FLOOR_ATTENDANCES = 10;
const FLOOR_GAP_PP = 10;           // pontos percentuais abaixo da média da loja p/ virar hipótese
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const brDate = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;
const brl = (n: number) => `R$ ${n.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export type PlanItem = {
  key: string; fromDay: number; toDay: number; dueDate: string; kind: "conferencia" | "conversa" | "observacao" | "pratica" | "gestao" | "checkpoint";
  title: string; detail: string; why: string; watch: string | null;
};
export type Why = { kind: "fact" | "hypothesis"; text: string; source: "diagnostico" | "meta_mensal" | "atendimentos" };

export class SellerRecommendationService {
  static recommend(orgId: string, sellerId: string, refDate: string, opts: { windowDays?: number } = {}): any {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(refDate)) throw new Error("refDate deve ser YYYY-MM-DD");
    const windowDays = opts.windowDays ?? 30;
    const dx = SellerDiagnosisService.diagnose(orgId, sellerId, refDate, windowDays);
    if (!dx.found) return { found: false, error: dx.error };
    const base: any = { found: true, refDate, seller: dx.seller, store: dx.store ?? null, window: dx.current ? { start: dx.current.start, end: dx.current.end } : null, containsMoney: true };
    const disclaimer = "Isto orienta uma CONVERSA do gerente — não é avaliação formal de desempenho e não afeta comissão, salário ou cobrança. A IA só recomenda; quem decide e cria tarefas é uma pessoa.";
    if (!dx.enough) return { ...base, enough: false, reason: dx.reason, why: [], driver: "insufficient", plan14: null, disclaimer };

    const why: Why[] = dx.findings.map((f) => ({ kind: f.kind, text: f.text, source: "diagnostico" as const }));
    const sources: any = { diagnosis: true, streak: false, floor: "no_store" };

    // meses seguidos abaixo da meta (só pessoa identificada — quem tem id aqui é identificada)
    let streakLevel = "none"; let streakN = 0;
    try {
      const a = SellerGoalStreakService.assess(orgId, refDate);
      const me = a.people.find((p) => p.sellerId && p.sellerId === dx.seller!.id);
      if (me && me.level !== "none") {
        streakLevel = me.level; streakN = me.streak; sources.streak = true;
        why.push({ kind: "fact", source: "meta_mensal", text: `${me.streak} mês(es) fechado(s) seguido(s) abaixo da meta individual (meses sem meta ou com ausência não contam).` });
      }
    } catch { /* sem placar mensal: o plano segue só com o diagnóstico */ }

    // atendimentos da loja (Retail Floor) — só fora da calibração e com amostra mínima; nunca ranking
    const place = RetailSellerIdentityService.storeOn(orgId, dx.seller!.id, refDate);
    if (place) {
      try {
        if (RetailFloorSettingsService.inCalibration(orgId)) sources.floor = "calibration";
        else {
          const f = RetailFloorAnalyticsService.store(orgId, place.storeId, dx.current!.start, dx.current!.end);
          const me = (f.bySeller || []).find((s: any) => s.sellerId === dx.seller!.id);
          if (!me || me.attendances < MIN_FLOOR_ATTENDANCES || !(f.totals?.attendances > 0)) sources.floor = "low_sample";
          else {
            sources.floor = "used";
            const mine = me.confirmed / me.attendances * 100, store = (f.totals.confirmedCount / f.totals.attendances) * 100;
            why.push({ kind: "fact", source: "atendimentos", text: `Atendimentos registrados no período: ${me.attendances}; com venda confirmada pelo PDV: ${Math.round(mine)}% (média da loja: ${Math.round(store)}%).` });
            if (dx.driver === "orders" && mine < store - FLOOR_GAP_PP) why.push({ kind: "hypothesis", source: "atendimentos", text: "A conversão dos atendimentos está abaixo da média da loja — pode ser abordagem ou perfil de cliente atendido; vale observar antes de concluir." });
          }
        }
      } catch { sources.floor = "low_sample"; }
    }
    why.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "fact" ? -1 : 1));

    const out: any = { ...base, enough: true, driver: dx.driver, deltasPct: dx.deltasPct, streak: { level: streakLevel, months: streakN }, evidenceSources: sources, why, disclaimer, plan14: null };
    if (dx.driver === "none") return { ...out, reason: "As vendas não caíram frente ao período anterior — não há o que recomendar com base nestes números." };
    if (dx.driver === "insufficient") return { ...out, reason: "Faltam números para comparar os dois períodos — não monto plano sem base." };
    out.plan14 = this.plan(dx, refDate, streakLevel, streakN);
    return out;
  }

  /** Plano de 14 dias. Todo item aponta o número que o motivou; metas são o PRÓPRIO período anterior da pessoa. */
  private static plan(dx: any, refDate: string, streakLevel: string, streakN: number): any {
    const prev = dx.previous, cur = dx.current;
    const start = addDays(refDate, 1);
    const due = (day: number) => addDays(start, day - 1);
    const items: PlanItem[] = [];
    const add = (i: Omit<PlanItem, "dueDate">) => items.push({ ...i, dueDate: due(i.toDay) });
    const conversa: Omit<PlanItem, "dueDate"> = { key: "conversa_1a1", fromDay: 2, toDay: 3, kind: "conversa", title: "Conversa 1 a 1 para entender o contexto", detail: "Conversar com a pessoa sobre os últimos dias — o que mudou na rotina, no fluxo da loja ou na carteira de clientes. Ouvir primeiro; os números abaixo são o ponto de partida, não um veredito.", why: "Os números mostram o QUE mudou, não o PORQUÊ — só a pessoa pode explicar.", watch: null };

    switch (dx.driver) {
      case "days":
        add({ key: "conferir_escala", fromDay: 1, toDay: 2, kind: "conferencia", title: "Conferir escala e ausências do período", detail: `Dias escalados caíram de ${prev.scheduledDays} para ${cur.scheduledDays}. Confirmar se foi folga/ausência/troca de loja antes de olhar desempenho.`, why: `Dias escalados: ${prev.scheduledDays} → ${cur.scheduledDays} (${dx.deltasPct.days}%) com ticket estável.`, watch: "dias escalados" });
        add({ key: "cobertura_escala", fromDay: 3, toDay: 7, kind: "gestao", title: "Se foi falta de escala, ajustar a cobertura — não é desempenho da pessoa", detail: "Se a queda veio de menos dias trabalhados, o ajuste é de escala. Evitar cobrar a pessoa por um resultado que acompanha os dias.", why: "A hipótese é que a queda acompanha os dias escalados.", watch: "vendas por dia escalado" });
        break;
      case "orders":
        add({ key: "observar_fluxo", fromDay: 1, toDay: 7, kind: "observacao", title: "Acompanhar o fluxo e a abordagem em horário de movimento", detail: "Observar, sem cobrar, como a pessoa recebe e conduz o cliente nos horários de maior fluxo da loja. Anotar o que viu para a conversa.", why: `Nº de vendas: ${prev.orders} → ${cur.orders} (${dx.deltasPct.orders}%) com ticket estável.`, watch: "nº de vendas" });
        add(conversa);
        add({ key: "retorno_ao_nivel", fromDay: 8, toDay: 14, kind: "pratica", title: `Combinar a volta ao nível do período anterior (${prev.orders} vendas)`, detail: `Combinar com a pessoa uma referência realista: o próprio período anterior (${prev.orders} vendas em ${dx.previous.start.slice(8, 10)}/${dx.previous.start.slice(5, 7)}–${dx.previous.end.slice(8, 10)}/${dx.previous.end.slice(5, 7)}). Não é meta nova nem altera a meta oficial.`, why: "A referência é o desempenho anterior da própria pessoa.", watch: "nº de vendas" });
        break;
      case "ticket":
        add({ key: "revisar_mix", fromDay: 1, toDay: 7, kind: "observacao", title: "Revisar o mix vendido e a oferta de itens de maior valor", detail: `Ticket médio caiu de ${brl(prev.ticket)} para ${brl(cur.ticket)}. Ver que produtos estão saindo e se a oferta de itens de maior valor está acontecendo.`, why: `Ticket médio: ${brl(prev.ticket)} → ${brl(cur.ticket)} (${dx.deltasPct.ticket}%) com nº de vendas estável.`, watch: "ticket médio" });
        add(conversa);
        add({ key: "venda_adicional", fromDay: 8, toDay: 14, kind: "pratica", title: "Praticar venda adicional e combinações de peças", detail: `Combinar uma prática simples de oferta de complemento, tendo como referência o ticket do período anterior (${brl(prev.ticket)}).`, why: "O ticket caiu enquanto o nº de vendas se manteve.", watch: "ticket médio" });
        break;
      case "pa":
        add({ key: "praticar_pa", fromDay: 1, toDay: 7, kind: "pratica", title: "Trabalhar venda adicional (peças por venda)", detail: `Peças por venda caíram de ${prev.pa} para ${cur.pa}. Combinar com a pessoa a oferta de uma peça a mais na venda.`, why: `P.A.: ${prev.pa} → ${cur.pa} (${dx.deltasPct.pa}%).`, watch: "peças por venda" });
        add(conversa);
        break;
      default: // unclear — os números não apontam um fator único
        add({ ...conversa, why: "Nenhum fator único explica a queda nos números — a conversa é o passo honesto; não vou apontar causa." });
    }
    if (streakLevel === "critical" || streakLevel === "action")
      add({ key: "alinhamento_gestao", fromDay: 1, toDay: 3, kind: "gestao", title: "Levar o caso ao dono/gestão da rede", detail: `${streakN} meses seguidos abaixo da meta. Alinhar com a gestão da rede o apoio a oferecer (treinamento, escala, carteira) — conversa de apoio, não de punição.`, why: `Sequência de ${streakN} meses abaixo da meta individual.`, watch: null });
    add({ key: "checkpoint", fromDay: 14, toDay: 14, kind: "checkpoint", title: "Reavaliar: rodar o diagnóstico de novo e comparar", detail: `No dia ${brDate(due(14))}, rodar o diagnóstico outra vez e comparar com o período de referência (vendas ${brl(prev.sales ?? 0)}). Só então decidir o próximo passo.`, why: "Fecha o ciclo: mede se algo mudou, em vez de presumir.", watch: "vendas, nº de vendas, ticket, P.A." });
    items.sort((a, b) => a.fromDay - b.fromDay || a.toDay - b.toDay);
    return { startDate: start, endDate: due(14), days: 14, items, reference: { window: { start: prev.start, end: prev.end }, sales: prev.sales, orders: prev.orders, ticket: prev.ticket, pa: prev.pa }, basis: "hypothesis", note: "Plano derivado de uma HIPÓTESE sobre os números; o checkpoint do dia 14 existe para confirmar ou descartar." };
  }
}

export default SellerRecommendationService;
