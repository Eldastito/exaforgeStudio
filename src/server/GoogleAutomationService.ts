import db from "./db.js";
import { GoogleOAuthService } from "./GoogleOAuthService.js";

// Automações Google que rodam no servidor (sem o dono presente). Hoje:
// registrar cada novo pedido numa planilha viva do Google Sheets.
export class GoogleAutomationService {
  static getSettings(orgId: string): { logOrders: boolean; ordersSheetId: string | null } {
    const o = db.prepare("SELECT google_log_orders, google_orders_sheet_id FROM organization_settings WHERE organization_id = ?").get(orgId) as any;
    return { logOrders: !!o?.google_log_orders, ordersSheetId: o?.google_orders_sheet_id || null };
  }

  static setLogOrders(orgId: string, on: boolean) {
    db.prepare("UPDATE organization_settings SET google_log_orders = ? WHERE organization_id = ?").run(on ? 1 : 0, orgId);
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
}
