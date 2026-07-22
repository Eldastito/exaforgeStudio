import db from "./db.js";

/**
 * ZappFlow Comigo — Termômetro de Saúde (ADR-116 / ADR-088 D7).
 *
 * Não é gráfico: é um SINAL (subindo/estável/caindo) que pesa LUCRO (não
 * faturamento), comparando com o MESMO período (sábado × sábado passado) para
 * não mentir em negócio sazonal. Deriva ponto de equilíbrio + meta ao vivo e
 * uma frase-conselho. Tudo por template (zero-token), isolado por organização.
 *
 * Lucro = Σ(preço) − Σ(custo por item), usando unit_cost_snapshot (PR #2). Conta
 * vendas paid/done (fiado é venda/margem no ato — ADR-112 D3), pela data da venda.
 */

const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
const pct = (cur: number, prev: number) => (prev > 0 ? round2(((cur - prev) / prev) * 100) : (cur > 0 ? 100 : 0));

// Aritmética de datas em UTC (YYYY-MM-DD), estável e sem fuso surpresa.
function isoDay(d: Date): string { return d.toISOString().slice(0, 10); }
function addDays(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return isoDay(d);
}

export type Period = "dia" | "semana" | "mes";
const LABEL: Record<Period, string> = { dia: "dia", semana: "semana", mes: "mês" };

export class ComigoHealthService {
  /** Receita, custo e lucro das vendas (paid/done) num intervalo [from, to] (datas ISO). */
  static rangeResult(orgId: string, from: string, to: string) {
    const row = db.prepare(`
      SELECT
        COALESCE(SUM(oi.qty * oi.unit_price), 0) AS revenue,
        COALESCE(SUM(oi.qty * oi.unit_cost_snapshot), 0) AS cost,
        COALESCE(SUM(oi.qty), 0) AS units,
        COUNT(DISTINCT o.id) AS orders
      FROM comigo_orders o JOIN comigo_order_items oi ON oi.order_id = o.id
      WHERE o.organization_id = ? AND o.status IN ('paid','done') AND date(o.created_at) BETWEEN ? AND ?
    `).get(orgId, from, to) as any;
    const revenue = round2(row.revenue);
    const cost = round2(row.cost);
    return { revenue, cost, profit: round2(revenue - cost), units: Number(row.units) || 0, orders: Number(row.orders) || 0 };
  }

  /** Janelas de comparação do MESMO período (ADR-116 D3). `today` p/ testes. */
  static windows(period: Period, today: string) {
    if (period === "semana") {
      return { curFrom: addDays(today, -6), curTo: today, prevFrom: addDays(today, -13), prevTo: addDays(today, -7) };
    }
    if (period === "mes") {
      return { curFrom: addDays(today, -29), curTo: today, prevFrom: addDays(today, -59), prevTo: addDays(today, -30) };
    }
    // dia: hoje × mesmo dia da semana passada (7 dias atrás).
    return { curFrom: today, curTo: today, prevFrom: addDays(today, -7), prevTo: addDays(today, -7) };
  }

  static trend(orgId: string, period: Period, today = isoDay(new Date()), thresholdPct = 5) {
    const w = this.windows(period, today);
    const cur = this.rangeResult(orgId, w.curFrom, w.curTo);
    const prev = this.rangeResult(orgId, w.prevFrom, w.prevTo);
    const profitDeltaPct = pct(cur.profit, prev.profit);
    const vendasDeltaPct = pct(cur.revenue, prev.revenue);
    let signal: "subindo" | "estavel" | "caindo" = "estavel";
    if (profitDeltaPct > thresholdPct) signal = "subindo";
    else if (profitDeltaPct < -thresholdPct) signal = "caindo";
    return { period, signal, profit: cur.profit, prevProfit: prev.profit, profitDeltaPct, vendasDeltaPct, revenue: cur.revenue, prevRevenue: prev.revenue, orders: cur.orders };
  }

  /** Ponto de equilíbrio do dia + progresso ao vivo (ADR-116 D4). */
  static breakEven(orgId: string, today = isoDay(new Date())) {
    const fixedMonthly = Number((db.prepare("SELECT comigo_fixed_costs_monthly FROM organization_settings WHERE organization_id = ?").get(orgId) as any)?.comigo_fixed_costs_monthly) || 0;
    const dailyFixed = round2(fixedMonthly / 30);
    // Margem média + ticket médio de uma janela recente (últimos 30 dias).
    const win = this.rangeResult(orgId, addDays(today, -29), today);
    const avgMargin = win.revenue > 0 ? win.profit / win.revenue : 0;
    const avgTicket = win.orders > 0 ? win.revenue / win.orders : 0;
    const breakEvenRevenue = avgMargin > 0 ? round2(dailyFixed / avgMargin) : 0;
    const breakEvenUnits = avgTicket > 0 && breakEvenRevenue > 0 ? Math.ceil(breakEvenRevenue / avgTicket) : 0;
    const todayR = this.rangeResult(orgId, today, today);
    const progress = breakEvenRevenue > 0 ? round2(Math.min(1, todayR.revenue / breakEvenRevenue)) : 0;
    return {
      hasFixedCosts: fixedMonthly > 0,
      dailyFixed, avgMargin: round2(avgMargin), avgTicket: round2(avgTicket),
      breakEvenRevenue, breakEvenUnits,
      achievedRevenue: todayR.revenue, achievedUnits: todayR.units, achievedOrders: todayR.orders,
      progress,
    };
  }

  /** Uma frase + uma ação, por template (zero-token — ADR-116 D5). */
  static insight(orgId: string, period: Period, today = isoDay(new Date())): { text: string; signal: string } {
    const t = this.trend(orgId, period, today);
    const lbl = LABEL[period] || "período";
    let text: string;
    if (t.signal === "subindo") text = `Tá sobrando mais: seu lucro subiu ${Math.abs(t.profitDeltaPct)}% neste ${lbl}. Continua assim! 🚀`;
    else if (t.signal === "caindo" && t.vendasDeltaPct >= 0) text = `Você vendeu igual ou mais, mas sobrou menos neste ${lbl} — o custo subiu. Revê o preço do que mais sai. 🔎`;
    else if (t.signal === "caindo") text = `Movimento mais fraco que no mesmo ${lbl} anterior. Manda o cardápio pros seus clientes pra dar um gás. 📣`;
    else text = `Firme, no mesmo ritmo do ${lbl} anterior. 👍`;
    return { text, signal: t.signal };
  }

  /** Payload completo do termômetro para a UI. */
  static overview(orgId: string, period: Period = "dia", today = isoDay(new Date())) {
    return { ...this.trend(orgId, period, today), breakEven: this.breakEven(orgId, today), insight: this.insight(orgId, period, today).text };
  }
}

export default ComigoHealthService;
