import { FinancialLedgerService } from "./FinancialLedgerService.js";
import { CashForecastService } from "./CashForecastService.js";
import { LossMarginService } from "./LossMarginService.js";
import { RevenueIntelligenceService } from "./RevenueIntelligenceService.js";

/**
 * Central de Saúde e Decisão (ADR-126 Fatia 1) — camada de SÍNTESE.
 *
 * Não recalcula nada: lê os sinais que já existem (Motor de Caixa/ADR-125,
 * perdas/ADR-114, RIE, recebíveis), decide o STATUS geral por REGRA
 * determinística (nunca texto livre da IA) e destila NO MÁXIMO 3 prioridades do
 * dia — cada uma com impacto em R$, origem, marcação fato×estimativa e uma ação
 * executável. Frugal (zero-token) e isolado por organization_id.
 */

const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
const brl = (n: number) => `R$ ${(Number(n) || 0).toFixed(2).replace(".", ",")}`;

type StatusLevel = "saudavel" | "atencao" | "risco" | "critico";
const SEVERITY: Record<StatusLevel, number> = { saudavel: 0, atencao: 1, risco: 2, critico: 3 };

export interface Priority {
  source: "caixa" | "recebiveis" | "perdas" | "rie";
  title: string;
  impact: number;
  basis: "fato" | "estimativa";
  fato: string;
  interpretacao: string;
  risco: string;
  action: { view: string; label: string };
}

export class BusinessHealthService {
  /** Snapshot leve do RIE (pode estar desativado/vazio) — nunca derruba a síntese. */
  private static rie(orgId: string): { estimatedLoss: number; recoverable: number; iqr: number } | null {
    try {
      const s = RevenueIntelligenceService.getSnapshot(orgId);
      return { estimatedLoss: Number(s?.money?.estimatedLoss) || 0, recoverable: Number(s?.money?.recoverable) || 0, iqr: Number(s?.iqr?.score) || 0 };
    } catch { return null; }
  }

  /** STATUS geral por regra determinística + os gatilhos que dispararam. */
  static status(orgId: string, minCash = 0) {
    const cash = FinancialLedgerService.summary(orgId);
    const fc = CashForecastService.forecast(orgId, { minCash });
    const loss = LossMarginService.monthlySummary(orgId);
    const triggers: { level: StatusLevel; code: string; label: string }[] = [];

    // crítico
    if (cash.caixaAtual < 0) triggers.push({ level: "critico", code: "caixa_negativo", label: "Seu caixa está negativo." });
    if (fc.firstRisk && fc.firstRisk.weeksAhead <= 2) triggers.push({ level: "critico", code: "ruptura_2sem", label: `Ruptura de caixa em ${fc.firstRisk.weeksAhead} semana(s).` });
    // risco
    if (fc.firstRisk && fc.firstRisk.weeksAhead > 2) triggers.push({ level: "risco", code: "ruptura_horizonte", label: `Caixa fura o mínimo em ${fc.firstRisk.weeksAhead} semanas.` });
    if (loss.status === "acima") triggers.push({ level: "risco", code: "perda_acima", label: `Perda do mês (${loss.lossPct}%) acima da meta (${loss.acceptablePct}%).` });
    // atenção
    if (fc.survivalDays != null && fc.survivalDays < 30 && !(fc.firstRisk && fc.firstRisk.weeksAhead <= 2)) triggers.push({ level: "atencao", code: "sobrevivencia_curta", label: `~${fc.survivalDays} dias de caixa no ritmo atual.` });
    if (cash.aReceber > 0 && cash.aReceber >= cash.caixaAtual && cash.caixaAtual >= 0) triggers.push({ level: "atencao", code: "receber_alto", label: `Você tem ${brl(cash.aReceber)} a receber — mais que o caixa atual.` });

    const overall = (triggers.reduce<StatusLevel>((acc, t) => (SEVERITY[t.level] > SEVERITY[acc] ? t.level : acc), "saudavel"));
    return { status: overall, triggers, cash, forecast: fc, loss };
  }

  /** Prioridades do dia (máx. 3), priorizadas por impacto em R$. */
  static priorities(orgId: string, ctx?: { cash?: any; forecast?: any; loss?: any }): Priority[] {
    const cash = ctx?.cash || FinancialLedgerService.summary(orgId);
    const fc = ctx?.forecast || CashForecastService.forecast(orgId, { minCash: 0 });
    const loss = ctx?.loss || LossMarginService.monthlySummary(orgId);
    const rie = this.rie(orgId);
    const cands: Priority[] = [];

    if (fc.firstRisk) {
      const rombo = round2(Math.max(0, -fc.firstRisk.ending));
      cands.push({
        source: "caixa", title: `Cobrir o rombo de caixa previsto`, impact: rombo > 0 ? rombo : cash.aReceber, basis: "fato",
        fato: `Caixa projetado ${brl(fc.firstRisk.ending)} na semana de ${fc.firstRisk.weekStart}.`,
        interpretacao: "A projeção de 13 semanas aponta que o caixa fura o mínimo.",
        risco: "Sem agir agora, pode faltar dinheiro para contas e reposição.",
        action: { view: "caixa", label: "Abrir plano de caixa" },
      });
    }
    if (cash.aReceber > 0) {
      cands.push({
        source: "recebiveis", title: `Cobrar ${brl(cash.aReceber)} a receber`, impact: round2(cash.aReceber), basis: "fato",
        fato: `${brl(cash.aReceberDetalhe?.fiado || 0)} em fiado + ${brl(cash.aReceberDetalhe?.manual || 0)} em contas a receber.`,
        interpretacao: "Dinheiro que já é seu e ainda não entrou no caixa.",
        risco: "Recebível parado vira capital de giro travado (e risco de calote).",
        action: { view: "comigo", label: "Ir para a caderneta" },
      });
    }
    if (loss.status === "acima" && loss.lossAmount > 0) {
      cands.push({
        source: "perdas", title: `Reduzir a perda em ${loss.topDriver ? loss.topDriver.driver : "operação"}`, impact: round2(loss.lossAmount), basis: "fato",
        fato: `Perda de ${loss.lossPct}% no mês (meta ${loss.acceptablePct}%), concentrada em ${loss.topDriver?.driver || "vários drivers"}.`,
        interpretacao: "As perdas passaram da margem que você definiu como aceitável.",
        risco: "Perda acima da meta corrói a margem e o resultado do mês.",
        action: { view: "reports", label: "Ver diagnóstico de perdas" },
      });
    }
    if (rie && rie.recoverable > 0) {
      cands.push({
        source: "rie", title: `Recuperar até ${brl(rie.recoverable)} em vendas`, impact: round2(rie.recoverable), basis: "estimativa",
        fato: `RIE estima ${brl(rie.recoverable)} recuperáveis de ${brl(rie.estimatedLoss)} em risco.`,
        interpretacao: "Leads/orçamentos/carrinhos parados com boa chance de recuperação.",
        risco: "Oportunidade esfria com o tempo — quanto antes, maior a conversão.",
        action: { view: "rie", label: "Abrir recuperação (RIE)" },
      });
    }

    return cands.sort((a, b) => b.impact - a.impact).slice(0, 3);
  }

  /** Payload da tela: status + gatilhos + frase-síntese + top-3 prioridades. */
  static overview(orgId: string, minCash = 0) {
    const st = this.status(orgId, minCash);
    const priorities = this.priorities(orgId, { cash: st.cash, forecast: st.forecast, loss: st.loss });
    const label: Record<StatusLevel, string> = { saudavel: "Saudável", atencao: "Atenção", risco: "Risco", critico: "Crítico" };
    let synthesis: string;
    if (st.status === "saudavel") synthesis = "Sem alertas hoje. Siga cuidando do caixa e das vendas.";
    else if (priorities[0]) synthesis = `${st.triggers[0]?.label || "Há pontos de atenção."} Comece por: ${priorities[0].title.toLowerCase()}.`;
    else synthesis = st.triggers[0]?.label || "Há pontos de atenção.";
    return {
      status: st.status,
      statusLabel: label[st.status],
      triggers: st.triggers,
      synthesis,
      priorities,
      kpis: { caixaAtual: st.cash.caixaAtual, aReceber: st.cash.aReceber, aPagar: st.cash.aPagar, survivalDays: st.forecast.survivalDays },
    };
  }
}

export default BusinessHealthService;
