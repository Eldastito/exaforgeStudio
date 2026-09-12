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
}

export default SalesCoachService;
