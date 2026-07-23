import { FinancialLedgerService } from "./FinancialLedgerService.js";
import { CashForecastService } from "./CashForecastService.js";
import { LossMarginService } from "./LossMarginService.js";
import { RevenueIntelligenceService } from "./RevenueIntelligenceService.js";
import { CashActionService } from "./CashActionService.js";
import { OwnerDrawService } from "./OwnerDrawService.js";
import { QuoteService } from "./QuoteService.js";
import { RetailImpactService } from "./RetailImpactService.js";
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
  source: "caixa" | "recebiveis" | "perdas" | "rie" | "retiradas";
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
  retiradas: "Em Empresa × Proprietário, veja o pró-labore sustentável sugerido e ajuste as retiradas para não descapitalizar o negócio.",
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
    if (cash.aReceberVencido > 0) triggers.push({ level: "atencao", code: "receber_vencido", label: `${brl(cash.aReceberVencido)} já venceram e não foram recebidos${cash.aReceberVencidoCount > 0 ? ` (${cash.aReceberVencidoCount} conta${cash.aReceberVencidoCount > 1 ? "s" : ""})` : ""}.` });
    // Retiradas do dono em excesso (ADR-129) — descapitaliza o negócio.
    const owner = this.ownerSummary(orgId);
    if (owner && owner.retiradas > 0) {
      if (owner.alerta?.nivel === "excesso") triggers.push({ level: "risco", code: "retiradas_excesso", label: owner.pctDoResultado != null ? `Retiradas do mês (${brl(owner.retiradas)}) = ${owner.pctDoResultado}% do resultado.` : `Retiradas de ${brl(owner.retiradas)} sem resultado que as cubra.` });
      else if (owner.alerta?.nivel === "atencao") triggers.push({ level: "atencao", code: "retiradas_altas", label: `Retiradas já são ${owner.pctDoResultado}% do resultado do mês.` });
    }

    // Conversão de orçamentos caindo (ADR-132 Fatia 2) — sinal comercial.
    const conversao = this.quoteConversion(orgId);
    if (conversao && conversao.signal === "caindo" && conversao.ratePct != null && conversao.prevRatePct != null) {
      triggers.push({ level: "atencao", code: "conversao_caiu", label: `Conversão de orçamentos caiu de ${conversao.prevRatePct}% para ${conversao.ratePct}%.` });
    }

    // Concentração no maior cliente (ADR-132 Fatia 3) — risco de dependência.
    const concentracao = this.customerConcentration(orgId);
    if (concentracao && concentracao.topPct >= 40) {
      triggers.push({ level: "atencao", code: "concentracao_cliente", label: `Seu maior cliente${concentracao.topName ? ` (${concentracao.topName})` : ""} é ${concentracao.topPct}% da receita — risco de dependência.` });
    }

    // Estoque parado sem giro (ADR-132 Fatia 4) — capital travado no produto errado.
    const estoque = this.stockSummary(orgId);
    if (estoque && estoque.slowMoverCapital > 0) {
      const rev = LossMarginService.monthlyRevenue(orgId, new Date().toISOString().slice(0, 7));
      const material = rev > 0 ? estoque.slowMoverCapital >= 0.15 * rev : estoque.slowMoverCapital > 0;
      if (material) triggers.push({ level: "atencao", code: "estoque_parado", label: `${brl(estoque.slowMoverCapital)} parados em estoque sem giro${estoque.slowMoverCount > 0 ? ` (${estoque.slowMoverCount} item${estoque.slowMoverCount > 1 ? "s" : ""})` : ""}.` });
    }

    const overall = (triggers.reduce<StatusLevel>((acc, t) => (SEVERITY[t.level] > SEVERITY[acc] ? t.level : acc), "saudavel"));
    return { status: overall, triggers, cash, forecast: fc, loss, owner, conversao, concentracao, estoque };
  }

  /** Conversão de orçamentos (guardada — nunca derruba a síntese). */
  private static quoteConversion(orgId: string): any | null {
    try { return QuoteService.conversionStats(orgId); } catch { return null; }
  }

  /** Capital de estoque + sem giro (guardado) — só os agregados, sem a lista. */
  private static stockSummary(orgId: string): { totalCapital: number; slowMoverCapital: number; slowMoverCount: number } | null {
    try {
      const sc = RetailImpactService.stockCapital(orgId) as any;
      if (!sc || Number(sc.itemsInStock) <= 0) return null;
      return { totalCapital: Number(sc.totalCapital) || 0, slowMoverCapital: Number(sc.slowMoverCapital) || 0, slowMoverCount: Number(sc.slowMoverCount) || 0 };
    } catch { return null; }
  }

  /**
   * Concentração de receita no maior cliente (ADR-132 Fatia 3). Determinístico:
   * soma vendas pagas (orders + comigo_orders) numa janela e mede a fatia do
   * maior cliente IDENTIFICADO sobre a receita TOTAL (inclui venda anônima, para
   * não superestimar). Isolado por organization_id.
   */
  static customerConcentration(orgId: string, days = 90): { topPct: number; topName: string | null; topRevenue: number; totalRevenue: number } | null {
    try {
      const win = `-${days} days`;
      const SALES = `
        SELECT contact_id, total_amount AS amt FROM orders
          WHERE organization_id = ? AND status IN ('pago','em_preparo','entregue','concluido') AND created_at >= datetime('now', ?)
        UNION ALL
        SELECT contact_id, total AS amt FROM comigo_orders
          WHERE organization_id = ? AND status IN ('paid','done') AND created_at >= datetime('now', ?)`;
      const total = Number((db.prepare(`SELECT COALESCE(SUM(amt),0) s FROM (${SALES})`).get(orgId, win, orgId, win) as any).s) || 0;
      if (total <= 0) return null;
      const top = db.prepare(`SELECT contact_id, SUM(amt) s FROM (${SALES}) WHERE contact_id IS NOT NULL GROUP BY contact_id ORDER BY s DESC LIMIT 1`).get(orgId, win, orgId, win) as any;
      if (!top || !top.contact_id) return { topPct: 0, topName: null, topRevenue: 0, totalRevenue: round2(total) };
      const c = db.prepare("SELECT name FROM contacts WHERE id = ? AND organization_id = ?").get(top.contact_id, orgId) as any;
      return { topPct: Math.round((Number(top.s) / total) * 100), topName: c?.name || null, topRevenue: round2(top.s), totalRevenue: round2(total) };
    } catch { return null; }
  }

  /** Resumo Empresa × Proprietário (guardado — pode falhar sem derrubar a síntese). */
  private static ownerSummary(orgId: string): any | null {
    try { return OwnerDrawService.summary(orgId); } catch { return null; }
  }

  /** Prioridades do dia (máx. 3), priorizadas por impacto em R$. */
  static priorities(orgId: string, ctx?: { cash?: any; forecast?: any; loss?: any; owner?: any }): Priority[] {
    const cash = ctx?.cash || FinancialLedgerService.summary(orgId);
    const fc = ctx?.forecast || CashForecastService.forecast(orgId, { minCash: 0 });
    const loss = ctx?.loss || LossMarginService.monthlySummary(orgId);
    const owner = ctx?.owner !== undefined ? ctx.owner : this.ownerSummary(orgId);
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
      const vencido = Number(cash.aReceberVencido) || 0;
      cands.push({
        source: "recebiveis",
        title: vencido > 0 ? `Cobrar ${brl(vencido)} já vencido (de ${brl(cash.aReceber)} a receber)` : `Cobrar ${brl(cash.aReceber)} a receber`,
        impact: round2(cash.aReceber), basis: "fato",
        fato: vencido > 0
          ? `${brl(vencido)} já vencido${cash.aReceberVencidoCount > 0 ? ` em ${cash.aReceberVencidoCount} conta(s)` : ""} — de ${brl(cash.aReceber)} totais (${brl(cash.aReceberDetalhe?.fiado || 0)} em fiado).`
          : `${brl(cash.aReceberDetalhe?.fiado || 0)} em fiado + ${brl(cash.aReceberDetalhe?.manual || 0)} em contas a receber.`,
        interpretacao: vencido > 0 ? "Contas que já passaram do vencimento — prioridade de cobrança." : "Dinheiro que já é seu e ainda não entrou no caixa.",
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

    if (owner && owner.alerta?.nivel === "excesso" && owner.retiradas > 0) {
      cands.push({
        source: "retiradas", title: "Reveja suas retiradas", impact: round2(owner.retiradas), basis: "fato",
        fato: owner.pctDoResultado != null ? `Retiradas de ${brl(owner.retiradas)} = ${owner.pctDoResultado}% do resultado do mês.` : `Retiradas de ${brl(owner.retiradas)} com resultado do mês zerado/negativo.`,
        interpretacao: "Tirar mais do que o negócio gerou come o capital de giro.",
        risco: "Descapitalização silenciosa — o caixa mingua sem a venda cair.",
        action: { view: "reports", label: "Ver Empresa × Proprietário" },
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
    caixa: "outro", recebiveis: "cobrar_receber", perdas: "reduzir_compra", rie: "campanha", retiradas: "outro",
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
    const priorities = this.priorities(orgId, { cash: st.cash, forecast: st.forecast, loss: st.loss, owner: st.owner });
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
      kpis: { caixaAtual: st.cash.caixaAtual, aReceber: st.cash.aReceber, aReceberVencido: st.cash.aReceberVencido, aPagar: st.cash.aPagar, survivalDays: st.forecast.survivalDays },
      conversao: st.conversao || null,
      concentracao: st.concentracao || null,
      estoque: st.estoque || null,
    };
  }
}

export default BusinessHealthService;
