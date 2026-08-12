/**
 * CustomerContextService (ADR-162 / PRD 5 §13-§14, F3) — monta o CONTEXTO OPERACIONAL
 * do cliente ("customer-360") por trás de uma reclamação: perfil, pedidos, reembolsos,
 * tickets + SLA, histórico de reclamações e memória. COMPÕE serviços existentes (D4/
 * §5 — sem motor/tabela nova): CustomerProfileService, orders, tickets/TicketSlaService,
 * business_signals (reputação), CustomerMemoryService. Tudo isolado por org (RN-CRR-9).
 *
 * Leitura defensiva: cada bloco degrada pra vazio se a fonte falhar — o 360 nunca
 * quebra por causa de um pedaço ausente (o Context Engine real, PRD 3, faz o mesmo).
 * O que este serviço NÃO faz: não decide ação, não expõe pra modelo cru (a projeção
 * RBAC+purpose §73 é aplicada a jusante, quando o contexto for entregue a um agente).
 */
import db from "./db.js";
import { CustomerProfileService } from "./CustomerProfileService.js";
import { CustomerMemoryService } from "./CustomerMemoryService.js";
import { TicketSlaService } from "./TicketSlaService.js";

const REFUND_STATUSES = new Set(["reembolso", "devolucao"]);

export interface CustomerContext {
  contactId: string;
  profile: any | null;
  orders: Array<{ id: string; status: string; totalAmount: number | null; createdAt: string }>;
  ordersCount: number;
  refunds: Array<{ id: string; status: string; totalAmount: number | null; createdAt: string }>;
  tickets: Array<{ id: string; status: string; stage: string; sla: string | null }>;
  openTickets: number;
  complaints: Array<{ id: string; signalType: string; severity: string; status: string; occurredAt: string | null }>;
  complaintsCount: number;
  memory: { summary: string | null } | null;
}

export class CustomerContextService {
  static build(orgId: string, contactId: string): CustomerContext | null {
    const contact = db.prepare(`SELECT id FROM contacts WHERE organization_id = ? AND id = ?`).get(orgId, contactId) as any;
    if (!contact) return null;

    // Perfil (CRM) — pronto no CustomerProfileService.
    let profile: any = null;
    try { profile = CustomerProfileService.getProfile(orgId, contactId); } catch { profile = null; }

    // Pedidos + reembolsos (deriva reembolso de status; FalatuRefundService é billing
    // da org, não serve — §audit). Padrão de query reusa o do LgpdService.
    const orderRows = (db.prepare(
      `SELECT id, status, total_amount, created_at FROM orders WHERE organization_id = ? AND contact_id = ? ORDER BY created_at DESC LIMIT 50`
    ).all(orgId, contactId) as any[]) || [];
    const orders = orderRows.map((o) => ({ id: o.id, status: o.status, totalAmount: o.total_amount != null ? Number(o.total_amount) : null, createdAt: o.created_at }));
    const refunds = orders.filter((o) => REFUND_STATUSES.has(o.status));

    // Tickets + estado de SLA por linha (displayState do TicketSlaService).
    const now = Date.now();
    const ticketRows = (db.prepare(
      `SELECT id, status, stage, sla_due_at, sla_first_response_at, sla_breached FROM tickets WHERE organization_id = ? AND contact_id = ? ORDER BY created_at DESC LIMIT 50`
    ).all(orgId, contactId) as any[]) || [];
    const tickets = ticketRows.map((t) => ({ id: t.id, status: t.status, stage: t.stage, sla: safeSla(t, now) }));
    const openTickets = tickets.filter((t) => t.status !== "closed").length;

    // Histórico de reclamações desta pessoa (após re-sujeitar reputation_item→contact).
    const complaintRows = (db.prepare(
      `SELECT id, signal_type, severity, status, occurred_at FROM business_signals
       WHERE organization_id = ? AND domain = 'reputation' AND subject_type = 'contact' AND subject_id = ?
       ORDER BY COALESCE(occurred_at, detected_at) DESC LIMIT 50`
    ).all(orgId, contactId) as any[]) || [];
    const complaints = complaintRows.map((c) => ({ id: c.id, signalType: c.signal_type, severity: c.severity, status: c.status, occurredAt: c.occurred_at || null }));

    // Memória de relacionamento (opt-in; best-effort).
    let memory: { summary: string | null } | null = null;
    try { const m = CustomerMemoryService.getMemory(orgId, contactId); memory = { summary: m?.summary || null }; } catch { memory = null; }

    return {
      contactId,
      profile,
      orders, ordersCount: orders.length,
      refunds,
      tickets, openTickets,
      complaints, complaintsCount: complaints.length,
      memory,
    };
  }
}

function safeSla(row: any, nowMs: number): string | null {
  try { return TicketSlaService.displayState(row, nowMs); } catch { return null; }
}

export default CustomerContextService;
