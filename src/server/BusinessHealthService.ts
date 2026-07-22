import { FinancialLedgerService } from "./FinancialLedgerService.js";
import { CashForecastService } from "./CashForecastService.js";
import { LossMarginService } from "./LossMarginService.js";
import { RevenueIntelligenceService } from "./RevenueIntelligenceService.js";
import { CashActionService } from "./CashActionService.js";
import db from "./db.js";

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
  howTo?: string;
}

// "Como fazer" por origem — passo prático (modo Tutor, zero-token).
const HOWTO: Record<Priority["source"], string> = {
  caixa: "Abra o Plano de Caixa: comece cobrando o que já é seu e negociando as contas da semana crítica antes de dar desconto.",
  recebiveis: "Na Caderneta, mande o lembrete gentil (a cobrança cortês já vem pronta) e combine o pagamento — sem expor ninguém.",
  perdas: "Nos Relatórios, veja o diagnóstico de perdas: o driver que mais pesa já vem com uma sugestão específica de redução.",
  rie: "No Revenue Intelligence, gere a ação de recuperação (rascunho) para os leads, orçamentos e carrinhos parados.",
};

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

    return cands.sort((a, b) => b.impact - a.impact).slice(0, 3).map((p) => ({ ...p, howTo: HOWTO[p.source] }));
  }

  /**
   * Checklist de qualidade dos dados (ADR-126 Fatia 3): mostra o que já foi
   * informado e o que falta — quanto mais completo, mais confiável o diagnóstico.
   */
  static dataQuality(orgId: string) {
    const hasCash = ((db.prepare("SELECT COUNT(*) c FROM cash_events WHERE organization_id = ?").get(orgId) as any).c > 0)
      || ((db.prepare("SELECT COUNT(*) c FROM cash_accounts WHERE organization_id = ? AND current_balance <> 0").get(orgId) as any).c > 0);
    const items = [
      { key: "caixa", label: "Saldo/movimento de caixa informado", ok: hasCash },
      { key: "pagar", label: "Contas a pagar cadastradas", ok: FinancialLedgerService.listPayables(orgId, "open").length > 0 },
      { key: "receber", label: "Contas a receber / fiado", ok: FinancialLedgerService.listReceivables(orgId, "open").length > 0 || FinancialLedgerService.fiadoOutstanding(orgId) > 0 },
      { key: "meta_perda", label: "Meta de perda aceitável definida", ok: LossMarginService.config(orgId).acceptablePct > 0 },
      { key: "vendas", label: "Vendas registradas no mês", ok: LossMarginService.monthlyRevenue(orgId, new Date().toISOString().slice(0, 7)) > 0 },
    ];
    const done = items.filter((i) => i.ok).length;
    const pct = Math.round((done / items.length) * 100);
    const level = pct >= 80 ? "alta" : pct >= 40 ? "media" : "baixa";
    return { items, done, total: items.length, pct, level };
  }

  /**
   * Narrativa "do Diretor" (ADR-126 Fatia 3): leitura em linguagem natural do
   * status + a primeira prioridade + a qualidade dos dados. Determinística
   * (zero-token) por padrão; a narração rica via LLM (Diretor IA) pluga sob
   * demanda quando o módulo está ligado.
   */
  static narrative(orgId: string, ctx: { statusLabel: string; synthesis: string; priorities: Priority[]; dataQuality: any }) {
    const p = ctx.priorities[0];
    const parts = [`Hoje seu negócio está ${ctx.statusLabel.toLowerCase()}.`, ctx.synthesis];
    if (p?.howTo) parts.push(`Passo prático: ${p.howTo}`);
    if (ctx.dataQuality.level !== "alta") parts.push(`Obs.: com ${ctx.dataQuality.pct}% dos dados informados, trate os números como estimativa — complete o checklist para eu ficar mais preciso.`);
    return parts.join(" ");
  }

  // Mapeia a ORIGEM da prioridade para o tipo de ação do Impact Ledger (ADR-125).
  private static KIND_BY_SOURCE: Record<Priority["source"], string> = {
    caixa: "outro", recebiveis: "cobrar_receber", perdas: "reduzir_compra", rie: "campanha",
  };

  /** Títulos das ações abertas no Impact Ledger (para marcar "já no plano"). */
  private static openTitles(orgId: string): Set<string> {
    const rows = db.prepare("SELECT title FROM cash_actions WHERE organization_id = ? AND status = 'accepted'").all(orgId) as any[];
    return new Set(rows.map((r) => String(r.title)));
  }

  /**
   * "Aplicar recomendação" (ADR-126 Fatia 2): registra a prioridade como ação no
   * Impact Ledger unificado (ADR-125). Não executa nada — vira intenção medível.
   * Idempotente por título aberto (não duplica a mesma recomendação).
   */
  static apply(orgId: string, input: { source: string; title: string; impact?: number; rationale?: string; baselineShortfall?: number }, actorId?: string) {
    if (!input.title) return { ok: false as const, error: "title_required" };
    if (this.openTitles(orgId).has(input.title)) return { ok: true as const, deduped: true };
    const kind = this.KIND_BY_SOURCE[input.source as Priority["source"]] || "outro";
    return CashActionService.create(orgId, { kind, title: input.title, rationale: input.rationale, expectedImpact: input.impact, baselineShortfall: input.baselineShortfall, createdBy: actorId });
  }

  /** Histórico de recomendações = Impact Ledger unificado (esperado × realizado). */
  static history(orgId: string) {
    return CashActionService.ledger(orgId);
  }

  /** Payload da tela: status + gatilhos + frase-síntese + top-3 + Impact Ledger. */
  static overview(orgId: string, minCash = 0) {
    const st = this.status(orgId, minCash);
    const priorities = this.priorities(orgId, { cash: st.cash, forecast: st.forecast, loss: st.loss });
    const open = this.openTitles(orgId);
    const label: Record<StatusLevel, string> = { saudavel: "Saudável", atencao: "Atenção", risco: "Risco", critico: "Crítico" };
    let synthesis: string;
    if (st.status === "saudavel") synthesis = "Sem alertas hoje. Siga cuidando do caixa e das vendas.";
    else if (priorities[0]) synthesis = `${st.triggers[0]?.label || "Há pontos de atenção."} Comece por: ${priorities[0].title.toLowerCase()}.`;
    else synthesis = st.triggers[0]?.label || "Há pontos de atenção.";
    const statusLabel = label[st.status];
    const dataQuality = this.dataQuality(orgId);
    const narrative = this.narrative(orgId, { statusLabel, synthesis, priorities, dataQuality });
    return {
      status: st.status,
      statusLabel,
      triggers: st.triggers,
      synthesis,
      narrative,
      dataQuality,
      priorities: priorities.map((p) => ({ ...p, inPlan: open.has(p.title) })),
      ledger: this.history(orgId),
      kpis: { caixaAtual: st.cash.caixaAtual, aReceber: st.cash.aReceber, aPagar: st.cash.aPagar, survivalDays: st.forecast.survivalDays },
    };
  }
}

export default BusinessHealthService;
