import db from "./db.js";

/**
 * Relatórios de vendas — números agregados por organização. Fonte única usada
 * tanto pelo painel de Relatórios (no app) quanto pela exportação de "resumo"
 * para o Google Sheets. Compara os últimos 30 dias com o total geral.
 */
export class ReportsService {
  static salesSummary(orgId: string): {
    orders: { d30: number; all: number };
    revenue: { d30: number; all: number };
    ticket: { d30: number; all: number };
    paidOrders: { d30: number; all: number };
    appointments: { d30: number; all: number };
    contacts: { d30: number; all: number };
  } {
    // Pedidos não cancelados contam como faturamento.
    const ordersStat = (where: string) => db.prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(total_amount),0) AS sum
         FROM orders WHERE organization_id = ? AND status != 'cancelado' ${where}`
    ).get(orgId) as any;
    const countOf = (table: string, where: string) => (db.prepare(
      `SELECT COUNT(*) AS n FROM ${table} WHERE organization_id = ? ${where}`
    ).get(orgId) as any).n as number;

    const last30 = "AND created_at >= datetime('now','-30 days')";
    const oAll = ordersStat("");
    const o30 = ordersStat(last30);
    const ticket = (s: any) => (s.n > 0 ? Number(s.sum) / Number(s.n) : 0);

    return {
      orders: { d30: o30.n, all: oAll.n },
      revenue: { d30: Number(o30.sum), all: Number(oAll.sum) },
      ticket: { d30: ticket(o30), all: ticket(oAll) },
      paidOrders: {
        d30: countOf("orders", `AND status = 'pago' ${last30}`),
        all: countOf("orders", "AND status = 'pago'"),
      },
      appointments: {
        d30: countOf("appointments", last30),
        all: countOf("appointments", ""),
      },
      contacts: {
        d30: countOf("contacts", last30),
        all: countOf("contacts", ""),
      },
    };
  }
}
