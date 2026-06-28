import db from "./db.js";
import { AnalyticsService } from "./AnalyticsService.js";
import { RevenueIntelligenceService } from "./RevenueIntelligenceService.js";

type Period = "today" | "week" | "month" | "all";

const PERIOD_LABEL: Record<Period, string> = {
  today: "Hoje",
  week: "Últimos 7 dias",
  month: "Últimos 30 dias",
  all: "Todo o período",
};

interface AuditSection {
  id: string;
  title: string;
  headline: string;          // 1 linha — vai pro topo da seção no PDF
  metrics: { label: string; value: string; tone?: "good" | "warn" | "bad" | "info" }[];
  notes?: string[];          // contexto / "porquês" curtos
  rows?: { label: string; value: string }[]; // tabela secundária opcional
}

/**
 * Revenue Audit Service — monta o RELATÓRIO DE AUDITORIA do RIC (10 seções).
 * Read-only: consome o snapshot do RevenueIntelligenceService + AnalyticsService
 * e devolve uma estrutura pronta para virar PDF ou exibir no front. Nada de IA
 * narrativa aqui — é factual; o "tom executivo" entra no plano 30/60/90, que é
 * gerado pelo Diretor IA com este relatório como base.
 */
export class RevenueAuditService {
  private static brl(v: number): string {
    return "R$ " + Number(v || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2 });
  }

  private static pct(v: number): string {
    return `${Number(v || 0).toFixed(1).replace(/\.0$/, "")}%`;
  }

  private static toneByScore(score: number): "good" | "warn" | "bad" {
    if (score >= 80) return "good";
    if (score >= 60) return "warn";
    return "bad";
  }

  /**
   * Monta o relatório completo: 10 seções estruturadas + cabeçalho + snapshot
   * do RIC bruto (o front/PDF pode usar para drilldown se quiser).
   */
  static build(orgId: string, period: Period = "month") {
    const ric = RevenueIntelligenceService.getSnapshot(orgId, period);
    const m = AnalyticsService.getMetrics(orgId, { period });
    const profit = AnalyticsService.getProfit(orgId, { period });
    const settings = AnalyticsService.getReportSettings(orgId) as any;
    const businessName = settings?.business_name || "Sua Empresa";

    const sections: AuditSection[] = [
      this.s1SumarioExecutivo(ric, profit),
      this.s2Atendimento(ric, m),
      this.s3Comercial(ric, m),
      this.s4Operacional(ric, m),
      this.s5PerdaEstimada(ric),
      this.s6Recuperavel(ric),
      this.s7Recuperada(ric),
      this.s8MotivosDePerda(m),
      this.s9FunilVelocidade(m),
      this.s10Satisfacao(m),
    ];

    return {
      meta: {
        businessName,
        period,
        periodLabel: PERIOD_LABEL[period],
        generatedAt: new Date().toISOString(),
      },
      headline: {
        iqr: ric.iqr.score,
        weakestDriver: ric.iqr.weakestDriver,
        estimatedLoss: ric.money.estimatedLoss,
        recoverable: ric.money.recoverable,
        recovered: ric.money.recovered,
        ticket: ric.money.ticket,
      },
      sections,
      snapshot: ric,
    };
  }

  // --- 1. SUMÁRIO EXECUTIVO -------------------------------------------------
  private static s1SumarioExecutivo(ric: any, profit: any): AuditSection {
    const iqr = ric.iqr.score;
    return {
      id: "executive_summary",
      title: "Sumário Executivo",
      headline: `IQR ${iqr}/100. Potencial em risco: ${this.brl(ric.money.estimatedLoss)} (recuperável ${this.brl(ric.money.recoverable)}). Já recuperado: ${this.brl(ric.money.recovered)}.`,
      metrics: [
        { label: "IQR (0-100)", value: String(iqr), tone: this.toneByScore(iqr) },
        { label: "Potencial em risco", value: this.brl(ric.money.estimatedLoss), tone: "bad" },
        { label: "Receita recuperável (IRR)", value: this.brl(ric.money.recoverable), tone: "warn" },
        { label: "Receita recuperada (RRI)", value: this.brl(ric.money.recovered), tone: "good" },
        { label: "Lucro confirmado", value: this.brl(profit?.profit || 0), tone: "info" },
        { label: "Margem", value: profit?.hasCostData ? this.pct(profit.margin) : "—", tone: "info" },
      ],
      notes: [
        `Driver mais fraco do IQR: ${ric.iqr.weakestDriver}.`,
        `Premissa de ticket usada na engine: ${this.brl(ric.money.ticket.value)} (${ric.money.ticket.source}).`,
        `Fórmula da perda: ${ric.money.formula}. Configurável por organização.`,
      ],
    };
  }

  // --- 2. ATENDIMENTO -------------------------------------------------------
  private static s2Atendimento(ric: any, m: any): AuditSection {
    const d = ric.drivers.atendimento;
    const b = d.breakdown;
    return {
      id: "driver_atendimento",
      title: "Driver: Atendimento",
      headline: `Score ${d.score}/100. ${b.stalledLeads} lead(s) parado(s) sem 1ª resposta; ${this.pct(b.abandonRatePct)} de abandono.`,
      metrics: [
        { label: "Score do driver", value: String(d.score), tone: this.toneByScore(d.score) },
        { label: "Tempo médio 1ª resposta", value: `${b.firstResponseSec}s`, tone: b.firstResponseScore >= 80 ? "good" : "bad" },
        { label: "% de conversas abandonadas", value: this.pct(b.abandonRatePct) },
        { label: "Leads parados (>4h sem resposta)", value: String(b.stalledLeads) },
        { label: "Repasses para humano", value: String(m.handoffCount) },
      ],
      notes: [
        `Resolução pela IA: ${m.resolutionRateAI}%. Respostas da IA no período: ${m.aiResponseCount}.`,
      ],
    };
  }

  // --- 3. COMERCIAL ---------------------------------------------------------
  private static s3Comercial(ric: any, m: any): AuditSection {
    const d = ric.drivers.comercial;
    const b = d.breakdown;
    return {
      id: "driver_comercial",
      title: "Driver: Comercial",
      headline: `Score ${d.score}/100. Conversão ${this.pct(b.conversionPct)}; ${b.staleQuotes} orçamento(s) parado(s); ${b.coldDeals} negócio(s) frio(s).`,
      metrics: [
        { label: "Score do driver", value: String(d.score), tone: this.toneByScore(d.score) },
        { label: "Conversão (vendas / atendimentos)", value: this.pct(b.conversionPct) },
        { label: "Orçamentos parados", value: String(b.staleQuotes) },
        { label: "% de orçamentos parados", value: this.pct(b.staleQuoteRatePct) },
        { label: "Negócios em estágio quente sem retorno", value: String(b.coldDeals) },
        { label: "Ticket médio (AOV)", value: this.brl(m.averageOrderValue || 0) },
      ],
      notes: m.hospitality?.quotesSent
        ? [`Orçamentos enviados no período: ${m.hospitality.quotesSent}; aceitos: ${m.hospitality.quotesAccepted} (${m.hospitality.quotesAcceptRate}%).`]
        : [],
    };
  }

  // --- 4. OPERACIONAL -------------------------------------------------------
  private static s4Operacional(ric: any, m: any): AuditSection {
    const d = ric.drivers.operacional;
    const b = d.breakdown;
    return {
      id: "driver_operacional",
      title: "Driver: Operacional",
      headline: `Score ${d.score}/100. ${this.pct(b.handoffRatePct)} dos atendimentos vão para humano; ciclo de venda ~${b.avgTimeToSaleHours}h.`,
      metrics: [
        { label: "Score do driver", value: String(d.score), tone: this.toneByScore(d.score) },
        { label: "% de repasses humanos", value: this.pct(b.handoffRatePct) },
        { label: "Tempo médio até a venda (h)", value: String(b.avgTimeToSaleHours) },
        { label: "Total de tickets no período", value: String(m.totalTickets) },
        { label: "Novos leads", value: String(m.newLeadsCount) },
        { label: "Vendas concretizadas", value: String(m.salesCount) },
      ],
    };
  }

  // --- 5. PERDA ESTIMADA ----------------------------------------------------
  private static s5PerdaEstimada(ric: any): AuditSection {
    const sources = ric.lossSources as any[];
    return {
      id: "estimated_loss",
      title: "Perda Estimada (potencial em risco)",
      headline: `${this.brl(ric.money.estimatedLoss)} em jogo. Maior fonte: ${this.topSource(sources)}.`,
      metrics: sources.map(s => ({
        label: `${s.label} (${s.count} × ${(s.prob * 100).toFixed(0)}%)`,
        value: this.brl(s.amount),
        tone: s.amount > 0 ? "bad" as const : "info" as const,
      })),
      notes: [
        `Fórmula: ${ric.money.formula}. Ticket: ${this.brl(ric.money.ticket.value)} (${ric.money.ticket.source}).`,
        "Valores são potencial em risco, não perda confirmada. Probabilidades calibráveis por organização.",
      ],
    };
  }

  private static topSource(sources: any[]): string {
    const top = sources.slice().sort((a, b) => b.amount - a.amount)[0];
    if (!top || top.amount <= 0) return "nenhuma fonte com valor positivo no período";
    return `${top.label} (${this.brl(top.amount)})`;
  }

  // --- 6. RECEITA RECUPERÁVEL (IRR) -----------------------------------------
  private static s6Recuperavel(ric: any): AuditSection {
    const recoverableSources = (ric.lossSources as any[]).filter(s => s.recoverable);
    return {
      id: "recoverable_revenue",
      title: "Receita Recuperável (IRR)",
      headline: `Da perda estimada, ${this.brl(ric.money.recoverable)} ainda tem alta chance de recuperação.`,
      metrics: recoverableSources.map(s => ({
        label: s.label,
        value: this.brl(s.amount),
        tone: "warn" as const,
      })),
      notes: [
        "IRR cobre fontes com sinal recente de intenção (lead lento, orçamento sem retorno, conversa abandonada).",
        "Clientes inativos ficam fora do IRR porque exigem reativação ativa, não recuperação imediata.",
      ],
    };
  }

  // --- 7. RECEITA RECUPERADA (RRI) ------------------------------------------
  private static s7Recuperada(ric: any): AuditSection {
    const sources = ric.recoveredSources as any[];
    const totalOrders = sources.reduce((s, x) => s + (x.orders || 0), 0);
    return {
      id: "recovered_revenue",
      title: "Receita Recuperada (RRI) — provada por execução",
      headline: `${this.brl(ric.money.recovered)} recuperado por fluxos do ZappFlow em ${totalOrders} pedido(s) (janela ${ric.attributionWindowDays}d).`,
      metrics: sources.map(s => ({
        label: `${s.label} (${s.orders} pedido(s))`,
        value: this.brl(s.amount),
        tone: s.amount > 0 ? "good" as const : "info" as const,
      })),
      notes: [
        "Atribuição por janela: pedido pago após uma ação do ZappFlow dentro do prazo configurado.",
        "Este é o moat ownable do RIC: não é só auditar, é recuperar — e medir o que recuperou.",
      ],
    };
  }

  // --- 8. MOTIVOS DE PERDA --------------------------------------------------
  private static s8MotivosDePerda(m: any): AuditSection {
    const reasons = (m.lossReasons as any[]) || [];
    const total = m.lossCount || 0;
    const top = reasons.slice(0, 8);
    return {
      id: "loss_reasons",
      title: "Motivos de Perda (declarados)",
      headline: total > 0
        ? `${total} fechamento(s) sem sucesso registrado(s). Top motivo: "${top[0]?.reason}" (${top[0]?.count}).`
        : "Nenhum fechamento sem sucesso no período. Bom sinal — ou falta registro.",
      metrics: top.map(r => ({
        label: r.reason,
        value: `${r.count} ocorrência(s)`,
      })),
      notes: total === 0
        ? ["Sem dado: ative o registro de motivo de perda no fechamento dos tickets para alimentar esta seção."]
        : [],
    };
  }

  // --- 9. FUNIL & VELOCIDADE ------------------------------------------------
  private static s9FunilVelocidade(m: any): AuditSection {
    const funnel = (m.funnelByStage as any[]) || [];
    const velocity = (m.stageVelocity as any[]) || [];
    const slowest = velocity.slice().sort((a, b) => b.avgHours - a.avgHours)[0];
    return {
      id: "funnel_velocity",
      title: "Funil & Velocidade",
      headline: slowest
        ? `Etapa mais lenta: ${slowest.stage} (~${slowest.avgHours}h). Tempo médio até a venda: ${m.avgTimeToSaleHours || 0}h.`
        : `Tempo médio até a venda: ${m.avgTimeToSaleHours || 0}h.`,
      metrics: funnel.map(f => ({
        label: `Etapa: ${f.stage}`,
        value: `${f.count} ticket(s)`,
      })),
      rows: velocity.map(v => ({
        label: v.stage,
        value: `${v.avgHours}h em média (n=${v.n})`,
      })),
      notes: [
        "Drop-off forte entre dois estágios consecutivos indica onde o cliente trava — alvo natural do plano 30/60/90.",
      ],
    };
  }

  // --- 10. SATISFAÇÃO -------------------------------------------------------
  private static s10Satisfacao(m: any): AuditSection {
    const c = m.csat || { responses: 0, avgScore: 0, detractors: 0, satisfactionPct: 0 };
    return {
      id: "csat",
      title: "Satisfação & Voz do Cliente",
      headline: c.responses > 0
        ? `Nota média ${c.avgScore} (n=${c.responses}). ${c.satisfactionPct}% satisfeitos, ${c.detractors} detratores.`
        : "Sem respostas de CSAT no período. Ative a pesquisa pós-venda para ouvir o cliente.",
      metrics: c.responses > 0
        ? [
            { label: "Respostas no período", value: String(c.responses) },
            { label: "Nota média (1-5)", value: String(c.avgScore), tone: c.avgScore >= 4 ? "good" : c.avgScore >= 3 ? "warn" : "bad" },
            { label: "% de satisfeitos (nota ≥ 4)", value: this.pct(c.satisfactionPct) },
            { label: "Detratores (nota ≤ 3)", value: String(c.detractors), tone: c.detractors > 0 ? "warn" : "good" },
          ]
        : [],
      notes: c.responses === 0
        ? ["Sem dado: ative a pesquisa de satisfação em Configurações > Pós-venda."]
        : [],
    };
  }
}
