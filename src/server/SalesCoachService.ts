import db from "./db.js";
import { ManagerSolutionRetrievalService } from "./ManagerSolutionRetrievalService.js";

/**
 * SalesCoachService — Sales Coach (ADR-202, F5 do GAP-CLOSURE-03). TREINA O VENDEDOR,
 * NUNCA fala com cliente (RN-SC-1). Advisório/read-mostly (RN-SC-2).
 *
 * F1 — performanceSnapshot: read-model DETERMINÍSTICO (RN-SC-4, RN-004) do desempenho
 * de UM vendedor, COMPONDO as fontes que já existem — sem tabela nova, sem LLM, sem
 * envio. Roda em CI.
 *
 * FONTE por PRECEDÊNCIA (nunca soma as três — dobraria contagem): ERP
 * (`retail_erp_seller_sales`, autoritativo) > manual/foto (`retail_seller_sales`) >
 * PDV por-ordem (`orders.seller_user_id`, quando o vendedor tem usuário ZappFlow). A
 * fonte usada é ROTULADA no retorno (procedência honesta). Sem dado → hasData=false,
 * source=null, séries vazias e nulos (null≠0, RN-SC-3). Isolado por org (RN-SC-6).
 */

const NON_SALE = ["cancelado", "reembolso", "devolucao"]; // mesmos status excluídos pelo PeoplePatternMemory
const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

export interface MonthlyPoint { ym: string; valor: number; pecas: number | null }
export interface PerformanceSnapshot {
  seller: { id: string; matricula: string; name: string | null; active: boolean } | null;
  source: "erp" | "manual" | "orders" | null;
  monthly: MonthlyPoint[];
  totals: { valor: number; pecas: number | null; months: number; avgTicket: number | null };
  trend: { firstMonthly: number | null; lastMonthly: number | null; deltaPct: number | null; direction: "up" | "down" | "flat" | null };
  window: { from: string; asOf: string; months: number };
  hasData: boolean;
}

function monthsBefore(asOfISO: string, months: number): string {
  const d = new Date(`${asOfISO}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - Math.max(1, months));
  return d.toISOString().slice(0, 10);
}

const MIN_DECLINES = 3; // mesma regra do PeoplePatternMemory (≥3 quedas mês-a-mês, precisa ≥4 meses)
export type GapSeverity = "high" | "medium" | "low";
export interface CoachGap { key: string; severity: GapSeverity; label: string; detail: string; basis: any }
export interface GapsResult {
  seller: { id: string; matricula: string; name: string | null; active: boolean } | null;
  hasData: boolean;
  gaps: CoachGap[];
  teamBaseline: { avgMonthlyValor: number | null; avgTicket: number | null; sellers: number } | null;
}
function median(xs: number[]): number | null {
  const a = xs.filter((n) => Number.isFinite(n)).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : Math.round(((a[m - 1] + a[m]) / 2) * 100) / 100;
}

export class SalesCoachService {
  /**
   * Retrato de desempenho do vendedor na janela (default 6 meses). Determinístico e
   * read-only. `sellerId` é `retail_sellers.id`. Sem dado em nenhuma fonte → honesto.
   */
  static performanceSnapshot(orgId: string, sellerId: string, opts: { months?: number; asOf?: string } = {}): PerformanceSnapshot {
    const months = Math.max(1, Math.min(24, parseInt(String(opts.months), 10) || 6));
    const asOf = /^\d{4}-\d{2}-\d{2}$/.test(opts.asOf || "") ? opts.asOf! : new Date().toISOString().slice(0, 10);
    const from = monthsBefore(asOf, months);
    const empty: PerformanceSnapshot = {
      seller: null, source: null, monthly: [],
      totals: { valor: 0, pecas: null, months: 0, avgTicket: null },
      trend: { firstMonthly: null, lastMonthly: null, deltaPct: null, direction: null },
      window: { from, asOf, months }, hasData: false,
    };

    const s = db.prepare("SELECT id, matricula, name, user_id, active FROM retail_sellers WHERE id = ? AND organization_id = ?").get(sellerId, orgId) as any;
    if (!s) return empty; // vendedor inexistente/de outra org → honesto, nunca cruza tenant
    const seller = { id: s.id, matricula: s.matricula, name: s.name || null, active: s.active !== 0 };

    // Série mensal por PRECEDÊNCIA — a primeira fonte com dado vence (nunca soma).
    const erp = db.prepare(
      `SELECT strftime('%Y-%m', sale_date) ym, SUM(valor) valor, SUM(pecas) pecas
         FROM retail_erp_seller_sales WHERE organization_id = ? AND matricula = ? AND sale_date BETWEEN ? AND ?
        GROUP BY ym ORDER BY ym`
    ).all(orgId, seller.matricula, from, asOf) as any[];
    const manual = erp.length ? [] : db.prepare(
      `SELECT strftime('%Y-%m', sale_date) ym, SUM(valor) valor, SUM(pecas) pecas
         FROM retail_seller_sales WHERE organization_id = ? AND matricula = ? AND sale_date BETWEEN ? AND ?
        GROUP BY ym ORDER BY ym`
    ).all(orgId, seller.matricula, from, asOf) as any[];
    const orders = (erp.length || manual.length || !s.user_id) ? [] : db.prepare(
      `SELECT strftime('%Y-%m', created_at) ym, SUM(total_amount) valor
         FROM orders WHERE organization_id = ? AND seller_user_id = ?
          AND status NOT IN ('${NON_SALE.join("','")}') AND date(created_at) BETWEEN ? AND ?
        GROUP BY ym ORDER BY ym`
    ).all(orgId, s.user_id, from, asOf) as any[];

    let source: PerformanceSnapshot["source"] = null;
    let rows: any[] = [];
    let hasPecas = false;
    if (erp.length) { source = "erp"; rows = erp; hasPecas = true; }
    else if (manual.length) { source = "manual"; rows = manual; hasPecas = true; }
    else if (orders.length) { source = "orders"; rows = orders; hasPecas = false; } // orders não tem contagem de peças

    if (!rows.length) return { ...empty, seller }; // vendedor existe, mas sem venda na janela

    const monthly: MonthlyPoint[] = rows.map((r) => ({ ym: r.ym, valor: round2(r.valor), pecas: hasPecas ? Number(r.pecas) || 0 : null }));
    const valorTotal = round2(monthly.reduce((a, m) => a + m.valor, 0));
    const pecasTotal = hasPecas ? monthly.reduce((a, m) => a + (m.pecas || 0), 0) : null;
    const avgTicket = pecasTotal && pecasTotal > 0 ? round2(valorTotal / pecasTotal) : null; // sem peças conhecidas → null (não inventa)
    const firstMonthly = monthly[0].valor;
    const lastMonthly = monthly[monthly.length - 1].valor;
    const deltaPct = firstMonthly > 0 ? round2(((lastMonthly - firstMonthly) / firstMonthly) * 100) : null;
    const direction: PerformanceSnapshot["trend"]["direction"] =
      monthly.length < 2 ? null : lastMonthly > firstMonthly ? "up" : lastMonthly < firstMonthly ? "down" : "flat";

    return {
      seller, source, monthly,
      totals: { valor: valorTotal, pecas: pecasTotal, months: monthly.length, avgTicket },
      trend: { firstMonthly, lastMonthly, deltaPct, direction },
      window: { from, asOf, months }, hasData: true,
    };
  }

  /**
   * F2 — gaps: identificação DETERMINÍSTICA (RN-SC-4) dos gaps do vendedor, derivada do
   * snapshot (F1) + comparação com o TIME. Advisória e qualitativa (RN-SC-2 — severidade
   * high/medium/low, nunca "nota" que pune). Grounded: cada gap carrega os números que o
   * sustentam; sem base → `insufficient_data` honesto (RN-SC-3). Isolado por org (RN-SC-6).
   *
   * A "queda recorrente" aplica a MESMA regra do PeoplePatternMemory (≥3 quedas mês-a-mês)
   * à série já composta do snapshot — não é um motor paralelo (RN-SC-8): o detector
   * canônico de APRENDIZADO segue sendo o PeoplePatternMemory; aqui é read-model.
   */
  static gaps(orgId: string, sellerId: string, opts: { months?: number; asOf?: string } = {}): GapsResult {
    const snap = this.performanceSnapshot(orgId, sellerId, opts);
    if (!snap.seller) return { seller: null, hasData: false, gaps: [], teamBaseline: null };
    if (!snap.hasData) {
      return { seller: snap.seller, hasData: false, teamBaseline: null,
        gaps: [{ key: "insufficient_data", severity: "low", label: "Sem base ainda", detail: "Não há vendas registradas na janela para avaliar o desempenho.", basis: { window: snap.window } }] };
    }

    const gaps: CoachGap[] = [];

    // 1) Queda recorrente (mesma regra do PeoplePatternMemory, sobre a série do snapshot).
    let declines = 0;
    for (let i = 1; i < snap.monthly.length; i++) if (snap.monthly[i].valor < snap.monthly[i - 1].valor) declines++;
    if (snap.monthly.length >= MIN_DECLINES + 1 && declines >= MIN_DECLINES) {
      const d = snap.trend.deltaPct;
      const severity: GapSeverity = d !== null && d <= -30 ? "high" : d !== null && d <= -15 ? "medium" : "low";
      gaps.push({ key: "declining_trend", severity, label: "Vendas em queda recorrente",
        detail: `${declines} meses de queda na janela (de ${snap.trend.firstMonthly} para ${snap.trend.lastMonthly}${d !== null ? `, ${d}%` : ""}).`,
        basis: { declines, months: snap.monthly.length, deltaPct: d } });
    }

    // 2) Comparação com o TIME — baseline por mediana dos vendedores com dado na janela.
    const team = db.prepare("SELECT id FROM retail_sellers WHERE organization_id = ? AND active = 1 LIMIT 500").all(orgId) as any[];
    const valorsMensais: number[] = []; const tickets: number[] = [];
    let myAvgMonthly: number | null = null; let myTicket: number | null = snap.totals.avgTicket;
    for (const t of team) {
      const ss = t.id === sellerId ? snap : this.performanceSnapshot(orgId, t.id, opts);
      if (!ss.hasData || ss.totals.months === 0) continue;
      const avgMonthly = Math.round((ss.totals.valor / ss.totals.months) * 100) / 100;
      valorsMensais.push(avgMonthly);
      if (ss.totals.avgTicket !== null) tickets.push(ss.totals.avgTicket);
      if (t.id === sellerId) myAvgMonthly = avgMonthly;
    }
    const baseValor = median(valorsMensais);
    const baseTicket = median(tickets);
    const teamBaseline = { avgMonthlyValor: baseValor, avgTicket: baseTicket, sellers: valorsMensais.length };

    // Só sinaliza "abaixo do time" com ≥2 vendedores comparáveis (baseline com significado).
    if (valorsMensais.length >= 2 && baseValor !== null && myAvgMonthly !== null && myAvgMonthly < baseValor * 0.7) {
      const ratio = baseValor > 0 ? myAvgMonthly / baseValor : 1;
      const severity: GapSeverity = ratio <= 0.5 ? "high" : "medium";
      gaps.push({ key: "below_team_valor", severity, label: "Venda mensal abaixo do time",
        detail: `Média mensal de ${myAvgMonthly} vs mediana do time ${baseValor}.`,
        basis: { myAvgMonthly, teamMedian: baseValor, sellers: valorsMensais.length } });
    }
    if (tickets.length >= 2 && baseTicket !== null && myTicket !== null && myTicket < baseTicket * 0.7) {
      gaps.push({ key: "below_team_ticket", severity: "medium", label: "Ticket médio abaixo do time",
        detail: `Ticket médio de ${myTicket} vs mediana do time ${baseTicket}.`,
        basis: { myTicket, teamMedian: baseTicket, sellers: tickets.length } });
    }

    return { seller: snap.seller, hasData: true, gaps, teamBaseline };
  }

  /**
   * F3 — feedback DETERMINÍSTICO (RN-SC-4, roda em CI sem IA): transforma os gaps (F2)
   * em pontos de treino GROUNDED (RN-SC-3 — só os números dos gaps, nunca inventa),
   * em tom advisório (RN-SC-2 — sugere, nunca pune). É a base garantida; o rephrase por
   * LLM (feedbackAsync) é opcional e cai NESTE resultado se a IA falhar/ausente.
   */
  static feedback(orgId: string, sellerId: string, opts: { months?: number; asOf?: string } = {}): {
    seller: GapsResult["seller"]; hasData: boolean; headline: string;
    points: { key: string; severity: GapSeverity; text: string }[]; gaps: CoachGap[];
  } {
    const g = this.gaps(orgId, sellerId, opts);
    if (!g.seller) return { seller: null, hasData: false, headline: "", points: [], gaps: [] };
    const name = g.seller.name || "o vendedor";

    if (!g.hasData) {
      return { seller: g.seller, hasData: false, headline: "Sem base para avaliar ainda",
        points: [{ key: "insufficient_data", severity: "low", text: "Ainda não há vendas registradas na janela — registre as vendas para o coach conseguir orientar." }], gaps: g.gaps };
    }

    const points = g.gaps.map((gap) => ({ key: gap.key, severity: gap.severity, text: coachLine(gap, g.teamBaseline) }));
    let headline: string;
    if (!g.gaps.length) headline = `Desempenho saudável — mantenha o ritmo.`;
    else if (g.gaps.some((x) => x.severity === "high")) headline = `Pontos importantes para trabalhar com ${name}.`;
    else headline = `Alguns pontos para melhorar com ${name}.`;
    if (!g.gaps.length) points.push({ key: "healthy", severity: "low", text: "Sem gaps detectados na janela. Reforce o que está funcionando e mantenha a constância." });

    return { seller: g.seller, hasData: true, headline, points, gaps: g.gaps };
  }

  /**
   * F3 — feedbackAsync: reescreve o feedback determinístico em tom de treino via o
   * primitivo de IA da casa (`chat`, tier economy — determinístico ANTES de LLM,
   * RN-SC-4/8, NÃO é motor novo). GROUNDED por prompt (só os pontos, não inventa).
   * Best-effort: sem chave/erro → cai no texto determinístico (aiUsed=false). NUNCA
   * gera nada para o cliente (RN-SC-1) — é feedback para o vendedor.
   */
  static async feedbackAsync(orgId: string, sellerId: string, opts: { months?: number; asOf?: string } = {}): Promise<{
    seller: GapsResult["seller"]; hasData: boolean; headline: string;
    points: { key: string; severity: GapSeverity; text: string }[]; narrative: string; aiUsed: boolean;
  }> {
    const fb = this.feedback(orgId, sellerId, opts);
    const base = [fb.headline, ...fb.points.map((p) => `- ${p.text}`)].filter(Boolean).join("\n");
    if (!fb.seller || !fb.hasData || !fb.points.length) return { ...fb, narrative: base, aiUsed: false };
    try {
      const { chat } = await import("./llm.js");
      const prompt = `Você é um COACH DE VENDAS INTERNO do ZappFlow. Reescreva o feedback abaixo para o VENDEDOR (nunca para o cliente), em português do Brasil, tom direto, respeitoso e de treino, em no máximo 5 frases. Use SOMENTE os pontos abaixo — NÃO invente números nem fatos.\n\n${base}`;
      const out = (await chat(prompt, { temperature: 0.3, tier: "economy" })).trim();
      return { seller: fb.seller, hasData: fb.hasData, headline: fb.headline, points: fb.points, narrative: out || base, aiUsed: !!out };
    } catch {
      return { seller: fb.seller, hasData: fb.hasData, headline: fb.headline, points: fb.points, narrative: base, aiUsed: false };
    }
  }

  /** Loja mais frequente do vendedor (para o caveat de contexto da solução). null = rede. */
  private static primaryStore(orgId: string, matricula: string): string | null {
    const r = db.prepare(
      `SELECT store_id, COUNT(*) c FROM (
         SELECT store_id FROM retail_seller_sales WHERE organization_id = ? AND matricula = ? AND store_id IS NOT NULL
         UNION ALL
         SELECT store_id FROM retail_erp_seller_sales WHERE organization_id = ? AND matricula = ? AND store_id IS NOT NULL
       ) GROUP BY store_id ORDER BY c DESC LIMIT 1`
    ).get(orgId, matricula, orgId, matricula) as any;
    return r?.store_id || null;
  }

  /**
   * F4 — soluções de gerente VALIDADAS aplicáveis ao vendedor (ADR-174). REUSA o
   * `ManagerSolutionRetrievalService` (RN-SC-8 — sem motor novo), que já rotula ORIGEM
   * HUMANA + onde funcionou + evidência + caveat + claim condicional (RN-SC-5: nunca
   * "verdade da IA", nunca afirma eficácia geral). Read-only, isolado por org (RN-SC-6).
   *
   * `targeted`: soluções que endereçam o TIPO de padrão do gap do vendedor (hoje só a
   * queda recorrente ↔ vendedor_queda_recorrente). `general`: demais soluções validadas
   * do org (conhecimento disponível para o gestor), deduplicadas. Sem solução → vazio
   * (não inventa). O caveat/loja usa a loja mais frequente do vendedor.
   */
  static solutionsForSeller(orgId: string, sellerId: string, opts: { months?: number; asOf?: string } = {}): {
    seller: GapsResult["seller"]; hasData: boolean; gapTypes: string[]; targeted: any[]; general: any[];
  } {
    const g = this.gaps(orgId, sellerId, opts);
    if (!g.seller) return { seller: null, hasData: false, gapTypes: [], targeted: [], general: [] };
    const storeId = this.primaryStore(orgId, g.seller.matricula);

    const gapTypes = [...new Set(g.gaps.map((x) => GAP_TO_PATTERN_TYPE[x.key]).filter(Boolean))];
    const seen = new Set<string>();
    const targeted: any[] = [];
    for (const pt of gapTypes) {
      for (const s of ManagerSolutionRetrievalService.retrieve(orgId, { patternType: pt, storeId })) {
        if (s.proposalId) { if (seen.has(s.proposalId)) continue; seen.add(s.proposalId); }
        targeted.push(s);
      }
    }
    const general = ManagerSolutionRetrievalService.retrieve(orgId, { storeId })
      .filter((s: any) => !(s.proposalId && seen.has(s.proposalId)));

    return { seller: g.seller, hasData: g.hasData, gapTypes, targeted, general };
  }
}

// Mapeia gap do coach → tipo de padrão que uma solução de gerente endereçaria.
// Só o que dá para justificar 1:1 (queda do vendedor ↔ vendedor_queda_recorrente,
// o mesmo tipo que o PeoplePatternMemory publica). Gaps sem tipo canônico não
// mapeiam — não inventa correspondência (RN-SC-3).
const GAP_TO_PATTERN_TYPE: Record<string, string> = { declining_trend: "vendedor_queda_recorrente" };

/** Linha de treino determinística e grounded para um gap. Advisória (sugere, não pune). */
function coachLine(gap: CoachGap, baseline: GapsResult["teamBaseline"]): string {
  switch (gap.key) {
    case "declining_trend":
      return `Vendas em queda ${gap.basis?.declines ?? ""} meses seguidos${gap.basis?.deltaPct != null ? ` (${gap.basis.deltaPct}%)` : ""} — vale entender a causa (meta, atrito no atendimento, mix) e retomar o ritmo.`;
    case "below_team_valor":
      return `Venda mensal (${gap.basis?.myAvgMonthly}) abaixo da mediana do time (${gap.basis?.teamMedian}) — foco em volume e constância na abordagem.`;
    case "below_team_ticket":
      return `Ticket médio (${gap.basis?.myTicket}) abaixo do time (${gap.basis?.teamMedian}) — trabalhe venda adicional e mix de maior valor.`;
    default:
      return gap.detail || gap.label;
  }
}

export default SalesCoachService;
