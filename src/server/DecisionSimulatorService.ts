import { ComigoHealthService } from "./ComigoHealthService.js";
import { AnalyticsService } from "./AnalyticsService.js";
import { LossMarginService } from "./LossMarginService.js";
import { RetailImpactService } from "./RetailImpactService.js";
import { OwnerDrawService } from "./OwnerDrawService.js";
import db from "./db.js";

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
  /** Receita dos últimos 30 dias (janela MÓVEL), entre verticais (orders + comigo_orders). */
  static revenue30(orgId: string): number {
    try {
      const row = db.prepare(`
        SELECT COALESCE(SUM(x),0) s FROM (
          SELECT total_amount AS x FROM orders WHERE organization_id = ? AND status IN ('pago','em_preparo','entregue','concluido') AND created_at >= datetime('now','-30 days')
          UNION ALL
          SELECT total AS x FROM comigo_orders WHERE organization_id = ? AND status IN ('paid','done') AND created_at >= datetime('now','-30 days')
        )
      `).get(orgId, orgId) as any;
      return Math.round((Number(row?.s) || 0) * 100) / 100;
    } catch { return 0; }
  }

  /** Margem e ticket médios recentes + receita (mês corrente e janela móvel de 30d). */
  static marginContext(orgId: string): { marginFrac: number; avgTicket: number; monthlyRevenue: number; revenue30: number } {
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
    return { marginFrac, avgTicket, monthlyRevenue, revenue30: this.revenue30(orgId) };
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

    const { marginFrac, revenue30 } = this.marginContext(orgId);
    // CMV/dia = receita dos ÚLTIMOS 30 DIAS (janela móvel) × (1 - margem) ÷ 30.
    // Janela móvel (não o mês corrente) evita subestimar o CMV/dia no início do
    // mês — o que superestimaria a cobertura. Sem margem/vendas, fica 0.
    const cogsDaily = marginFrac > 0 && revenue30 > 0 ? (revenue30 * (1 - marginFrac)) / 30 : 0;
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

  /**
   * "Posso retirar mais?" (ADR-133 Fatia 3) — what-if de uma retirada ADICIONAL
   * agora: efeito no caixa e no % do resultado, contra o pró-labore sustentável
   * (30% do resultado, limitado ao caixa). Reusa OwnerDrawService.summary.
   */
  static withdraw(orgId: string, input: { amount: number }): any {
    const amount = Number(input?.amount) || 0;
    if (!(amount > 0)) return { ok: false, reason: "valor_invalido", message: "Informe o valor que você quer retirar." };

    const s = OwnerDrawService.summary(orgId) as any;
    const retiradas = Number(s?.retiradas) || 0;
    const resultado = Number(s?.resultado) || 0;
    const caixa = Number(s?.caixa) || 0;
    const proLaboreSugerido = Number(s?.proLaboreSugerido) || 0;

    const caixaAfter = round2(caixa - amount);
    const retiradasAfter = round2(retiradas + amount);
    const pctResultAfter = resultado > 0 ? Math.round((retiradasAfter / resultado) * 100) : null;
    const roomLeft = round2(Math.max(0, proLaboreSugerido - retiradas));

    let nivel: "ok" | "atencao" | "excesso";
    let veredito: string;
    if (caixaAfter < 0) {
      nivel = "excesso";
      veredito = `Não há caixa para isso: retirar ${brl(amount)} deixaria o caixa em ${brl(caixaAfter)}. Retire no máximo ${brl(caixa)}.`;
    } else if (resultado <= 0) {
      nivel = "excesso";
      veredito = `O resultado do mês está zerado ou negativo — retirar ${brl(amount)} descapitaliza a empresa. Espere o negócio gerar resultado.`;
    } else if (amount <= roomLeft) {
      nivel = "ok";
      veredito = `Pode retirar ${brl(amount)} com tranquilidade — cabe no pró-labore sustentável (teto ~${brl(proLaboreSugerido)}${retiradas > 0 ? `, já retirado ${brl(retiradas)}` : ""}).`;
    } else if (pctResultAfter != null && pctResultAfter <= 70) {
      nivel = "atencao";
      veredito = `Dá para retirar ${brl(amount)}, mas passa do sugerido: as retiradas ficariam em ${pctResultAfter}% do resultado (o ideal é até 30%). Se puder, retire perto de ${brl(proLaboreSugerido)}.`;
    } else {
      nivel = "excesso";
      veredito = `Retirar ${brl(amount)} leva as retiradas a ${pctResultAfter}% do resultado — acima de 70%. Risco de descapitalizar; retire bem menos (sugerido ~${brl(proLaboreSugerido)}).`;
    }

    return {
      ok: true, amount, nivel,
      caixaAtual: round2(caixa), caixaAfter,
      retiradasAtual: round2(retiradas), retiradasAfter,
      resultado: round2(resultado), pctResultAfter, proLaboreSugerido, roomLeft,
      veredito,
    };
  }

  /**
   * "Quanto vender para pagar essa máquina?" (ADR-133 Fatia 4) — payback de um
   * investimento. Receita total necessária = investimento ÷ margem (a margem é
   * o que sobra de cada venda para amortizar). Em N meses (padrão 12), quanto de
   * venda por mês; e o payback no ritmo de lucro atual.
   */
  static payback(orgId: string, input: { amount: number; months?: number }): any {
    const amount = Number(input?.amount) || 0;
    if (!(amount > 0)) return { ok: false, reason: "valor_invalido", message: "Informe o valor do investimento." };
    const months = Math.min(120, Math.max(1, Math.floor(Number(input?.months) || 12)));
    const { marginFrac, avgTicket, monthlyRevenue } = this.marginContext(orgId);
    if (marginFrac <= 0) return { ok: false, reason: "sem_margem", message: "Cadastre seus custos para eu conhecer sua margem — sem ela não dá para calcular o payback." };

    const totalRevenueNeeded = round2(amount / marginFrac);
    const monthlyRevenueNeeded = round2(totalRevenueNeeded / months);
    const pctOfCurrent = monthlyRevenue > 0 ? Math.round((monthlyRevenueNeeded / monthlyRevenue) * 100) : null;
    const extraTicketsPerDay = avgTicket > 0 ? Math.ceil(monthlyRevenueNeeded / 30 / avgTicket) : null;
    const monthlyMargin = monthlyRevenue * marginFrac;
    const paybackMonths = monthlyMargin > 0 ? Math.ceil(amount / monthlyMargin) : null;
    const marginPct = Math.round(marginFrac * 100);

    let veredito: string;
    if (paybackMonths == null) veredito = `Com margem de ${marginPct}%, é preciso gerar ${brl(totalRevenueNeeded)} em vendas para pagar o investimento (${brl(monthlyRevenueNeeded)}/mês em ${months} meses).`;
    else veredito = `Para pagar ${brl(amount)} em ${months} meses, some ~${brl(monthlyRevenueNeeded)}/mês em vendas${pctOfCurrent != null ? ` (${pctOfCurrent}% a mais que hoje)` : ""}. No seu ritmo de lucro atual, o payback é de ~${paybackMonths} ${paybackMonths === 1 ? "mês" : "meses"}.`;

    return {
      ok: true, amount, months, marginPct, monthlyRevenue,
      totalRevenueNeeded, monthlyRevenueNeeded, pctOfCurrent, extraTicketsPerDay, paybackMonths,
      veredito,
    };
  }
}

function brl(n: any): string { return `R$ ${(Number(n) || 0).toFixed(2).replace(".", ",")}`; }

export default DecisionSimulatorService;
