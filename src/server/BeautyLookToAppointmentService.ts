/**
 * BeautyLookToAppointmentService (ADR-169 F10 / BEAUTY-010) — o elo final
 * da Beauty AI: consulta com visual escolhido → profissional capaz →
 * disponibilidade → agendamento REAL.
 *
 * Este é o serviço que fecha o ciclo do §7/§46 do PRD: a foto da cliente vira
 * simulação (F6), a simulação vira análise descritiva (F8), o look casa com
 * serviços do catálogo real (F9), e AGORA vira um horário reservado na agenda
 * canônica com a profissional certa. Sem esta fatia, a Beauty AI é uma
 * "brincadeira" — com ela, é uma virada operacional.
 *
 * COMPOSIÇÃO PURA — nenhum motor novo (§4/§37 do PRD, RN-BS canônico):
 *
 *  - `ProfessionalServiceService.listProfessionalsFor` (F4) — quem sabe fazer
 *    este serviço (com filtro `activeOnly`, ordem `is_primary DESC, name`).
 *  - `ClinicScheduleSessionService.availability` (ADR-145 F41) — próximos
 *    horários livres do profissional, respeitando conflito de agenda +
 *    ausências + capacidade de sala. Já valida cross-tenant do
 *    `clinic_professionals` (a mesma tabela que a beauty usa como roster).
 *  - `AppointmentService.create` (F4/ADR-160 F6) — porta canônica de
 *    criação do agendamento (calcula fim pela duração do serviço; audita).
 *  - `beauty_visual_consultations.scheduled_appointment_id` (F5) — coluna
 *    JÁ existente, aqui finalmente populada; fecha o fio consulta→appt sem
 *    tabela nova.
 *
 * O "snapshot visual" (qual simulação a cliente escolheu) NÃO precisa ser
 * duplicado no appointment: é DERIVÁVEL via `scheduled_appointment_id` +
 * `selected_simulation_id` da consulta (RN-004 — nunca duplique o que dá
 * pra query). E respeita LGPD: quando a foto é purgada por retenção
 * (F5 `purgeExpired`), o snapshot some naturalmente com ela.
 *
 * Guardrails RN-BS ATIVOS:
 *
 *  - RN-BS-07 (isolamento cross-tenant duro): TODA query filtra
 *    `organization_id`. Consulta/serviço/profissional de outra org →
 *    `not_found` silencioso (não vaza existência).
 *  - RN-BS-11 (nunca inventa): se o profissional NÃO é capaz (link inexistente
 *    ou inativo), `book` REJEITA — não "chuta" um pro qualquer. Serviço não
 *    encontrado no catálogo → REJEITA (mesma regra do F9).
 *  - RN-BS-08 (dinheiro role-gated): `book` NÃO retorna valores monetários no
 *    response — a rota role-gateia se precisar. Duração e nome do serviço são
 *    OK (pública ao tenant).
 *  - RN-BS-03 (IA nunca julga aparência): este serviço NÃO chama IA. Sugestão
 *    de serviço vem do F9 (LLM-free); aqui só orquestra agenda.
 *
 * Fluxo canônico:
 *
 *   1) Cliente escolhe look → `select` (rota F7) move consulta pra `selected`
 *      + `selected_simulation_id`.
 *   2) UI mostra serviços recomendados via `LookServiceRecommendationService`
 *      (F9). Cliente escolhe um `serviceId`.
 *   3) UI chama `availability(orgId, consultationId, {serviceId, ...})` —
 *      retorna [{professional, slots[]}, ...].
 *   4) Cliente escolhe profissional + horário → `book(orgId, consultationId,
 *      {serviceId, professionalId, startISO}, actorId)`.
 *   5) Consulta vira `scheduled` com `scheduled_appointment_id` populado.
 *      Appointment tem `professional_id` + `product_service_id` +
 *      `professional_name_snapshot` (preserva nome mesmo se pro for renomeado).
 *
 * F10 NÃO agenda por IA — a decisão é HUMANA (RN-BS-12: autopilot nunca vai
 * direto pra GA). A automação de "IA sugere follow-up depois da sim
 * abandonada" é F11 (Autopilot em shadow), governada por
 * DecisionAction→ApprovalPolicy→CommandExecutor.
 */
import { randomUUID } from "node:crypto";
import db from "./db.js";
import { logAuthEvent } from "./auditLog.js";
import { AppointmentService } from "./AppointmentService.js";
import { ProfessionalServiceService } from "./ProfessionalServiceService.js";
import { ClinicScheduleSessionService } from "./ClinicScheduleSessionService.js";

// Janela padrão de busca por disponibilidade (7 dias). ADR-145 F41 aceita até
// 14; 7 é o suficiente pra tela de agendamento sem lotar a resposta.
const DEFAULT_AVAILABILITY_DAYS = 7;
const MAX_SUGGESTIONS_PER_PROFESSIONAL = 3;

export interface BeautyAvailabilityProfessional {
  professionalId: string;
  professionalName: string;
  isPrimary: boolean;
  slots: Array<{ startISO: string; endISO: string; durationMinutes: number }>;
}

export interface BeautyAvailabilityResult {
  ok: true;
  consultationId: string;
  serviceId: string;
  serviceName: string;
  durationMinutes: number;
  professionals: BeautyAvailabilityProfessional[];
}

export interface BeautyAvailabilityEmpty {
  ok: false;
  reason:
    | "consultation_not_found"
    | "consultation_not_selected"
    | "service_not_found"
    | "service_missing_duration"
    | "no_capable_professional";
  message: string;
  consultationId: string;
  serviceId: string;
}

export interface BeautyBookResult {
  ok: true;
  consultationId: string;
  appointmentId: string;
  scheduledStart: string;
  scheduledEnd: string;
  professionalId: string;
  professionalName: string;
  serviceId: string;
  serviceName: string;
  durationMinutes: number;
}

export interface BeautyBookError {
  ok: false;
  reason:
    | "consultation_not_found"
    | "consultation_not_selected"
    | "service_not_found"
    | "service_missing_duration"
    | "professional_not_capable"
    | "slot_conflict"
    | "invalid_start";
  message: string;
}

export class BeautyLookToAppointmentService {
  /**
   * "Quem pode fazer este serviço e quando?" — porta ÚNICA de disponibilidade
   * pra Beauty. Composição pura, read-only, determinística (mesmos inputs →
   * mesmos outputs; sem randomness).
   *
   * Regras de negócio:
   *  - Consulta DEVE estar `selected` (senão a UI ainda não sabe QUAL sim
   *    ligar; a agenda seria "no vácuo").
   *  - Serviço DEVE existir no catálogo do tenant, type='service', active=1,
   *    duration_minutes > 0 (senão a agenda não sabe reservar quanto tempo).
   *  - Só profissionais com link ATIVO em `professional_services` entram
   *    (RN-BS-11 — nunca infere capacidade sem prova).
   */
  static availability(
    orgId: string,
    consultationId: string,
    input: {
      serviceId: string;
      fromMs?: number;
      days?: number;
      roomId?: string | null;
      maxSuggestionsPerProfessional?: number;
    },
  ): BeautyAvailabilityResult | BeautyAvailabilityEmpty {
    const serviceId = String(input?.serviceId || "").trim();
    if (!consultationId || !serviceId) {
      return {
        ok: false,
        reason: "service_not_found",
        message: "consultationId e serviceId são obrigatórios.",
        consultationId,
        serviceId,
      };
    }

    const cons = db
      .prepare(
        `SELECT id, status FROM beauty_visual_consultations
          WHERE id = ? AND organization_id = ?`,
      )
      .get(consultationId, orgId) as { id: string; status: string } | undefined;
    if (!cons) {
      return {
        ok: false,
        reason: "consultation_not_found",
        message: "Consulta não encontrada nesta organização.",
        consultationId,
        serviceId,
      };
    }
    if (cons.status !== "selected") {
      return {
        ok: false,
        reason: "consultation_not_selected",
        message: `Consulta em '${cons.status}' — só 'selected' pode virar agendamento.`,
        consultationId,
        serviceId,
      };
    }

    const svc = db
      .prepare(
        `SELECT id, name, duration_minutes FROM products_services
          WHERE id = ? AND organization_id = ? AND type = 'service' AND active = 1`,
      )
      .get(serviceId, orgId) as
      | { id: string; name: string; duration_minutes: number | null }
      | undefined;
    if (!svc) {
      return {
        ok: false,
        reason: "service_not_found",
        message: "Serviço não encontrado no catálogo (ativo, type='service').",
        consultationId,
        serviceId,
      };
    }
    const durationMinutes = Number(svc.duration_minutes || 0);
    if (!Number.isFinite(durationMinutes) || durationMinutes < 5) {
      return {
        ok: false,
        reason: "service_missing_duration",
        message:
          "Serviço não tem duration_minutes válida (>=5). Ajuste em Configurações › Catálogo.",
        consultationId,
        serviceId,
      };
    }

    const capable = ProfessionalServiceService.listProfessionalsFor(orgId, serviceId, {
      activeOnly: true,
    });
    if (capable.length === 0) {
      return {
        ok: false,
        reason: "no_capable_professional",
        message:
          "Nenhum profissional habilitado a este serviço. Ajuste em Configurações › Equipe.",
        consultationId,
        serviceId,
      };
    }

    const days = Math.max(1, Math.min(14, Math.floor(Number(input?.days) || DEFAULT_AVAILABILITY_DAYS)));
    const fromMs = Number.isFinite(input?.fromMs)
      ? (input!.fromMs as number)
      : Date.parse(new Date().toISOString().slice(0, 10) + "T00:00:00Z");
    const toMs = fromMs + days * 24 * 60 * 60 * 1000;
    const maxSuggestions = Math.max(
      1,
      Math.min(10, Math.floor(Number(input?.maxSuggestionsPerProfessional) || MAX_SUGGESTIONS_PER_PROFESSIONAL)),
    );

    const professionals: BeautyAvailabilityProfessional[] = [];
    for (const p of capable) {
      let slots: Array<{ startISO: string; endISO: string; durationMinutes: number }> = [];
      try {
        slots = ClinicScheduleSessionService.availability(orgId, {
          professionalId: p.professionalId,
          durationMinutes,
          from: new Date(fromMs).toISOString(),
          to: new Date(toMs).toISOString(),
          roomId: input?.roomId || null,
          maxSuggestions,
        });
      } catch {
        // Ex.: profissional inativo entre lista e query. Preserva o resto.
        slots = [];
      }
      professionals.push({
        professionalId: p.professionalId,
        professionalName: p.professionalName,
        isPrimary: p.isPrimary,
        slots,
      });
    }

    return {
      ok: true,
      consultationId,
      serviceId,
      serviceName: svc.name,
      durationMinutes,
      professionals,
    };
  }

  /**
   * Reserva o horário: cria appointment via AppointmentService.create (porta
   * canônica), populando professional_id + professional_name_snapshot +
   * product_service_id, e amarra à consulta via scheduled_appointment_id.
   * Idempotente por consultation: se já tem `scheduled_appointment_id`,
   * retorna o mesmo (evita agendar duas vezes o mesmo look — RN-BS-11).
   */
  static book(
    orgId: string,
    consultationId: string,
    input: { serviceId: string; professionalId: string; startISO: string },
    actorId?: string | null,
  ): BeautyBookResult | BeautyBookError {
    const serviceId = String(input?.serviceId || "").trim();
    const professionalId = String(input?.professionalId || "").trim();
    const startISO = String(input?.startISO || "").trim();
    if (!serviceId || !professionalId || !startISO) {
      return {
        ok: false,
        reason: "invalid_start",
        message: "serviceId, professionalId e startISO são obrigatórios.",
      };
    }
    const startMs = Date.parse(startISO);
    if (!Number.isFinite(startMs)) {
      return { ok: false, reason: "invalid_start", message: "startISO inválido." };
    }

    const cons = db
      .prepare(
        `SELECT id, status, contact_id, scheduled_appointment_id
           FROM beauty_visual_consultations
          WHERE id = ? AND organization_id = ?`,
      )
      .get(consultationId, orgId) as
      | {
          id: string;
          status: string;
          contact_id: string | null;
          scheduled_appointment_id: string | null;
        }
      | undefined;
    if (!cons) {
      return {
        ok: false,
        reason: "consultation_not_found",
        message: "Consulta não encontrada nesta organização.",
      };
    }
    if (!cons.contact_id) {
      return {
        ok: false,
        reason: "consultation_not_found",
        message: "Consulta não tem contato associado.",
      };
    }
    // Idempotência: se já agendou, devolve o mesmo (não cria appointment duplo).
    if (cons.status === "scheduled" && cons.scheduled_appointment_id) {
      const prior = db
        .prepare(
          `SELECT a.id, a.scheduled_start, a.scheduled_end, a.professional_id,
                  a.professional_name_snapshot, a.product_service_id,
                  ps.name AS service_name, ps.duration_minutes
             FROM appointments a
             LEFT JOIN products_services ps
               ON ps.id = a.product_service_id AND ps.organization_id = a.organization_id
            WHERE a.id = ? AND a.organization_id = ?`,
        )
        .get(cons.scheduled_appointment_id, orgId) as any;
      if (prior) {
        return {
          ok: true,
          consultationId,
          appointmentId: prior.id,
          scheduledStart: prior.scheduled_start,
          scheduledEnd: prior.scheduled_end,
          professionalId: prior.professional_id || professionalId,
          professionalName: prior.professional_name_snapshot || "",
          serviceId: prior.product_service_id || serviceId,
          serviceName: prior.service_name || "",
          durationMinutes: Number(prior.duration_minutes || 0),
        };
      }
    }
    if (cons.status !== "selected") {
      return {
        ok: false,
        reason: "consultation_not_selected",
        message: `Consulta em '${cons.status}' — só 'selected' pode virar agendamento.`,
      };
    }

    const svc = db
      .prepare(
        `SELECT id, name, duration_minutes FROM products_services
          WHERE id = ? AND organization_id = ? AND type = 'service' AND active = 1`,
      )
      .get(serviceId, orgId) as
      | { id: string; name: string; duration_minutes: number | null }
      | undefined;
    if (!svc) {
      return {
        ok: false,
        reason: "service_not_found",
        message: "Serviço não encontrado no catálogo.",
      };
    }
    const durationMinutes = Number(svc.duration_minutes || 0);
    if (!Number.isFinite(durationMinutes) || durationMinutes < 5) {
      return {
        ok: false,
        reason: "service_missing_duration",
        message:
          "Serviço não tem duration_minutes válida (>=5). Ajuste em Configurações › Catálogo.",
      };
    }

    if (!ProfessionalServiceService.isCapable(orgId, professionalId, serviceId)) {
      return {
        ok: false,
        reason: "professional_not_capable",
        message:
          "Profissional não está habilitado a este serviço (link inativo, profissional inativo ou fora do catálogo).",
      };
    }

    const prof = db
      .prepare(
        `SELECT id, name FROM clinic_professionals
          WHERE id = ? AND organization_id = ? AND active = 1`,
      )
      .get(professionalId, orgId) as { id: string; name: string } | undefined;
    if (!prof) {
      return {
        ok: false,
        reason: "professional_not_capable",
        message: "Profissional não encontrado ou inativo.",
      };
    }

    const endMs = startMs + durationMinutes * 60000;
    // Guard: no conflict on the professional at this slot (aditivo — o
    // AppointmentService.create não conhece per-professional conflict; a
    // agenda clínica já valida em ClinicAgendaService.createAppointment, mas
    // aqui usamos a porta canônica sem clínica → cheque explícito).
    const conflict = db
      .prepare(
        `SELECT id FROM appointments
          WHERE organization_id = ? AND professional_id = ?
            AND status NOT IN ('cancelled','no_show')
            AND scheduled_start < ? AND scheduled_end > ?
          LIMIT 1`,
      )
      .get(
        orgId,
        professionalId,
        new Date(endMs).toISOString(),
        new Date(startMs).toISOString(),
      );
    if (conflict) {
      return {
        ok: false,
        reason: "slot_conflict",
        message: "Este profissional já tem agendamento nesse horário.",
      };
    }

    // Cria via porta canônica (calcula fim pela duração do serviço — F4).
    const appt = AppointmentService.create(
      orgId,
      {
        contactId: cons.contact_id,
        title: svc.name,
        scheduledStart: new Date(startMs).toISOString(),
        scheduledEnd: new Date(endMs).toISOString(),
        productServiceId: serviceId,
      },
      actorId || null,
    ) as {
      id: string;
      scheduled_start: string;
      scheduled_end: string;
    };

    // Amarra profissional + snapshot do nome (preserva mesmo se pro for renomeado).
    db.prepare(
      `UPDATE appointments
          SET professional_id = ?, professional_name_snapshot = ?
        WHERE id = ? AND organization_id = ?`,
    ).run(professionalId, prof.name, appt.id, orgId);

    // Amarra consulta → appt e move pra 'scheduled'.
    db.prepare(
      `UPDATE beauty_visual_consultations
          SET status = 'scheduled', scheduled_appointment_id = ?
        WHERE id = ? AND organization_id = ?`,
    ).run(appt.id, consultationId, orgId);

    try {
      logAuthEvent(orgId, actorId || null, consultationId, "BEAUTY_CONSULTATION_BOOKED", {
        appointment_id: appt.id,
        service_id: serviceId,
        professional_id: professionalId,
      });
    } catch {
      /* noop */
    }

    return {
      ok: true,
      consultationId,
      appointmentId: appt.id,
      scheduledStart: appt.scheduled_start,
      scheduledEnd: appt.scheduled_end,
      professionalId,
      professionalName: prof.name,
      serviceId,
      serviceName: svc.name,
      durationMinutes,
    };
  }

  /**
   * Lookup DERIVADO: dado um appointment, retorna a consulta beauty que o
   * originou (com o visual snapshot). RN-004 — nada é duplicado no
   * appointment; a via é sempre pela FK `scheduled_appointment_id`. Uso
   * típico: cabeleireira abre o appointment na agenda e a UI recupera a
   * simulação escolhida.
   */
  static consultationForAppointment(orgId: string, appointmentId: string) {
    if (!appointmentId) return null;
    const row = db
      .prepare(
        `SELECT id, contact_id, status, selected_simulation_id, scheduled_appointment_id
           FROM beauty_visual_consultations
          WHERE organization_id = ? AND scheduled_appointment_id = ?
          ORDER BY selected_at DESC, rowid DESC
          LIMIT 1`,
      )
      .get(orgId, appointmentId) as
      | {
          id: string;
          contact_id: string | null;
          status: string;
          selected_simulation_id: string | null;
          scheduled_appointment_id: string | null;
        }
      | undefined;
    if (!row) return null;
    return {
      consultationId: row.id,
      contactId: row.contact_id,
      status: row.status,
      selectedSimulationId: row.selected_simulation_id,
      appointmentId: row.scheduled_appointment_id,
    };
  }
}

export default BeautyLookToAppointmentService;
