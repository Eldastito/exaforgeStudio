import db from "./db.js";

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
}

export default SalesCoachService;
