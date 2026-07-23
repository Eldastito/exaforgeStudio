import { ComigoHealthService } from "./ComigoHealthService.js";
import { AnalyticsService } from "./AnalyticsService.js";
import { LossMarginService } from "./LossMarginService.js";
import { RetailImpactService } from "./RetailImpactService.js";

/**
 * Simulador de Decisões (ADR-133) — "decidir antes de gerar o problema".
 *
 * O dono pergunta ANTES de agir e recebe o número, não um palpite. Fatia 1:
 * "posso contratar?" — dado o custo mensal, quanto de venda a mais é preciso
 * gerar com a MARGEM ATUAL para pagar a contratação. Determinístico (zero-token),
 * isolado por organization_id. A IA sugere o contexto; o dono decide.
 */

const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

export class DecisionSimulatorService {
  /** Margem e ticket médios recentes + receita do mês — robusto entre verticais. */
  static marginContext(orgId: string): { marginFrac: number; avgTicket: number; monthlyRevenue: number } {
    let marginFrac = 0, avgTicket = 0;
    try {
      const be = ComigoHealthService.breakEven(orgId) as any;
      marginFrac = Number(be?.avgMargin) || 0;
      avgTicket = Number(be?.avgTicket) || 0;
    } catch { /* segue para o fallback */ }
    if (marginFrac <= 0) {
      try {
        const prof = AnalyticsService.getProfit(orgId, { period: "month" } as any) as any;
        if (prof?.hasCostData && prof.revenue > 0) {
          marginFrac = (Number(prof.margin) || 0) / 100;
          if (avgTicket <= 0 && prof.orders > 0) avgTicket = prof.revenue / prof.orders;
        }
      } catch { /* sem margem */ }
    }
    let monthlyRevenue = 0;
    try { monthlyRevenue = LossMarginService.monthlyRevenue(orgId, new Date().toISOString().slice(0, 10).slice(0, 7)); } catch { /* 0 */ }
    return { marginFrac, avgTicket, monthlyRevenue };
  }

  /**
   * "Posso contratar?" — quanto de venda ADICIONAL por mês a contratação exige,
   * dada a margem atual. extraReceita = custoMensal / margem.
   */
  static hire(orgId: string, input: { monthlyCost: number }): any {
    const monthlyCost = Number(input?.monthlyCost) || 0;
    if (!(monthlyCost > 0)) return { ok: false, reason: "custo_invalido", message: "Informe o custo mensal da contratação." };
    const { marginFrac, avgTicket, monthlyRevenue } = this.marginContext(orgId);
    if (marginFrac <= 0) return { ok: false, reason: "sem_margem", message: "Cadastre seus custos para eu conhecer sua margem — sem ela não dá para simular com honestidade." };

    const extraRevenueNeeded = round2(monthlyCost / marginFrac);
    const pctOfCurrent = monthlyRevenue > 0 ? Math.round((extraRevenueNeeded / monthlyRevenue) * 100) : null;
    const extraTicketsPerDay = avgTicket > 0 ? Math.ceil(extraRevenueNeeded / 30 / avgTicket) : null;

    const marginPct = Math.round(marginFrac * 100);
    let veredito: string;
    if (pctOfCurrent == null) veredito = `Com margem de ${marginPct}%, a contratação exige gerar ~${brl(extraRevenueNeeded)} em vendas por mês para se pagar.`;
    else if (pctOfCurrent <= 15) veredito = `Exige ~${brl(extraRevenueNeeded)}/mês em vendas (só ${pctOfCurrent}% a mais que hoje). Parece viável — confira se o novo funcionário ajuda a gerar isso.`;
    else if (pctOfCurrent <= 40) veredito = `Exige ~${brl(extraRevenueNeeded)}/mês em vendas (${pctOfCurrent}% a mais que hoje). Dá, mas planeje de onde virá esse crescimento.`;
    else veredito = `Exige ~${brl(extraRevenueNeeded)}/mês em vendas (${pctOfCurrent}% a mais que hoje). É um salto grande — reveja o custo ou a margem antes.`;

    return {
      ok: true,
      monthlyCost, marginPct, monthlyRevenue,
      extraRevenueNeeded, pctOfCurrent, extraTicketsPerDay, avgTicket: round2(avgTicket),
      veredito,
    };
  }

  /**
   * "Posso comprar esse estoque?" — impacto na COBERTURA (dias) e quanto tende a
   * ficar PARADO. cobertura = capital em estoque ÷ CMV/dia; o parado estimado usa
   * a fração atual de estoque sem giro aplicada à compra.
   */
  static buyStock(orgId: string, input: { amount: number }): any {
    const amount = Number(input?.amount) || 0;
    if (!(amount > 0)) return { ok: false, reason: "valor_invalido", message: "Informe o valor da compra de estoque." };

    let totalCapital = 0, slowMoverCapital = 0;
    try {
      const sc = RetailImpactService.stockCapital(orgId) as any;
      totalCapital = Number(sc?.totalCapital) || 0;
      slowMoverCapital = Number(sc?.slowMoverCapital) || 0;
    } catch { /* sem estoque */ }

    const { marginFrac, monthlyRevenue } = this.marginContext(orgId);
    // CMV/dia ≈ receita do mês × (1 - margem) ÷ 30. Sem margem/vendas, fica 0.
    const cogsDaily = marginFrac > 0 && monthlyRevenue > 0 ? (monthlyRevenue * (1 - marginFrac)) / 30 : 0;
    const slowShare = totalCapital > 0 ? slowMoverCapital / totalCapital : 0;
    const estIdle = round2(amount * slowShare);
    const slowPct = Math.round(slowShare * 100);

    if (cogsDaily <= 0) {
      return {
        ok: true, coverageKnown: false, amount, totalCapital, estIdle, slowPct,
        veredito: `Ainda não tenho velocidade de venda (margem/vendas) para estimar a cobertura em dias.${totalCapital > 0 ? ` Pelo seu histórico, ~${slowPct}% do estoque hoje está sem giro — ao comprar ${brl(amount)}, algo perto de ${brl(estIdle)} pode ficar parado se o padrão se repetir.` : ""}`,
      };
    }
    const currentCoverageDays = Math.round(totalCapital / cogsDaily);
    const newCoverageDays = Math.round((totalCapital + amount) / cogsDaily);
    let veredito: string;
    if (newCoverageDays <= 60) veredito = `Comprar ${brl(amount)} leva sua cobertura de ${currentCoverageDays} para ${newCoverageDays} dias — dentro do saudável. Só ~${slowPct}% costuma ficar sem giro (~${brl(estIdle)}).`;
    else if (newCoverageDays <= 120) veredito = `Comprar ${brl(amount)} leva a cobertura de ${currentCoverageDays} para ${newCoverageDays} dias. Dá, mas ~${brl(estIdle)} (~${slowPct}% do padrão) pode ficar parado +60 dias — priorize o que gira.`;
    else veredito = `Comprar ${brl(amount)} leva a cobertura de ${currentCoverageDays} para ${newCoverageDays} dias — é muito estoque para o giro atual. Cerca de ${brl(estIdle)} tende a empatar capital. Compre menos ou o que sai mais rápido.`;

    return {
      ok: true, coverageKnown: true, amount, totalCapital,
      currentCoverageDays, newCoverageDays, estIdle, slowPct, cogsDaily: round2(cogsDaily),
      veredito,
    };
  }
}

function brl(n: any): string { return `R$ ${(Number(n) || 0).toFixed(2).replace(".", ",")}`; }

export default DecisionSimulatorService;
