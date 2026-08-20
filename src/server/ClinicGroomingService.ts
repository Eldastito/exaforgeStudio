/**
 * ClinicGroomingService — Petshop F4: Banho & Tosa (grooming).
 *
 * Reusa a AGENDA como fila da vez (chegada→atendimento→checkout já existem — ADR-145).
 * Aqui só entram (a) o CATÁLOGO de serviços de grooming da loja e (b) a BOOKING que
 * cria um appointment ligado ao PET (F3) + SERVIÇO. A fila do dia é uma leitura dos
 * appointments de grooming. Nenhum motor/fila paralela.
 *
 * Guardrails: isolamento multi-tenant (orgId 1º arg); valida pet + serviço da MESMA
 * org; reusa ClinicAgendaService.createAppointment (conflitos/duração) — só ANOTA o
 * pet+serviço depois; nunca inventa dado.
 */
import { randomUUID } from "crypto";
import db from "./db.js";
import { logAuthEvent } from "./auditLog.js";
import { ClinicAgendaService } from "./ClinicAgendaService.js";

export interface GroomingServiceInput { name?: string; durationMin?: number | null; priceCents?: number | null; notes?: string | null; active?: boolean; }

export class ClinicGroomingService {
  private static mapSvc(r: any) {
    return { id: r.id, name: r.name, durationMin: r.duration_min ?? null, priceCents: r.price_cents ?? null, notes: r.notes ?? null, active: !!r.active };
  }

  static listServices(orgId: string, opts?: { includeInactive?: boolean }): any[] {
    const rows = opts?.includeInactive
      ? db.prepare(`SELECT * FROM clinic_grooming_services WHERE organization_id = ? ORDER BY active DESC, name`).all(orgId) as any[]
      : db.prepare(`SELECT * FROM clinic_grooming_services WHERE organization_id = ? AND active = 1 ORDER BY name`).all(orgId) as any[];
    return rows.map((r) => this.mapSvc(r));
  }

  static createService(orgId: string, input: GroomingServiceInput, actorId?: string): { id: string } {
    const name = String(input.name || "").trim();
    if (!name) throw new Error("name é obrigatório.");
    const dur = Number(input.durationMin);
    const id = randomUUID();
    db.prepare(`INSERT INTO clinic_grooming_services (id, organization_id, name, duration_min, price_cents, notes, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(id, orgId, name.slice(0, 80), Number.isFinite(dur) && dur > 0 ? Math.round(dur) : 60,
        typeof input.priceCents === "number" ? Math.round(input.priceCents) : null,
        input.notes ? String(input.notes).slice(0, 500) : null, actorId || null);
    try { logAuthEvent(orgId, actorId || "system", orgId, "CLINIC_GROOMING_SERVICE_CREATE", { id, name }); } catch { /* noop */ }
    return { id };
  }

  static updateService(orgId: string, serviceId: string, patch: GroomingServiceInput, actorId?: string): { updated: boolean } {
    const cur = db.prepare(`SELECT * FROM clinic_grooming_services WHERE organization_id = ? AND id = ?`).get(orgId, serviceId) as any;
    if (!cur) throw new Error("serviço não encontrado.");
    const dur = patch.durationMin !== undefined ? Number(patch.durationMin) : cur.duration_min;
    const next = {
      name: patch.name !== undefined ? String(patch.name).trim().slice(0, 80) : cur.name,
      duration_min: Number.isFinite(dur) && dur > 0 ? Math.round(dur) : cur.duration_min,
      price_cents: patch.priceCents !== undefined ? (typeof patch.priceCents === "number" ? Math.round(patch.priceCents) : null) : cur.price_cents,
      notes: patch.notes !== undefined ? (patch.notes ? String(patch.notes).slice(0, 500) : null) : cur.notes,
      active: patch.active !== undefined ? (patch.active ? 1 : 0) : cur.active,
    };
    if (!next.name) throw new Error("name é obrigatório.");
    db.prepare(`UPDATE clinic_grooming_services SET name=@name, duration_min=@duration_min, price_cents=@price_cents, notes=@notes, active=@active, updated_at=CURRENT_TIMESTAMP WHERE organization_id=@org AND id=@id`)
      .run({ ...next, org: orgId, id: serviceId });
    try { logAuthEvent(orgId, actorId || "system", orgId, "CLINIC_GROOMING_SERVICE_UPDATE", { id: serviceId }); } catch { /* noop */ }
    return { updated: true };
  }

  /**
   * Agenda um banho & tosa: cria o appointment (reuso da agenda) ligado ao PET e ao
   * SERVIÇO. O contato do appointment é o TUTOR do pet (resolvido, não inventado).
   */
  static book(orgId: string, input: { petId?: string; groomingServiceId?: string; scheduledStart?: string; professionalId?: string; roomId?: string; force?: boolean }, actorId?: string): any {
    const pet = db.prepare(`SELECT id, name, tutor_contact_id, status FROM clinic_pets WHERE organization_id = ? AND id = ?`).get(orgId, String(input.petId || "")) as any;
    if (!pet) throw new Error("pet não encontrado.");
    if (pet.status !== "active") throw new Error("pet inativo.");
    const svc = db.prepare(`SELECT id, name, duration_min FROM clinic_grooming_services WHERE organization_id = ? AND id = ? AND active = 1`).get(orgId, String(input.groomingServiceId || "")) as any;
    if (!svc) throw new Error("serviço de grooming não encontrado ou inativo.");
    // Reusa a agenda (conflitos/duração). Título = "Serviço — Pet".
    const appt = ClinicAgendaService.createAppointment(orgId, {
      contactId: pet.tutor_contact_id, title: `${svc.name} — ${pet.name}`,
      scheduledStart: input.scheduledStart, professionalId: input.professionalId, roomId: input.roomId,
      durationMinutes: svc.duration_min || 60, force: input.force,
    }, actorId);
    // Anota o pet + serviço no appointment recém-criado.
    db.prepare(`UPDATE appointments SET pet_id = ?, grooming_service_id = ? WHERE organization_id = ? AND id = ?`).run(pet.id, svc.id, orgId, appt.id);
    try { logAuthEvent(orgId, actorId || "system", orgId, "CLINIC_GROOMING_BOOK", { appointmentId: appt.id, petId: pet.id, serviceId: svc.id }); } catch { /* noop */ }
    return { ...appt, pet_id: pet.id, grooming_service_id: svc.id, pet_name: pet.name, service_name: svc.name };
  }

  /** Fila do dia de banho & tosa (appointments de grooming da data, com pet+serviço). */
  static dayQueue(orgId: string, dateISO: string): any[] {
    const day = String(dateISO || "").slice(0, 10);
    const rows = db.prepare(`
      SELECT a.id, a.scheduled_start, a.status, a.checkin_at, a.care_started_at, a.checkout_at,
             a.professional_name_snapshot, p.name AS pet_name, p.species, s.name AS service_name, c.name AS tutor_name
      FROM appointments a
      LEFT JOIN clinic_pets p ON p.id = a.pet_id AND p.organization_id = a.organization_id
      LEFT JOIN clinic_grooming_services s ON s.id = a.grooming_service_id AND s.organization_id = a.organization_id
      LEFT JOIN contacts c ON c.id = a.contact_id AND c.organization_id = a.organization_id
      WHERE a.organization_id = ? AND a.grooming_service_id IS NOT NULL
        AND substr(a.scheduled_start, 1, 10) = ? AND a.status != 'cancelled'
      ORDER BY a.scheduled_start
    `).all(orgId, day) as any[];
    return rows.map((r) => ({
      appointmentId: r.id, scheduledStart: r.scheduled_start, status: r.status,
      checkinAt: r.checkin_at ?? null, careStartedAt: r.care_started_at ?? null, checkoutAt: r.checkout_at ?? null,
      professional: r.professional_name_snapshot ?? null, petName: r.pet_name ?? null, species: r.species ?? null,
      serviceName: r.service_name ?? null, tutorName: r.tutor_name ?? null,
    }));
  }
}

export default ClinicGroomingService;
