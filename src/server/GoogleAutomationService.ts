import db from "./db.js";
import { v4 as uuidv4 } from "uuid";
import { GoogleOAuthService } from "./GoogleOAuthService.js";

// Automações Google que rodam no servidor (sem o dono presente). Hoje:
// registrar cada novo pedido numa planilha viva do Google Sheets.
export class GoogleAutomationService {
  static getSettings(orgId: string): { logOrders: boolean; ordersSheetId: string | null; emailAppointments: boolean; emailOrders: boolean; syncEnabled: boolean; syncSheetId: string | null; syncLastRun: string | null } {
    const o = db.prepare("SELECT google_log_orders, google_orders_sheet_id, google_email_appointments, google_email_orders, google_sync_enabled, google_sync_sheet_id, google_sync_last_run FROM organization_settings WHERE organization_id = ?").get(orgId) as any;
    return {
      logOrders: !!o?.google_log_orders,
      ordersSheetId: o?.google_orders_sheet_id || null,
      emailAppointments: !!o?.google_email_appointments,
      emailOrders: !!o?.google_email_orders,
      syncEnabled: !!o?.google_sync_enabled,
      syncSheetId: o?.google_sync_sheet_id || null,
      syncLastRun: o?.google_sync_last_run || null,
    };
  }

  static setLogOrders(orgId: string, on: boolean) {
    db.prepare("UPDATE organization_settings SET google_log_orders = ? WHERE organization_id = ?").run(on ? 1 : 0, orgId);
  }
  static setLiveSync(orgId: string, on: boolean) {
    db.prepare("UPDATE organization_settings SET google_sync_enabled = ? WHERE organization_id = ?").run(on ? 1 : 0, orgId);
  }
  static setEmailAppointments(orgId: string, on: boolean) {
    db.prepare("UPDATE organization_settings SET google_email_appointments = ? WHERE organization_id = ?").run(on ? 1 : 0, orgId);
  }
  static setEmailOrders(orgId: string, on: boolean) {
    db.prepare("UPDATE organization_settings SET google_email_orders = ? WHERE organization_id = ?").run(on ? 1 : 0, orgId);
  }

  private static businessName(orgId: string): string {
    const o = db.prepare("SELECT business_name FROM organization_settings WHERE organization_id = ?").get(orgId) as any;
    return o?.business_name || "Nossa empresa";
  }

  // Acrescenta o pedido à planilha de vendas (cria a planilha na 1ª vez).
  // Best-effort: nunca lança nem bloqueia a criação do pedido.
  static async logOrder(orgId: string, orderId: string): Promise<void> {
    try {
      const s = this.getSettings(orgId);
      if (!s.logOrders) return;
      if (!GoogleOAuthService.getConnection(orgId)) return;
      const o = db.prepare(
        `SELECT o.created_at, c.name AS contact, o.status, o.payment_status, o.total_amount
           FROM orders o LEFT JOIN contacts c ON c.id = o.contact_id
          WHERE o.id = ? AND o.organization_id = ?`
      ).get(orderId, orgId) as any;
      if (!o) return;

      let sheetId = s.ordersSheetId;
      if (!sheetId) {
        const created = await GoogleOAuthService.sheetsCreate(
          orgId, `Vendas — ExaForge`,
          ["Data", "Cliente", "Status", "Pagamento", "Total"], []
        );
        if ("error" in created) return;
        sheetId = created.id;
        db.prepare("UPDATE organization_settings SET google_orders_sheet_id = ? WHERE organization_id = ?").run(sheetId, orgId);
      }
      const row = [
        o.created_at ? new Date(o.created_at).toLocaleString("pt-BR") : "",
        o.contact || "Cliente",
        o.status || "",
        o.payment_status || "",
        `R$ ${Number(o.total_amount || 0).toFixed(2)}`,
      ];
      await GoogleOAuthService.sheetsAppendRow(orgId, sheetId, row);
    } catch (e) { console.error("[GoogleAutomation] logOrder:", e); }
  }

  /**
   * Live sync: reescreve uma planilha VIVA (abas Vendas / Estoque / Resumo) com
   * o estado ATUAL da operação. Diferente de `logOrder` (append-only, que nunca
   * reflete mudança de status), aqui cada aba é limpa e regravada, então o
   * lojista tem um dashboard sempre atualizado que pode fixar/filtrar/compartilhar.
   * Rodada pelo Scheduler (googleSheetsSyncPass). Best-effort: nunca lança.
   * Devolve um resumo do que foi escrito (usado em teste/telemetria).
   */
  static async syncLiveSheet(orgId: string): Promise<{ ok: boolean; reason?: string; sheetId?: string; counts?: { vendas: number; estoque: number } }> {
    try {
      const s = this.getSettings(orgId);
      if (!s.syncEnabled) return { ok: false, reason: "desligado" };
      if (!GoogleOAuthService.getConnection(orgId)) return { ok: false, reason: "sem conexão Google" };

      const { vendas, estoque, resumo, counts } = this.buildLiveSheetData(orgId);

      let sheetId = s.syncSheetId;
      if (!sheetId) {
        const created = await GoogleOAuthService.sheetsCreateWithTabs(orgId, `Painel ExaForge — ${this.businessName(orgId)}`, ["Vendas", "Estoque", "Resumo"]);
        if ("error" in created) return { ok: false, reason: created.error };
        sheetId = created.id;
        db.prepare("UPDATE organization_settings SET google_sync_sheet_id = ? WHERE organization_id = ?").run(sheetId, orgId);
      }

      await GoogleOAuthService.sheetsReplaceTab(orgId, sheetId, "Vendas", vendas);
      await GoogleOAuthService.sheetsReplaceTab(orgId, sheetId, "Estoque", estoque);
      await GoogleOAuthService.sheetsReplaceTab(orgId, sheetId, "Resumo", resumo);

      db.prepare("UPDATE organization_settings SET google_sync_last_run = CURRENT_TIMESTAMP WHERE organization_id = ?").run(orgId);
      return { ok: true, sheetId, counts };
    } catch (e: any) {
      console.error("[GoogleAutomation] syncLiveSheet:", e);
      return { ok: false, reason: "erro" };
    }
  }

  /**
   * Monta as matrizes (cabeçalho + linhas) de cada aba do painel vivo. Pura —
   * sem I/O de rede — para ser testável direto. Vendas: últimos 200 pedidos com
   * status/pagamento ATUAIS. Estoque: itens com controle de estoque e seus
   * níveis. Resumo: KPIs dos últimos 30 dias (pedidos, faturamento pago, ticket
   * médio) + total em estoque.
   */
  static buildLiveSheetData(orgId: string): { vendas: (string | number)[][]; estoque: (string | number)[][]; resumo: (string | number)[][]; counts: { vendas: number; estoque: number } } {
    const orders = db.prepare(
      `SELECT o.created_at, c.name AS contact, o.status, o.payment_status, o.total_amount
         FROM orders o LEFT JOIN contacts c ON c.id = o.contact_id
        WHERE o.organization_id = ?
        ORDER BY o.created_at DESC LIMIT 200`
    ).all(orgId) as any[];
    const vendas: (string | number)[][] = [["Data", "Cliente", "Status", "Pagamento", "Total (R$)"]];
    for (const o of orders) {
      vendas.push([
        o.created_at ? new Date(o.created_at.replace(" ", "T") + "Z").toLocaleString("pt-BR") : "",
        o.contact || "Cliente",
        o.status || "",
        o.payment_status || "",
        Number(o.total_amount || 0).toFixed(2),
      ]);
    }

    const stock = db.prepare(
      `SELECT p.name AS name, i.sku AS sku, i.quantity_available AS qty, i.quantity_reserved AS reserved, i.updated_at AS updated_at
         FROM inventory_items i JOIN products_services p ON p.id = i.product_service_id
        WHERE i.organization_id = ? AND p.type = 'product'
        ORDER BY i.quantity_available ASC LIMIT 500`
    ).all(orgId) as any[];
    const estoque: (string | number)[][] = [["Produto", "SKU", "Disponível", "Reservado", "Atualizado"]];
    for (const it of stock) {
      estoque.push([
        it.name || "",
        it.sku || "",
        Number(it.qty || 0),
        Number(it.reserved || 0),
        it.updated_at ? new Date(it.updated_at.replace(" ", "T") + "Z").toLocaleString("pt-BR") : "",
      ]);
    }

    const kpi = db.prepare(
      `SELECT COUNT(*) AS orders30,
              SUM(CASE WHEN payment_status = 'pago' THEN total_amount ELSE 0 END) AS revenue30,
              SUM(CASE WHEN payment_status = 'pago' THEN 1 ELSE 0 END) AS paid30
         FROM orders
        WHERE organization_id = ? AND created_at >= datetime('now', '-30 days')`
    ).get(orgId) as any || {};
    const revenue30 = Number(kpi.revenue30 || 0);
    const paid30 = Number(kpi.paid30 || 0);
    const stockUnits = stock.reduce((sum, it) => sum + Number(it.qty || 0), 0);
    const resumo: (string | number)[][] = [
      ["Indicador (últimos 30 dias)", "Valor"],
      ["Pedidos", Number(kpi.orders30 || 0)],
      ["Pedidos pagos", paid30],
      ["Faturamento pago (R$)", revenue30.toFixed(2)],
      ["Ticket médio pago (R$)", (paid30 > 0 ? revenue30 / paid30 : 0).toFixed(2)],
      ["Itens de estoque monitorados", stock.length],
      ["Unidades em estoque", stockUnits],
    ];

    return { vendas, estoque, resumo, counts: { vendas: orders.length, estoque: stock.length } };
  }

  // Envia a confirmação do AGENDAMENTO por e-mail ao cliente (se houver e-mail).
  static async confirmAppointment(orgId: string, appointmentId: string): Promise<void> {
    try {
      if (!this.getSettings(orgId).emailAppointments) return;
      if (!GoogleOAuthService.getConnection(orgId)) return;
      const a = db.prepare(
        `SELECT a.title, a.description, a.scheduled_start, c.name AS contact, c.email AS email
           FROM appointments a LEFT JOIN contacts c ON c.id = a.contact_id
          WHERE a.id = ? AND a.organization_id = ?`
      ).get(appointmentId, orgId) as any;
      if (!a?.email) return;
      const when = a.scheduled_start ? new Date(a.scheduled_start).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }) : "a combinar";
      const biz = this.businessName(orgId);
      // Anexo .ics: o cliente adiciona o evento à própria agenda com 1 toque.
      const ics = this.buildIcs(a.title || "Agendamento", a.description || "", a.scheduled_start, biz);
      const body = `Olá${a.contact ? `, ${a.contact}` : ""}!\n\nSeu agendamento foi confirmado:\n\n• ${a.title || "Agendamento"}\n• Data/hora: ${when}\n${a.description ? `• ${a.description}\n` : ""}${ics ? "\nO convite de calendário (.ics) está em anexo — toque para adicionar à sua agenda." : ""}\nQualquer coisa, é só responder por aqui ou pelo WhatsApp.\n\n— ${biz}`;
      const attachment = ics ? { filename: "agendamento.ics", mimeType: "text/calendar", content: ics } : undefined;
      await GoogleOAuthService.gmailSend(orgId, a.email, `Confirmação de agendamento — ${biz}`, body, attachment);
    } catch (e) { console.error("[GoogleAutomation] confirmAppointment:", e); }
  }

  // Monta um VEVENT (iCalendar) para o cliente adicionar na agenda. Evento de 1h
  // a partir do horário marcado. Retorna "" se o horário for inválido.
  private static buildIcs(title: string, description: string, startIso: string, biz: string): string {
    try {
      const start = new Date(startIso);
      if (isNaN(start.getTime())) return "";
      const end = new Date(start.getTime() + 60 * 60 * 1000);
      const fmt = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
      const esc = (s: string) => String(s || "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
      const uid = `${uuidv4()}@exaforge`;
      return [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//ExaForge//Agendamento//PT-BR",
        "CALSCALE:GREGORIAN",
        "METHOD:PUBLISH",
        "BEGIN:VEVENT",
        `UID:${uid}`,
        `DTSTAMP:${fmt(new Date())}`,
        `DTSTART:${fmt(start)}`,
        `DTEND:${fmt(end)}`,
        `SUMMARY:${esc(title)}`,
        `DESCRIPTION:${esc(description || `Agendamento — ${biz}`)}`,
        `ORGANIZER;CN=${esc(biz)}:mailto:noreply@exaforge`,
        "STATUS:CONFIRMED",
        "END:VEVENT",
        "END:VCALENDAR",
      ].join("\r\n");
    } catch (e) { return ""; }
  }

  // Envia a confirmação do PEDIDO por e-mail ao cliente (se houver e-mail).
  static async confirmOrder(orgId: string, orderId: string, fallbackEmail?: string): Promise<void> {
    try {
      if (!this.getSettings(orgId).emailOrders) return;
      if (!GoogleOAuthService.getConnection(orgId)) return;
      const o = db.prepare(
        `SELECT o.total_amount, c.name AS contact, c.email AS email
           FROM orders o LEFT JOIN contacts c ON c.id = o.contact_id
          WHERE o.id = ? AND o.organization_id = ?`
      ).get(orderId, orgId) as any;
      if (!o) return;
      const email = o.email || (fallbackEmail || "").trim();
      if (!email) return;
      o.email = email;
      const items = db.prepare("SELECT name_snapshot, quantity, line_total FROM order_items WHERE order_id = ?").all(orderId) as any[];
      const lines = items.map(i => `• ${i.quantity}× ${i.name_snapshot} — R$ ${Number(i.line_total || 0).toFixed(2)}`).join("\n");
      const biz = this.businessName(orgId);
      const body = `Olá${o.contact ? `, ${o.contact}` : ""}!\n\nRecebemos seu pedido. Resumo:\n\n${lines}\n\nTotal: R$ ${Number(o.total_amount || 0).toFixed(2)}\n\nObrigado pela preferência!\n\n— ${biz}`;
      await GoogleOAuthService.gmailSend(orgId, o.email, `Confirmação do seu pedido — ${biz}`, body);
    } catch (e) { console.error("[GoogleAutomation] confirmOrder:", e); }
  }
}
