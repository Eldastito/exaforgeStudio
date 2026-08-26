import db from "./db.js";
import { logAuthEvent } from "./auditLog.js";
import { LegalProfessionalFederationService } from "./LegalProfessionalFederationService.js";
import { ProfessionalBookingService } from "./ProfessionalBookingService.js";

/**
 * Legal Professional Booking (ADR-191 OAB-F3) — disponibilidade + agendamento FEDERADO
 * a partir da Advocacia. COMPOSIÇÃO PURA sobre a ADR-180 (§184 — sem motor novo):
 * traduz `lawyerId`→`relationshipId` (exige federação OAB-F1) e DELEGA a
 * `ProfessionalBookingService` (disponibilidade aterrada RN-PN-4 + hold atômico RN-PN-5
 * + confirmação idempotente). A única adição da vertical: amarrar o agendamento federado
 * ao PROCESSO (`legal_cases.legal_case_id`) quando informado — o fio da agenda jurídica.
 *
 * Nunca inventa vaga (RN-PN-4). AGENDADO ≠ ATENDIDO (RN-PN-5). Isolado por org.
 */

function caseRow(orgId: string, caseId: string): any {
  return db.prepare(`SELECT id, contact_id FROM legal_cases WHERE organization_id = ? AND id = ?`).get(orgId, caseId) || null;
}

export class LegalProfessionalBookingService {
  private static requireRelationship(orgId: string, lawyerId: string): string {
    const st = LegalProfessionalFederationService.status(orgId, lawyerId);
    if (!st.federated || !st.relationshipId) throw new Error("Advogado não federado — federe pela OAB antes de agendar.");
    return st.relationshipId;
  }

  /** Vagas provadas do advogado federado num dia (aterradas — nunca inventa, RN-PN-4). */
  static availability(orgId: string, lawyerId: string, dateISO: string, opts?: { serviceId?: string; slotMinutes?: number; nowISO?: string }): Promise<any[]> {
    const rel = this.requireRelationship(orgId, lawyerId);
    return ProfessionalBookingService.getAvailability(orgId, rel, dateISO, opts);
  }

  /** Segura uma vaga (hold atômico + TTL). */
  static hold(orgId: string, lawyerId: string, input: { serviceId?: string; startISO?: string; slotMinutes?: number; ttlMinutes?: number; nowISO?: string }, actorId?: string) {
    const rel = this.requireRelationship(orgId, lawyerId);
    return ProfessionalBookingService.holdSlot(orgId, rel, input, actorId);
  }

  /** Confirma o hold e cria o agendamento federado, amarrado ao PROCESSO se informado.
   *  Cliente vem do processo (se houver caseId) ou do contactId. Idempotente (via holdId). */
  static confirm(orgId: string, input: { holdId: string; caseId?: string | null; contactId?: string | null; title?: string | null; nowISO?: string | null }, actorId?: string): any {
    let contactId = input.contactId || null;
    let cs: any = null;
    if (input.caseId) {
      cs = caseRow(orgId, input.caseId);
      if (!cs) throw new Error("Processo não encontrado.");
      contactId = cs.contact_id;
    }
    if (!contactId) throw new Error("Informe o cliente (contactId) ou um processo.");

    const appt = ProfessionalBookingService.confirmBooking(orgId, { holdId: input.holdId, contactId, title: input.title || undefined, nowISO: input.nowISO || undefined }, actorId);

    // Amarra ao processo (o fio da agenda jurídica). Idempotente (só seta se ainda não estava).
    if (input.caseId && appt?.id) {
      db.prepare(`UPDATE appointments SET legal_case_id = ?, hearing_type = COALESCE(hearing_type, 'reuniao') WHERE organization_id = ? AND id = ? AND (legal_case_id IS NULL OR legal_case_id = ?)`)
        .run(input.caseId, orgId, appt.id, input.caseId);
      logAuthEvent(orgId, actorId ?? null, contactId, "LEGAL_FEDERATED_BOOKING_LINKED", { appointmentId: appt.id, caseId: input.caseId });
      appt.legal_case_id = input.caseId;
    }
    return appt;
  }

  /** Demanda sem vaga → sinal na espinha (nunca fabrica agendamento — RN-PN-4/7). */
  static waitlist(orgId: string, lawyerId: string, input: { serviceId?: string | null; contactId?: string | null; note?: string | null }): { ok: boolean } {
    const rel = this.requireRelationship(orgId, lawyerId);
    return ProfessionalBookingService.waitlist(orgId, { relationshipId: rel, serviceId: input.serviceId ?? null, contactId: input.contactId ?? null, note: input.note ?? null });
  }
}

export default LegalProfessionalBookingService;
