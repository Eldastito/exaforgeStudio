import db from "./db.js";
import { GoogleOAuthService } from "./GoogleOAuthService.js";

// Automações Google que rodam no servidor (sem o dono presente). Hoje:
// registrar cada novo pedido numa planilha viva do Google Sheets.
export class GoogleAutomationService {
  static getSettings(orgId: string): { logOrders: boolean; ordersSheetId: string | null; emailAppointments: boolean; emailOrders: boolean } {
    const o = db.prepare("SELECT google_log_orders, google_orders_sheet_id, google_email_appointments, google_email_orders FROM organization_settings WHERE organization_id = ?").get(orgId) as any;
    return {
      logOrders: !!o?.google_log_orders,
      ordersSheetId: o?.google_orders_sheet_id || null,
      emailAppointments: !!o?.google_email_appointments,
      emailOrders: !!o?.google_email_orders,
    };
  }

  static setLogOrders(orgId: string, on: boolean) {
    db.prepare("UPDATE organization_settings SET google_log_orders = ? WHERE organization_id = ?").run(on ? 1 : 0, orgId);
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
      const body = `Olá${a.contact ? `, ${a.contact}` : ""}!\n\nSeu agendamento foi confirmado:\n\n• ${a.title || "Agendamento"}\n• Data/hora: ${when}\n${a.description ? `• ${a.description}\n` : ""}\nQualquer coisa, é só responder por aqui ou pelo WhatsApp.\n\n— ${biz}`;
      await GoogleOAuthService.gmailSend(orgId, a.email, `Confirmação de agendamento — ${biz}`, body);
    } catch (e) { console.error("[GoogleAutomation] confirmAppointment:", e); }
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
