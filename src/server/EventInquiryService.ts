import db from "./db.js";
import { v4 as uuidv4 } from "uuid";

export type EventStatus = 'novo' | 'qualificado' | 'proposta' | 'fechado' | 'perdido';
export type EventType = 'casamento' | 'convencao' | 'day_use' | 'corporativo' | 'aniversario' | 'outro';

/**
 * Pipeline de Eventos & Grupos (Hotelaria). Diferente de reserva pontual: precisa
 * de qualificação consultiva (nº pessoas, data, salas, orçamento). A IA detecta o
 * pedido na conversa, cria a consulta e o time comercial conduz pelo pipeline.
 */
export class EventInquiryService {
  static readonly TYPES: EventType[] = ['casamento','convencao','day_use','corporativo','aniversario','outro'];
  static readonly STAGES: EventStatus[] = ['novo','qualificado','proposta','fechado','perdido'];

  /** Cria a consulta (a partir do intent da IA ou manual). */
  static create(orgId: string, payload: {
    contactId?: string; ticketId?: string; eventType?: string; headcount?: number;
    eventDate?: string; halls?: string; budget?: number; specialRequests?: string; notes?: string;
  }): string {
    const id = uuidv4();
    db.prepare(`
      INSERT INTO event_inquiries
        (id, organization_id, contact_id, ticket_id, event_type, headcount, event_date, halls, budget, special_requests, notes, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'novo')
    `).run(
      id, orgId, payload.contactId || null, payload.ticketId || null,
      this.TYPES.includes((payload.eventType || '') as EventType) ? payload.eventType : 'outro',
      payload.headcount ?? null,
      payload.eventDate || null,
      payload.halls || null,
      payload.budget ?? null,
      payload.specialRequests || null,
      payload.notes || null,
    );
    return id;
  }

  /** Existe consulta aberta para o contato? (evita duplicar quando IA detecta de novo) */
  static openForContact(orgId: string, contactId: string): any | null {
    return db.prepare(`SELECT * FROM event_inquiries WHERE organization_id = ? AND contact_id = ? AND status NOT IN ('fechado','perdido') ORDER BY created_at DESC LIMIT 1`).get(orgId, contactId) as any || null;
  }

  /** Atualiza qualquer campo + mexe no updated_at. */
  static update(orgId: string, id: string, patch: any): boolean {
    const fields: string[] = [];
    const vals: any[] = [];
    const allow = ['event_type','headcount','event_date','halls','budget','special_requests','notes','status','won_amount','loss_reason'];
    for (const k of allow) {
      if (patch[k] !== undefined) { fields.push(`${k} = ?`); vals.push(patch[k]); }
    }
    if (fields.length === 0) return false;
    vals.push(id, orgId);
    const r = db.prepare(`UPDATE event_inquiries SET ${fields.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND organization_id = ?`).run(...vals);
    return r.changes > 0;
  }

  /** Lista para a tela (kanban / lista). */
  static list(orgId: string): any[] {
    return db.prepare(`
      SELECT e.*, c.name AS contact_name, c.identifier AS contact_identifier
      FROM event_inquiries e LEFT JOIN contacts c ON c.id = e.contact_id
      WHERE e.organization_id = ?
      ORDER BY e.updated_at DESC LIMIT 500
    `).all(orgId);
  }
}
