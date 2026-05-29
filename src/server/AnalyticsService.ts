import db from "./db.js";

interface FilterOptions {
  period: "today" | "week" | "month" | "all";
}

export class AnalyticsService {
  static getMetrics(orgId: string, options: FilterOptions) {
    let dateFilter = "";
    if (options.period === "today") {
      dateFilter = "AND date(created_at) = date('now')";
    } else if (options.period === "week") {
      dateFilter = "AND created_at >= datetime('now', '-7 days')";
    } else if (options.period === "month") {
      dateFilter = "AND created_at >= datetime('now', '-30 days')";
    }

    try {
      const ticketsObj = db.prepare(`SELECT count(*) as count FROM tickets WHERE organization_id = ? ${dateFilter}`).get(orgId) as any;
      const totalTickets = ticketsObj.count;

      const salesObj = db.prepare(`SELECT count(*) as count FROM ticket_closures WHERE organization_id = ? AND result_status = 'sucesso' ${dateFilter}`).get(orgId) as any;
      const salesCount = salesObj.count;

      const handoffsObj = db.prepare(`SELECT count(*) as count FROM ticket_stage_logs WHERE organization_id = ? AND to_stage = 'em_atendimento_humano' ${dateFilter}`).get(orgId) as any;
      const handoffCount = handoffsObj?.count || 0;

      const appointmentsObj = db.prepare(`SELECT count(*) as count FROM appointments WHERE organization_id = ? AND status != 'cancelled' ${dateFilter}`).get(orgId) as any;
      const appointmentCount = appointmentsObj?.count || 0;

      const leadsObj = db.prepare(`SELECT count(*) as count FROM tickets WHERE organization_id = ? AND stage = 'novo_lead' ${dateFilter}`).get(orgId) as any;
      const newLeadsCount = leadsObj?.count || 0;

      // Group tickets by date for the last 7 days chart
      const chartData = db.prepare(`
        SELECT date(created_at) as date, count(*) as count 
        FROM tickets 
        WHERE organization_id = ? AND created_at >= datetime('now', '-7 days')
        GROUP BY date(created_at)
        ORDER BY date(created_at) ASC
      `).all(orgId) as any[];

      const mappedChartData = chartData.map(d => ({
        name: d.date,
        tickets: d.count
      }));

      // Group by channel/origin
      const channelData = db.prepare(`
        SELECT c.channel_id, count(t.id) as count
        FROM tickets t
        JOIN contacts c ON t.contact_id = c.id
        WHERE t.organization_id = ? ${dateFilter.replace(/created_at/g, 't.created_at')}
        GROUP BY c.channel_id
      `).all(orgId) as any[];

      // Additional metrics requested in Module E
      // 1. Total Daily/Weekly/Monthly Conversas (simplified here by the existing totalTickets with different filters)
      // 2. IA Success Rate (simplified)
      const iaMessages = db.prepare(`SELECT count(*) as count FROM messages WHERE organization_id = ? AND sender_type = 'bot' ${dateFilter}`).get(orgId) as any;
      const aiResponseCount = iaMessages?.count || 0;

      return {
        totalTickets,
        newLeadsCount,
        salesCount,
        handoffCount,
        appointmentCount,
        chartData: mappedChartData,
        channelData,
        aiResponseCount,
        averageFirstResponseTime: 45, // Hardcoded as placeholder for this phase
        resolutionRateAI: 85, // Hardcoded as placeholder for this phase
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
