import db from "./db.js";

interface FilterOptions {
  period: "today" | "week" | "month" | "all";
}

// Filtro de data do período atual (sobre uma coluna created_at).
function currentFilter(period: FilterOptions["period"]): string {
  if (period === "today") return "AND date(created_at) = date('now')";
  if (period === "week") return "AND created_at >= datetime('now', '-7 days')";
  if (period === "month") return "AND created_at >= datetime('now', '-30 days')";
  return "";
}

// Filtro do período ANTERIOR equivalente (para calcular variação %).
function previousFilter(period: FilterOptions["period"]): string | null {
  if (period === "today") return "AND date(created_at) = date('now', '-1 day')";
  if (period === "week") return "AND created_at >= datetime('now', '-14 days') AND created_at < datetime('now', '-7 days')";
  if (period === "month") return "AND created_at >= datetime('now', '-60 days') AND created_at < datetime('now', '-30 days')";
  return null; // 'all' não tem período anterior
}

function pctDelta(current: number, previous: number): number {
  if (previous > 0) return Math.round(((current - previous) / previous) * 1000) / 10;
  if (current > 0) return 100;
  return 0;
}

// Monta uma série alinhada aos últimos N dias (preenchendo 0 onde não há dado).
function buildDailySeries(rows: { date: string; count: number }[], days = 7): number[] {
  const map = new Map(rows.map(r => [r.date, r.count]));
  const out: number[] = [];
  const now = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(now.getDate() - i);
    const key = d.toISOString().slice(0, 10); // YYYY-MM-DD
    out.push(map.get(key) || 0);
  }
  return out;
}

export class AnalyticsService {
  static getMetrics(orgId: string, options: FilterOptions) {
    const dateFilter = currentFilter(options.period);
    const prevFilter = previousFilter(options.period);

    const count = (table: string, where: string, filter: string): number => {
      try {
        const row = db.prepare(`SELECT count(*) as count FROM ${table} WHERE ${where} ${filter}`).get(orgId) as any;
        return row?.count || 0;
      } catch (e) {
        return 0;
      }
    };

    try {
      const totalTickets = count("tickets", "organization_id = ?", dateFilter);
      const salesCount = count("ticket_closures", "organization_id = ? AND result_status = 'sucesso'", dateFilter);
      const appointmentCount = count("appointments", "organization_id = ? AND status != 'cancelled'", dateFilter);
      const newLeadsCount = count("tickets", "organization_id = ? AND stage = 'novo_lead'", dateFilter);
      const aiResponseCount = count("messages", "organization_id = ? AND sender_type = 'bot'", dateFilter);

      // Tickets que foram passados para humano (handoff) — distintos no período.
      let handledTickets = 0;
      try {
        const r = db.prepare(
          `SELECT count(DISTINCT ticket_id) as count FROM ticket_stage_logs WHERE organization_id = ? AND to_stage = 'em_atendimento_humano' ${dateFilter}`
        ).get(orgId) as any;
        handledTickets = r?.count || 0;
      } catch (e) { handledTickets = 0; }
      const handoffCount = handledTickets;

      // Taxa REAL de resolução pela IA: % de tickets do período que NÃO foram para humano.
      const resolutionRateAI = totalTickets > 0
        ? Math.max(0, Math.min(100, Math.round(((totalTickets - handledTickets) / totalTickets) * 100)))
        : 0;

      // Tempo REAL médio de primeira resposta (segundos): diferença entre a 1ª
      // mensagem do contato e a 1ª resposta (bot/agente) por ticket, no período.
      let averageFirstResponseTime = 0;
      try {
        const r = db.prepare(`
          SELECT AVG(resp) AS avg_resp FROM (
            SELECT (julianday(fb.t) - julianday(fc.t)) * 86400.0 AS resp
            FROM tickets tk
            JOIN (SELECT ticket_id, MIN(created_at) t FROM messages WHERE sender_type = 'contact' GROUP BY ticket_id) fc ON fc.ticket_id = tk.id
            JOIN (SELECT ticket_id, MIN(created_at) t FROM messages WHERE sender_type IN ('bot','agent') GROUP BY ticket_id) fb ON fb.ticket_id = tk.id
            WHERE tk.organization_id = ? ${dateFilter.replace(/created_at/g, 'tk.created_at')}
              AND julianday(fb.t) > julianday(fc.t)
          )
        `).get(orgId) as any;
        averageFirstResponseTime = r?.avg_resp ? Math.round(r.avg_resp) : 0;
      } catch (e) { averageFirstResponseTime = 0; }

      // Série de tickets por dia (últimos 7 dias) para o gráfico de volume.
      const chartRows = db.prepare(`
        SELECT date(created_at) as date, count(*) as count
        FROM tickets
        WHERE organization_id = ? AND created_at >= datetime('now', '-7 days')
        GROUP BY date(created_at)
        ORDER BY date(created_at) ASC
      `).all(orgId) as any[];
      const mappedChartData = chartRows.map(d => ({ name: d.date, tickets: d.count }));

      // Origem por canal.
      const channelData = db.prepare(`
        SELECT c.channel_id, count(t.id) as count
        FROM tickets t
        JOIN contacts c ON t.contact_id = c.id
        WHERE t.organization_id = ? ${dateFilter.replace(/created_at/g, 't.created_at')}
        GROUP BY c.channel_id
      `).all(orgId) as any[];

      // Variação período-a-período (deltas reais).
      let deltas = { tickets: 0, sales: 0, ai: 0, appointments: 0 };
      if (prevFilter) {
        const prevTickets = count("tickets", "organization_id = ?", prevFilter);
        const prevSales = count("ticket_closures", "organization_id = ? AND result_status = 'sucesso'", prevFilter);
        const prevAi = count("messages", "organization_id = ? AND sender_type = 'bot'", prevFilter);
        const prevAppts = count("appointments", "organization_id = ? AND status != 'cancelled'", prevFilter);
        deltas = {
          tickets: pctDelta(totalTickets, prevTickets),
          sales: pctDelta(salesCount, prevSales),
          ai: pctDelta(aiResponseCount, prevAi),
          appointments: pctDelta(appointmentCount, prevAppts),
        };
      }

      // Mini-séries (sparklines) reais dos últimos 7 dias para cada KPI.
      const dailyTickets = db.prepare(`SELECT date(created_at) as date, count(*) as count FROM tickets WHERE organization_id = ? AND created_at >= datetime('now','-7 days') GROUP BY date(created_at)`).all(orgId) as any[];
      const dailyAi = db.prepare(`SELECT date(created_at) as date, count(*) as count FROM messages WHERE organization_id = ? AND sender_type = 'bot' AND created_at >= datetime('now','-7 days') GROUP BY date(created_at)`).all(orgId) as any[];
      let dailySales: any[] = [];
      let dailyAppts: any[] = [];
      try { dailySales = db.prepare(`SELECT date(created_at) as date, count(*) as count FROM ticket_closures WHERE organization_id = ? AND result_status = 'sucesso' AND created_at >= datetime('now','-7 days') GROUP BY date(created_at)`).all(orgId) as any[]; } catch (e) {}
      try { dailyAppts = db.prepare(`SELECT date(created_at) as date, count(*) as count FROM appointments WHERE organization_id = ? AND status != 'cancelled' AND created_at >= datetime('now','-7 days') GROUP BY date(created_at)`).all(orgId) as any[]; } catch (e) {}

      const series = {
        tickets: buildDailySeries(dailyTickets),
        ai: buildDailySeries(dailyAi),
        sales: buildDailySeries(dailySales),
        appointments: buildDailySeries(dailyAppts),
      };

      return {
        totalTickets,
        newLeadsCount,
        salesCount,
        handoffCount,
        appointmentCount,
        chartData: mappedChartData,
        channelData,
        aiResponseCount,
        averageFirstResponseTime,
        resolutionRateAI,
        deltas,
        series,
      };
    } catch (e) {
      console.error(e);
      throw e;
    }
  }

  static getReportSettings(orgId: string) {
    return db.prepare('SELECT * FROM organization_settings WHERE organization_id = ?').get(orgId);
  }
}
