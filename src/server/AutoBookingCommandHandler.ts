/**
 * AutoBookingCommandHandler — ADR-180 F4: o efeito REAL do AutoBooking, pelo choke-point
 * governado. Registrado no MESMO registry do executor (§184/RN-PN-7 — sem runtime
 * paralelo), espelhando `SocialPublishCommandHandler`. Agendar automático deixa de ser
 * efeito direto: vira COMANDO que passa por `DecisionAction → ApprovalPolicy (Autonomy
 * Contract) → CommandExecutor` (RN-PN-6) — só chega ao `execute` uma ação APROVADA.
 *
 * `execute` procura a 1ª vaga PROVADA (Availability Engine, F3) na janela pedida, segura
 * com hold atômico e cria o agendamento federado (`confirmBooking`). Sem vaga: NÃO fabrica
 * (RN-PN-4) — publica waitlist em `business_signals` e falha HONESTO (retryável). No
 * sucesso arma `ConfirmationEngine.expect(booking_confirmation)`: AGENDADO ≠ ATENDIDO
 * (RN-PN-5) — o comparecimento é confirmado depois; o timeout do SLA publica sinal via
 * `sweepTimeouts` (já agendado). Isolamento por org (RN-PN-2). Determinístico (nowISO no
 * payload é opcional — testes injetam; produção usa o relógio real).
 */
import { CommandExecutorService, type CommandHandler } from "./CommandExecutorService.js";
import { ProfessionalAvailabilityService } from "./ProfessionalAvailabilityService.js";
import { ConfirmationEngine } from "./ConfirmationEngine.js";

function payloadOf(action: any): any { try { return action.command_payload_json ? JSON.parse(action.command_payload_json) : {}; } catch { return {}; } }

/** Soma `n` dias a "YYYY-MM-DD" em UTC. */
function addDays(dateISO: string, n: number): string {
  const d = new Date(`${dateISO}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function clamp(n: any, lo: number, hi: number, dflt: number): number {
  const v = Number(n); return Number.isFinite(v) ? Math.min(Math.max(Math.round(v), lo), hi) : dflt;
}

/** Procura a 1ª vaga livre na janela [fromDate, fromDate+days). null se nenhuma. */
function firstSlot(orgId: string, p: any): { start: string; end: string; dateISO: string } | null {
  const nowISO = p.nowISO || undefined;
  const fromDate = (p.fromDate && /^\d{4}-\d{2}-\d{2}$/.test(p.fromDate)) ? p.fromDate : (nowISO ? String(nowISO).slice(0, 10) : new Date().toISOString().slice(0, 10));
  const days = clamp(p.days, 1, 60, 14);
  for (let i = 0; i < days; i++) {
    const dateISO = addDays(fromDate, i);
    let slots: any[] = [];
    try {
      slots = ProfessionalAvailabilityService.availableSlots(orgId, String(p.relationshipId || ""), dateISO, {
        serviceId: p.serviceId || undefined,
        slotMinutes: p.slotMinutes || undefined,
        nowISO,
      });
    } catch { return null; } // config inválida (vínculo/serviço) — não inventa vaga
    if (slots.length) return { start: slots[0].start, end: slots[0].end, dateISO };
  }
  return null;
}

export const AutoBookingCommandHandler: CommandHandler = {
  key: "AutoBookingCommandHandler",
  commandTypes: ["auto_booking"],

  prepare(orgId, action) {
    const p = payloadOf(action);
    const slot = firstSlot(orgId, p);
    return {
      summary: slot ? `Vaga proposta: ${slot.start}` : "Sem vaga na janela buscada",
      artifact: { kind: "auto_booking_draft", relationshipId: p.relationshipId || null, proposedSlot: slot, contactId: p.contactId || null, serviceId: p.serviceId || null },
    };
  },

  async execute(orgId, action) {
    const p = payloadOf(action);
    const relationshipId = String(p.relationshipId || "");
    const slot = firstSlot(orgId, p);
    const svc = await import("./ProfessionalBookingService.js");
    const BOOK = svc.ProfessionalBookingService;

    if (!slot) {
      // Sem vaga: NÃO fabrica (RN-PN-4). Registra demanda e falha honesto (retryável).
      BOOK.waitlist(orgId, { relationshipId, serviceId: p.serviceId ?? null, contactId: p.contactId ?? null, petId: p.petId ?? null, note: "AutoBooking não achou vaga na janela — demanda em espera." });
      throw new Error("no_slot_available");
    }

    // Segura a vaga (hold atômico F3) — se perder a corrida, `slot_taken` sobe e a
    // tentativa é auditada como falha (retryável); nunca cria appointment fantasma.
    const hold = ProfessionalAvailabilityService.hold(orgId, relationshipId, {
      serviceId: p.serviceId || undefined,
      startISO: slot.start,
      slotMinutes: p.slotMinutes || undefined,
      nowISO: p.nowISO || undefined,
    }, "auto_booking");

    // Confirma o hold + cria o agendamento federado (idempotente por hold).
    const appt = BOOK.confirmBooking(orgId, { holdId: hold.id, contactId: String(p.contactId || ""), petId: p.petId ?? null, title: p.title ?? null, nowISO: p.nowISO || undefined }, "auto_booking");

    // AGENDADO ≠ ATENDIDO (RN-PN-5): arma a confirmação de comparecimento com SLA.
    try {
      ConfirmationEngine.expect(orgId, { actionId: action.id, method: "booking_confirmation", externalRef: appt.id, deadlineAt: slot.end });
    } catch { /* confirmação é aditiva — nunca bloqueia o efeito já realizado */ }

    return {
      summary: `Agendado ${appt.professionalName || "especialista"} em ${slot.start}`,
      artifact: { kind: "network_booking", appointmentId: appt.id, relationshipId, start: slot.start, end: slot.end, contactId: appt.contactId },
      effect: "booking_created",
      externalRef: appt.id,
    };
  },
};

// Registra no MESMO registry do executor (mesmo padrão de SocialPublishCommandHandler).
CommandExecutorService.registerHandler(AutoBookingCommandHandler);

export default AutoBookingCommandHandler;
