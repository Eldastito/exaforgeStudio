/**
 * ProfessionalBookingService — ADR-180 F4: Booking federado + ferramentas de IA +
 * AutoBooking GOVERNADO (Agenda Federada).
 *
 * É o elo que fecha o valor central: transformar uma vaga PROVADA (F3) num
 * agendamento real, sem depender de contato manual com o especialista. Três papéis:
 *
 *  1) FERRAMENTAS DE IA (determinísticas, ATERRADAS — RN-PN-4): `getAvailability`,
 *     `holdSlot`, `confirmBooking`. A IA (Fala Tu / assistente) só oferece o que o
 *     Availability Engine prova estar livre; NUNCA inventa vaga. `confirmBooking`
 *     confirma o hold atômico (F3) e cria o appointment amarrado ao vínculo da rede
 *     (`network_relationship_id`) — idempotente por hold (nunca 2 appointments).
 *
 *  2) WAITLIST: sem vaga, não fabrica — publica um sinal `professional_network/waitlist`
 *     em `business_signals` (convenção nº 12; nunca tabela de alerta paralela — RN-PN-7),
 *     registrando a DEMANDA para a operação decidir.
 *
 *  3) AUTOBOOKING (RN-PN-6): agendar automático é COMANDO GOVERNADO. `autoBook` PROPÕE
 *     uma `decision_action` (commandType `auto_booking`) que atravessa
 *     `DecisionAction → ApprovalPolicy (Autonomy Contract) → CommandExecutor →
 *     Confirmation`. NUNCA agenda direto fora da banda de autonomia; default exige
 *     aprovação humana. O efeito real vive no `AutoBookingCommandHandler`.
 *
 * Guardrails: isolamento por org (RN-PN-2 — orgId 1º arg); AGENDADO ≠ ATENDIDO
 * (RN-PN-5 — `booking_confirmation` arma SLA do comparecimento); sem motor/policy/
 * confirmation paralelo (§184/RN-PN-7 — reusa a espinha canônica). Determinístico.
 */
import { randomUUID } from "crypto";
import db from "./db.js";
import { logAuthEvent } from "./auditLog.js";
import { ClinicProfessionalRelationshipService } from "./ClinicProfessionalRelationshipService.js";
import { ProfessionalAvailabilityService, type Slot } from "./ProfessionalAvailabilityService.js";
import { BusinessSignalService } from "./BusinessSignalService.js";
import { DecisionActionService } from "./DecisionActionService.js";
import { CommandExecutorService } from "./CommandExecutorService.js";
// Importa o handler pelo efeito colateral de REGISTRO no executor (§184 — mesmo registry).
import "./AutoBookingCommandHandler.js";

export interface ConfirmBookingInput {
  holdId: string;
  contactId: string;
  petId?: string | null;
  title?: string | null;
  nowISO?: string | null;   // relógio injetável (testes); undefined em produção
}
export interface AutoBookInput {
  relationshipId: string;
  contactId: string;
  serviceId?: string | null;
  slotMinutes?: number | null;
  petId?: string | null;
  fromDate?: string | null;   // "YYYY-MM-DD" (default: hoje em UTC via nowISO)
  days?: number | null;       // janela de busca à frente (default 14, máx 60)
  title?: string | null;
  nowISO?: string | null;     // relógio injetável (testes); undefined em produção
  createdBy?: string;
}

export class ProfessionalBookingService {
  // ── Ferramenta de IA 1: disponibilidade ATERRADA (nunca inventa — RN-PN-4). ──
  // F6.2: subtrai o Google busy do PROFISSIONAL (best-effort, async) além de holds+
  // appointments — a IA/operador nunca vê vaga em cima de compromisso do Google. Sem
  // conexão Google → externalBusy vazio → mesmo resultado de antes (0-regressão).
  static async getAvailability(
    orgId: string, relationshipId: string, dateISO: string,
    opts?: { serviceId?: string; slotMinutes?: number; nowISO?: string },
  ): Promise<Slot[]> {
    let externalBusy: Array<{ start: number; end: number }> = [];
    try {
      const rel = ClinicProfessionalRelationshipService.get(orgId, relationshipId);
      if (rel?.professionalId && /^\d{4}-\d{2}-\d{2}$/.test(String(dateISO || ""))) {
        const g = await import("./ProfessionalGoogleService.js");
        externalBusy = await g.ProfessionalGoogleService.busyIntervals(rel.professionalId, {
          timeMinISO: `${dateISO}T00:00:00.000Z`, timeMaxISO: `${dateISO}T23:59:59.999Z`,
        });
      }
    } catch { externalBusy = []; }  // best-effort: falha no Google nunca derruba a disponibilidade
    return ProfessionalAvailabilityService.availableSlots(orgId, relationshipId, dateISO, { ...opts, externalBusy });
  }

  // ── Ferramenta de IA 2: segurar a vaga (hold atômico — RN-PN-5). ──
  static holdSlot(
    orgId: string, relationshipId: string,
    input: { serviceId?: string; startISO?: string; slotMinutes?: number; ttlMinutes?: number; nowISO?: string; token?: string },
    actorId?: string,
  ) {
    return ProfessionalAvailabilityService.hold(orgId, relationshipId, input, actorId);
  }

  /**
   * Ferramenta de IA 3: confirma o hold e CRIA o agendamento federado.
   * ATÔMICO + IDEMPOTENTE: confirma o hold (F3, idempotente) e insere o appointment
   * amarrado ao vínculo; a UNIQUE(org, slot_hold_id) garante que 2 confirmações do
   * MESMO hold devolvem o MESMO appointment (nunca 2). O profissional da rede NÃO é um
   * `clinic_professionals` local — vai como snapshot de nome (professional_name_snapshot)
   * + `network_relationship_id`. Nunca inventa (hold/contato/pet validados). AGENDADO ≠
   * ATENDIDO (RN-PN-5): a confirmação de comparecimento é armada pelo caller (AutoBooking).
   */
  static confirmBooking(orgId: string, input: ConfirmBookingInput, actorId?: string): any {
    const holdId = String(input?.holdId || "");
    const hold = ProfessionalAvailabilityService.getHold(orgId, holdId);
    if (!hold) throw new Error("hold_not_found");                       // isolamento + não inventa (RN-PN-2/4)
    if (hold.status === "released" || hold.status === "expired") throw new Error("hold_not_active");

    // Idempotência durável: appointment já criado para este hold → devolve o mesmo.
    const existing = db.prepare(`SELECT * FROM appointments WHERE organization_id = ? AND slot_hold_id = ?`).get(orgId, holdId) as any;
    if (existing) return this.hydrate(orgId, existing);

    const contactId = String(input?.contactId || "");
    const contact = db.prepare(`SELECT id FROM contacts WHERE id = ? AND organization_id = ?`).get(contactId, orgId) as any;
    if (!contact) throw new Error("contact_not_found");
    const petId = input?.petId ? String(input.petId) : null;
    if (petId) {
      const pet = db.prepare(`SELECT id FROM clinic_pets WHERE id = ? AND organization_id = ?`).get(petId, orgId) as any;
      if (!pet) throw new Error("pet_not_found");
    }

    // Confirma o hold (F3, atômico + idempotente) — trava a vaga durável.
    ProfessionalAvailabilityService.confirm(orgId, holdId, { nowISO: input?.nowISO || undefined }, actorId);

    const rel = ClinicProfessionalRelationshipService.get(orgId, hold.relationshipId);
    const profName = rel?.professional?.name || "Especialista da rede";
    const title = String(input?.title || `Atendimento — ${profName}`).trim() || "Atendimento";

    // F8.1 — snapshot do serviço + preço ACORDADO no agendamento (o valor devido é o
    // combinado quando reservou, não o catálogo de hoje — espírito da convenção nº 3).
    // Sem serviço no hold ou sem preço no catálogo → NULL (o financeiro deriva honesto,
    // nunca inventa dinheiro — RN-PN-4). O split fica DERIVADO no ProfessionalFinanceService.
    const serviceId = hold.serviceId || null;
    let servicePrice: number | null = null;
    if (serviceId) {
      const svc = db.prepare(`SELECT price FROM products_services WHERE id = ? AND organization_id = ?`).get(serviceId, orgId) as any;
      servicePrice = svc && svc.price != null ? Number(svc.price) : null;
    }

    const id = randomUUID();
    db.prepare(`INSERT INTO appointments
      (id, organization_id, contact_id, title, scheduled_start, scheduled_end, status, professional_name_snapshot, network_relationship_id, slot_hold_id, pet_id, network_service_id, network_service_price)
      VALUES (?, ?, ?, ?, ?, ?, 'confirmed', ?, ?, ?, ?, ?, ?)`)
      .run(id, orgId, contactId, title, hold.start, hold.end, profName, hold.relationshipId, holdId, petId, serviceId, servicePrice);

    try {
      logAuthEvent(orgId, actorId || "system", id, "PROF_BOOKING_CONFIRMED", {
        holdId, relationshipId: hold.relationshipId, professionalId: hold.professionalId, contactId, petId,
      });
    } catch { /* noop */ }
    return this.hydrate(orgId, db.prepare(`SELECT * FROM appointments WHERE id = ?`).get(id));
  }

  /**
   * Registra DEMANDA sem vaga (nunca fabrica appointment — RN-PN-4). Publica um sinal
   * na espinha canônica (`business_signals`, dedupe por vínculo+serviço+contato). Best-
   * effort: nunca lança pro caller (o AutoBooking usa isto quando não acha vaga).
   */
  static waitlist(orgId: string, input: { relationshipId: string; serviceId?: string | null; contactId?: string | null; petId?: string | null; note?: string | null }): { ok: boolean } {
    try {
      const rel = ClinicProfessionalRelationshipService.get(orgId, String(input.relationshipId || ""));
      const profName = rel?.professional?.name || "especialista";
      BusinessSignalService.publish(orgId, {
        domain: "clinic",
        signalType: "professional_network/waitlist",
        severity: "attention",
        basis: "fact",
        confidence: 1,
        sourceService: "ProfessionalBookingService",
        sourceEntityType: "relationship",
        sourceEntityId: String(input.relationshipId || ""),
        subjectType: input.petId ? "pet" : "contact",
        subjectId: input.petId || input.contactId || null,
        dedupeKey: `clinic:prof_waitlist:${input.relationshipId}:${input.serviceId || "any"}:${input.contactId || "any"}`,
        evidence: {
          gap: "no_slot_available",
          professional: profName,
          serviceId: input.serviceId || null,
          contactId: input.contactId || null,
          petId: input.petId || null,
          note: input.note || "Sem vaga na janela buscada — demanda registrada para a operação.",
        },
      } as any);
      return { ok: true };
    } catch { return { ok: false }; }
  }

  /**
   * AUTOBOOKING (RN-PN-6): agendar automático como COMANDO GOVERNADO. NÃO agenda aqui —
   * PROPÕE a ação (commandType `auto_booking`); o efeito real roda no handler quando a
   * governança aprova. Semear a `agent_policy` (execute/approved_execution) NÃO amplia
   * autonomia — só deixa o executor PERMITIR o efeito que a aprovação liberar (mesma
   * lógica do GovernedPublishService/dispatchGoverned). Default: policy exige aprovação
   * humana (a ação nasce `awaiting_approval`); o Autonomy Contract do dono pode liberar.
   */
  static autoBook(orgId: string, input: AutoBookInput, actorId?: string): any {
    const relationshipId = String(input?.relationshipId || "");
    const rel = ClinicProfessionalRelationshipService.get(orgId, relationshipId);
    if (!rel) throw new Error("relationship_not_found");
    if (rel.status !== "accepted") throw new Error("relationship_not_accepted");
    const contactId = String(input?.contactId || "");
    const contact = db.prepare(`SELECT id FROM contacts WHERE id = ? AND organization_id = ?`).get(contactId, orgId) as any;
    if (!contact) throw new Error("contact_not_found");

    // Semeia a política de execução (idempotente; não amplia autonomia).
    const pol = db.prepare(`SELECT id FROM agent_policies WHERE organization_id = ? AND domain = 'clinic' AND action_type = 'auto_booking'`).get(orgId) as any;
    if (!pol) {
      db.prepare(`INSERT INTO agent_policies (id, organization_id, domain, action_type, autonomy_level, execution_mode, active) VALUES (?, ?, 'clinic', 'auto_booking', 'execute', 'approved_execution', 1)`)
        .run(randomUUID(), orgId);
    }

    const profName = rel.professional?.name || "especialista";
    return DecisionActionService.propose(orgId, {
      domain: "clinic",
      actionType: "auto_booking",
      title: input.title || `Agendar ${profName} (rede)`,
      commandType: "auto_booking",
      commandPayload: {
        relationshipId,
        contactId,
        serviceId: input.serviceId ?? null,
        slotMinutes: input.slotMinutes ?? null,
        petId: input.petId ?? null,
        fromDate: input.fromDate ?? null,
        days: input.days ?? null,
        title: input.title ?? null,
        nowISO: input.nowISO ?? null,
      },
      createdBy: input.createdBy || actorId || "assistant",
    });
  }

  /**
   * F6.3 — empurra o atendimento federado pra agenda GOOGLE do profissional (best-effort,
   * async, IDEMPOTENTE). Chamado pelos callers ASSÍNCRONOS depois do `confirmBooking` (o
   * confirm em si segue síncrono). Sem conexão Google → no-op (0-regressão); já empurrado
   * (`network_google_event_id` setado) → no-op. Nunca lança pro caller (o agendamento já
   * existe; o Google é aditivo). Guarda o id do evento (registry de "eventos que criamos").
   */
  static async pushToGoogle(orgId: string, appointmentId: string): Promise<void> {
    try {
      const a = db.prepare(`SELECT * FROM appointments WHERE organization_id = ? AND id = ? AND network_relationship_id IS NOT NULL`).get(orgId, String(appointmentId || "")) as any;
      if (!a || !a.scheduled_start || a.network_google_event_id) return;   // não federado / sem data / já empurrado
      if (["cancelled", "no_show"].includes(a.status)) return;
      const rel = ClinicProfessionalRelationshipService.get(orgId, a.network_relationship_id);
      if (!rel?.professionalId) return;
      const g = await import("./ProfessionalGoogleService.js");
      if (!g.ProfessionalGoogleService.getConnection(rel.professionalId)) return; // não conectado → 0-regressão
      const endISO = a.scheduled_end || new Date(new Date(a.scheduled_start).getTime() + 60 * 60000).toISOString();
      const eventId = await g.ProfessionalGoogleService.createEvent(rel.professionalId, {
        summary: a.title || "Atendimento", description: "Agendamento via ZapFlow (Agenda Federada).",
        startISO: a.scheduled_start, endISO,
      });
      if (eventId) db.prepare(`UPDATE appointments SET network_google_event_id = ? WHERE organization_id = ? AND id = ?`).run(eventId, orgId, appointmentId);
    } catch (e) { console.error("[Prof Booking] pushToGoogle:", e); }
  }

  /** Remove o evento do Google do atendimento federado (best-effort) e limpa o vínculo. */
  static async removeFromGoogle(orgId: string, appointmentId: string): Promise<void> {
    try {
      const a = db.prepare(`SELECT network_relationship_id, network_google_event_id FROM appointments WHERE organization_id = ? AND id = ?`).get(orgId, String(appointmentId || "")) as any;
      if (!a?.network_google_event_id || !a.network_relationship_id) return;
      const rel = ClinicProfessionalRelationshipService.get(orgId, a.network_relationship_id);
      if (rel?.professionalId) {
        const g = await import("./ProfessionalGoogleService.js");
        await g.ProfessionalGoogleService.deleteEvent(rel.professionalId, a.network_google_event_id);
      }
      db.prepare(`UPDATE appointments SET network_google_event_id = NULL WHERE organization_id = ? AND id = ?`).run(orgId, appointmentId);
    } catch (e) { console.error("[Prof Booking] removeFromGoogle:", e); }
  }

  /**
   * Cancela um atendimento federado: marca `cancelled` (preserva histórico — nunca apaga,
   * convenção nº 9) e remove o evento do Google. Idempotente. Retorna o appointment.
   */
  static async cancelBooking(orgId: string, appointmentId: string, actorId?: string): Promise<any> {
    const a = db.prepare(`SELECT * FROM appointments WHERE organization_id = ? AND id = ? AND network_relationship_id IS NOT NULL`).get(orgId, String(appointmentId || "")) as any;
    if (!a) throw new Error("appointment_not_found");
    if (a.status !== "cancelled") {
      db.prepare(`UPDATE appointments SET status = 'cancelled' WHERE organization_id = ? AND id = ?`).run(orgId, appointmentId);
      try { logAuthEvent(orgId, actorId || "system", appointmentId, "PROF_BOOKING_CANCELLED", { relationshipId: a.network_relationship_id }); } catch { /* noop */ }
    }
    await this.removeFromGoogle(orgId, appointmentId);
    return this.hydrate(orgId, db.prepare(`SELECT * FROM appointments WHERE id = ?`).get(appointmentId));
  }

  /** Executa o efeito de uma ação de auto_booking APROVADA (pelo choke-point governado). */
  static executeAutoBooking(orgId: string, actionId: string): Promise<any> {
    return CommandExecutorService.execute(orgId, actionId);
  }

  /** Hidrata um appointment federado num shape enxuto (sem depender do hydrate da agenda). */
  private static hydrate(orgId: string, r: any): any {
    if (!r) return null;
    const rel = r.network_relationship_id ? ClinicProfessionalRelationshipService.get(orgId, r.network_relationship_id) : null;
    return {
      id: r.id,
      contactId: r.contact_id,
      title: r.title,
      scheduledStart: r.scheduled_start,
      scheduledEnd: r.scheduled_end,
      status: r.status,
      professionalName: r.professional_name_snapshot ?? null,
      networkRelationshipId: r.network_relationship_id ?? null,
      professionalId: rel?.professionalId ?? null,
      slotHoldId: r.slot_hold_id ?? null,
      petId: r.pet_id ?? null,
    };
  }
}

export default ProfessionalBookingService;
