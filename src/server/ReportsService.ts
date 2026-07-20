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

  /**
   * Relatório de vendas com filtros + cards personalizados por vertical (ADR-094).
   * Filtros: período, categoria, canal (derivado de created_by) e vendedor
   * (created_by = userId). Fonte do painel e do PDF com marca.
   *
   * "Canal": não há coluna dedicada — derivamos de orders.created_by
   * ('storefront' = loja, 'ai' = whatsapp/IA, um userId = pdv/manual).
   */
  static salesReport(orgId: string, filters: {
    period?: string; category?: string; channel?: string; seller?: string;
  } = {}): any {
    // ---- período ----
    const periodMap: Record<string, string> = {
      "7": "-7 days", "30": "-30 days", "90": "-90 days",
    };
    const period = ["7", "30", "90", "month", "prev_month"].includes(String(filters.period)) ? String(filters.period) : "30";
    let dateWhere = "";
    if (period === "month") dateWhere = "AND o.created_at >= date('now','start of month')";
    else if (period === "prev_month") dateWhere = "AND o.created_at >= date('now','start of month','-1 month') AND o.created_at < date('now','start of month')";
    else dateWhere = `AND o.created_at >= datetime('now','${periodMap[period]}')`;

    // ---- canal (derivado de created_by) ----
    const channelWhere = filters.channel === "loja" ? "AND o.created_by = 'storefront'"
      : filters.channel === "whatsapp" ? "AND o.created_by = 'ai'"
      : filters.channel === "pdv" ? "AND o.created_by NOT IN ('storefront','ai') AND o.created_by IS NOT NULL"
      : "";

    // ---- vendedor (created_by = userId) ----
    const params: any[] = [orgId];
    let sellerWhere = "";
    if (filters.seller) { sellerWhere = "AND o.created_by = ?"; params.push(String(filters.seller)); }

    // ---- categoria (via item -> produto) ----
    let categoryJoin = "";
    if (filters.category) {
      categoryJoin = `AND EXISTS (SELECT 1 FROM order_items oi JOIN products_services ps ON ps.id = oi.product_service_id
        WHERE oi.order_id = o.id AND ps.category = ?)`;
      params.push(String(filters.category));
    }

    const baseWhere = `o.organization_id = ? AND o.status != 'cancelado' ${dateWhere} ${channelWhere} ${sellerWhere} ${categoryJoin}`;

    // ---- cards core ----
    const agg = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(o.total_amount),0) AS sum FROM orders o WHERE ${baseWhere}`).get(...params) as any;
    const paid = db.prepare(`SELECT COUNT(*) AS n FROM orders o WHERE ${baseWhere} AND o.status = 'pago'`).get(...params) as any;
    const orders = Number(agg.n) || 0;
    const revenue = Number(agg.sum) || 0;
    const coreCards = [
      { key: "revenue", label: "Faturamento", value: revenue, format: "brl" },
      { key: "orders", label: "Pedidos (não cancelados)", value: orders, format: "int" },
      { key: "ticket", label: "Ticket médio", value: orders > 0 ? revenue / orders : 0, format: "brl" },
      { key: "paid", label: "Pedidos pagos", value: Number(paid.n) || 0, format: "int" },
    ];

    // ---- itens vendidos no período (base dos cards por vertical) ----
    const soldItems = db.prepare(
      `SELECT oi.name_snapshot AS name, SUM(oi.quantity) AS qty, SUM(oi.line_total) AS total
         FROM order_items oi JOIN orders o ON o.id = oi.order_id
        WHERE ${baseWhere}
        GROUP BY oi.name_snapshot
        ORDER BY qty DESC`
    ).all(...params) as any[];
    const topProducts = soldItems.slice(0, 10).map(r => ({ name: r.name, qty: Number(r.qty) || 0, total: Number(r.total) || 0 }));

    // ---- vertical ----
    const org = db.prepare(`SELECT COALESCE(vertical,'outro') AS v FROM organization_settings WHERE organization_id = ?`).get(orgId) as any;
    const vertical = String(org?.v || "outro");

    const dash = "—";
    const verticalCards: any[] = [];
    if (["varejo", "moda", "food"].includes(vertical)) {
      const cats = db.prepare(
        `SELECT COALESCE(ps.category,'Sem categoria') AS cat, SUM(oi.line_total) AS total
           FROM order_items oi JOIN orders o ON o.id = oi.order_id
           LEFT JOIN products_services ps ON ps.id = oi.product_service_id
          WHERE ${baseWhere} GROUP BY cat ORDER BY total DESC LIMIT 1`
      ).get(...params) as any;
      verticalCards.push(
        { key: "top_product", label: vertical === "moda" ? "Peça mais vendida" : "Item mais vendido", value: soldItems[0]?.name || dash, format: "text" },
        { key: "bottom_product", label: vertical === "moda" ? "Peça menos vendida" : "Item menos vendido", value: soldItems.length ? soldItems[soldItems.length - 1].name : dash, format: "text" },
        { key: "top_category", label: "Categoria que mais vende", value: cats?.cat || dash, format: "text" },
      );
    } else if (vertical === "servicos") {
      verticalCards.push(
        { key: "top_service", label: "Serviço mais pedido", value: soldItems[0]?.name || dash, format: "text" },
        { key: "service_ticket", label: "Ticket médio por serviço", value: topProducts.length ? topProducts.reduce((s, p) => s + p.total, 0) / topProducts.reduce((s, p) => s + p.qty, 0) : 0, format: "brl" },
      );
    } else if (vertical === "saude") {
      const appt = db.prepare(`SELECT COUNT(*) AS total, SUM(CASE WHEN status='no_show' THEN 1 ELSE 0 END) AS noshow FROM appointments WHERE organization_id = ? ${dateWhere.replace(/o\.created_at/g, "created_at")}`).get(orgId) as any;
      const totalA = Number(appt?.total) || 0;
      verticalCards.push(
        { key: "appts", label: "Consultas realizadas", value: totalA, format: "int" },
        { key: "noshow", label: "Taxa de no-show", value: totalA > 0 ? `${Math.round((Number(appt.noshow) || 0) / totalA * 100)}%` : dash, format: "text" },
      );
    } else if (vertical === "hospitalidade") {
      verticalCards.push(
        { key: "occupancy", label: "Ocupação (%)", value: dash, format: "text", hint: "Depende de dados de reservas/capacidade" },
        { key: "revpar", label: "RevPAR", value: dash, format: "text", hint: "Depende de dados de reservas/capacidade" },
      );
    }

    // ---- listas para os dropdowns de filtro ----
    const categories = (db.prepare(`SELECT DISTINCT category FROM products_services WHERE organization_id = ? AND category IS NOT NULL AND category != '' ORDER BY category`).all(orgId) as any[]).map(r => r.category);
    const sellers = (db.prepare(
      `SELECT DISTINCT o.created_by AS id, u.name AS name FROM orders o
         JOIN users u ON u.id = o.created_by
        WHERE o.organization_id = ? ORDER BY u.name`
    ).all(orgId) as any[]).map(r => ({ id: r.id, name: r.name }));

    return {
      vertical, period, filters: { category: filters.category || null, channel: filters.channel || null, seller: filters.seller || null },
      coreCards, verticalCards, topProducts,
      options: { categories, sellers, channels: ["loja", "whatsapp", "pdv"] },
    };
  }
}
