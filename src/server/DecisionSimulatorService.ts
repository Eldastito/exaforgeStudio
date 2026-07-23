import { ComigoHealthService } from "./ComigoHealthService.js";
import { AnalyticsService } from "./AnalyticsService.js";
import { LossMarginService } from "./LossMarginService.js";

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
}

function brl(n: any): string { return `R$ ${(Number(n) || 0).toFixed(2).replace(".", ",")}`; }

export default DecisionSimulatorService;
