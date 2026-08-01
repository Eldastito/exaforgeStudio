/**
 * Módulo Clínica — SESSÃO DE AGENDA COMPARTILHADA (ADR-145 D6, Fatia 41).
 *
 * Habilita "vários pacientes no mesmo horário, para o mesmo médico" como
 * PRIMEIRA CLASSE — resolve dor #3 do cliente (áudio 1) sem gambiarra
 * de `force=true`. Cliente confirmou 2026-07: só GRUPO (não "parallel").
 *
 * REGRAS CRÍTICAS:
 *   - Cada participante mantém `appointment` PRÓPRIO (prontuário,
 *     lembrete, presença, recibo, portal — tudo individual).
 *   - Todos os appointments apontam pra mesma `schedule_session_id`.
 *   - RN-006: grupo de 5 pacientes = 1 ocupação de agenda do profissional
 *     (não 5). Refactor do conflict é na Fatia 42.
 *   - AC-012: corrida na última vaga resolvida por transação atômica —
 *     COUNT dentro da tx antes do INSERT.
 *   - Capacity 1..100 (limite superior evita erro de digitação humana).
 *
 * Escopo desta fatia: create + list + getWithParticipants + addParticipant
 * (atômico) + removeParticipant + cancelSession. NÃO refactor de conflict
 * (Fatia 42). NÃO métricas de ocupação por sessão (Fatia 43).
 */
import { randomUUID } from "node:crypto";
import db from "./db.js";
import { logAuthEvent } from "./auditLog.js";
import { ClinicAgendaService } from "./ClinicAgendaService.js";
import { ClinicProfessionalAbsenceService } from "./ClinicProfessionalAbsenceService.js";

export type SessionType = "individual" | "group";
export type SessionStatus = "scheduled" | "in_care" | "completed" | "cancelled";

export interface ScheduleSession {
  id: string;
  organizationId: string;
  specialtyId: string;
  professionalId: string;
  roomId: string | null;
  procedureId: string | null;
  sessionType: SessionType;
  title: string | null;
  scheduledStart: string;
  scheduledEnd: string;
  durationMinutes: number;
  capacity: number;
  status: SessionStatus;
  cancelledAt: string | null;
  cancelledReason: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SessionParticipant {
  appointmentId: string;
  contactId: string;
  contactName: string | null;
  careEpisodeId: string | null;
  treatmentCycleId: string | null;
  appointmentStatus: string;
  scheduledStart: string;
}

function hydrate(r: any): ScheduleSession | null {
  if (!r) return null;
  return {
    id: r.id,
    organizationId: r.organization_id,
    specialtyId: r.specialty_id,
    professionalId: r.professional_id,
    roomId: r.room_id ?? null,
    procedureId: r.procedure_id ?? null,
    sessionType: r.session_type,
    title: r.title ?? null,
    scheduledStart: r.scheduled_start,
    scheduledEnd: r.scheduled_end,
    durationMinutes: Number(r.duration_minutes),
    capacity: Number(r.capacity),
    status: r.status,
    cancelledAt: r.cancelled_at ?? null,
    cancelledReason: r.cancelled_reason ?? null,
    createdBy: r.created_by ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function validCapacity(n: any): number {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v) || v < 1 || v > 100) {
    throw new Error("capacity deve estar entre 1 e 100.");
  }
  return v;
}

function validDuration(n: any): number {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v) || v < 5 || v > 480) {
    throw new Error("durationMinutes deve estar entre 5 e 480.");
  }
  return v;
}

function assertProfessionalInSpecialty(orgId: string, professionalId: string, specialtyId: string): void {
  const link = db.prepare(
    `SELECT id FROM clinic_professional_specialties
      WHERE organization_id = ? AND professional_id = ? AND specialty_id = ? AND active = 1`
  ).get(orgId, professionalId, specialtyId) as any;
  if (!link) {
    const e: any = new Error("Profissional não está vinculado a esta especialidade.");
    e.code = "PROFESSIONAL_NOT_IN_SPECIALTY";
    throw e;
  }
}

export class ClinicScheduleSessionService {
  // ── Leitura ────────────────────────────────────────────────────────────

  static get(orgId: string, id: string): ScheduleSession | null {
    const r = db.prepare(
      `SELECT * FROM clinic_schedule_sessions WHERE organization_id = ? AND id = ?`
    ).get(orgId, id) as any;
    return hydrate(r);
  }

  /** Participantes atuais (com nome do contato + status do appointment). */
  static listParticipants(orgId: string, sessionId: string, opts: { includeCancelled?: boolean } = {}): SessionParticipant[] {
    const clause = opts.includeCancelled
      ? ""
      : "AND a.status NOT IN ('cancelled')";
    const rows = db.prepare(
      `SELECT a.id AS appointment_id, a.contact_id, a.care_episode_id, a.treatment_cycle_id,
              a.status AS appointment_status, a.scheduled_start,
              c.name AS contact_name
         FROM appointments a
         LEFT JOIN contacts c ON c.id = a.contact_id AND c.organization_id = a.organization_id
        WHERE a.organization_id = ? AND a.schedule_session_id = ? ${clause}
        ORDER BY c.name ASC`
    ).all(orgId, sessionId) as any[];
    return rows.map((r) => ({
      appointmentId: r.appointment_id,
      contactId: r.contact_id,
      contactName: r.contact_name ?? null,
      careEpisodeId: r.care_episode_id ?? null,
      treatmentCycleId: r.treatment_cycle_id ?? null,
      appointmentStatus: r.appointment_status,
      scheduledStart: r.scheduled_start,
    }));
  }

  /** Sessões de um profissional numa data (padrão pra agenda diária). */
  static listByProfessionalDay(orgId: string, professionalId: string, dateISO: string): Array<ScheduleSession & { participantsCount: number }> {
    // dateISO = "YYYY-MM-DD" — filtra scheduled_start no dia (UTC)
    const fromISO = `${dateISO}T00:00:00.000Z`;
    const toISO = `${dateISO}T23:59:59.999Z`;
    const rows = db.prepare(
      `SELECT s.*, (
                SELECT COUNT(*) FROM appointments a
                 WHERE a.organization_id = s.organization_id
                   AND a.schedule_session_id = s.id
                   AND a.status NOT IN ('cancelled')
             ) AS participants_count
         FROM clinic_schedule_sessions s
        WHERE s.organization_id = ?
          AND s.professional_id = ?
          AND s.scheduled_start >= ? AND s.scheduled_start <= ?
          AND s.status != 'cancelled'
        ORDER BY s.scheduled_start ASC`
    ).all(orgId, professionalId, fromISO, toISO) as any[];
    return rows.map((r) => ({
      ...hydrate(r)!,
      participantsCount: Number(r.participants_count) || 0,
    }));
  }

  // ── Criar sessão ───────────────────────────────────────────────────────

  /**
   * Cria uma sessão de grupo. Valida:
   *   - Specialty existe e está ativa.
   *   - Professional existe, ativo E vinculado à specialty.
   *   - Room (se passada) existe.
   *   - Capacity 1..100.
   *   - Duration 5..480.
   *   - sessionType ∈ {'individual','group'} (default 'group').
   *
   * NÃO valida conflito de agenda aqui — o refactor do findConflicts pra
   * respeitar sessão vs appointments individuais fica na Fatia 42. Nesta
   * fatia, quem valida conflito é o `addParticipant` no momento do INSERT
   * do appointment (a lógica antiga do createAppointment).
   */
  static create(
    orgId: string,
    input: {
      specialtyId: string;
      professionalId: string;
      roomId?: string | null;
      procedureId?: string | null;
      sessionType?: SessionType;
      title?: string | null;
      scheduledStart: string;
      durationMinutes: number;
      capacity: number;
    },
    actorId: string | null = null
  ): ScheduleSession {
    const spec = db.prepare(
      `SELECT id, active FROM clinic_specialties WHERE organization_id = ? AND id = ?`
    ).get(orgId, input.specialtyId) as any;
    if (!spec) throw new Error("Especialidade não encontrada.");
    if (Number(spec.active) === 0) throw new Error("Especialidade está desativada.");

    const prof = db.prepare(
      `SELECT id, active FROM clinic_professionals WHERE organization_id = ? AND id = ?`
    ).get(orgId, input.professionalId) as any;
    if (!prof) throw new Error("Profissional não encontrado.");
    if (Number(prof.active) === 0) throw new Error("Profissional está desativado.");
    assertProfessionalInSpecialty(orgId, input.professionalId, input.specialtyId);

    if (input.roomId) {
      const room = db.prepare(
        `SELECT id FROM clinic_rooms WHERE organization_id = ? AND id = ?`
      ).get(orgId, input.roomId) as any;
      if (!room) throw new Error("Sala não encontrada.");
    }

    const sessionType = (input.sessionType || "group") as SessionType;
    if (sessionType !== "individual" && sessionType !== "group") {
      throw new Error("sessionType inválido. Aceitos: individual, group.");
    }
    const duration = validDuration(input.durationMinutes);
    const capacity = validCapacity(input.capacity);

    const startMs = Date.parse(input.scheduledStart);
    if (!Number.isFinite(startMs)) throw new Error("scheduledStart inválido.");
    const startISO = new Date(startMs).toISOString();
    const endISO = new Date(startMs + duration * 60000).toISOString();

    const id = randomUUID();
    db.prepare(
      `INSERT INTO clinic_schedule_sessions
         (id, organization_id, specialty_id, professional_id, room_id, procedure_id,
          session_type, title, scheduled_start, scheduled_end, duration_minutes, capacity,
          status, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', ?)`
    ).run(
      id, orgId, input.specialtyId, input.professionalId, input.roomId || null, input.procedureId || null,
      sessionType, input.title || null, startISO, endISO, duration, capacity, actorId
    );

    logAuthEvent(orgId, actorId, null, "CLINIC_SCHEDULE_SESSION_CREATED", {
      sessionId: id, specialtyId: input.specialtyId, professionalId: input.professionalId,
      sessionType, capacity, durationMinutes: duration, scheduledStart: startISO,
    });

    return this.get(orgId, id)!;
  }

  // ── Adicionar participante (atômico, RN-006 + AC-012) ──────────────────

  /**
   * Adiciona participante a uma sessão. Cria appointment individual
   * ligado à session. TRANSACIONAL: SELECT COUNT DENTRO da tx antes do
   * INSERT — protege contra corrida onde 2 requests vêm ocupar a última
   * vaga ao mesmo tempo (AC-012).
   *
   * Validações:
   *   - Sessão existe, não cancelled/completed.
   *   - Contact existe.
   *   - careEpisodeId (se passado) pertence ao contact + está active|on_hold
   *     + specialty do episódio == specialty da sessão (RN-006 §3 —
   *     participante não pode ter especialidade divergente do grupo).
   *   - Contact ainda não está na sessão (dedup — sem duplicar linha).
   *   - Capacity não excedida (SELECT COUNT dentro da tx).
   *   - Cria appointment via ClinicAgendaService.createAppointment com o
   *     mesmo scheduled_start/duration da sessão, MESMO professional,
   *     schedule_session_id preenchido.
   */
  static addParticipant(
    orgId: string,
    sessionId: string,
    input: {
      contactId: string;
      careEpisodeId?: string | null;
      treatmentCycleId?: string | null;
      title?: string | null;
    },
    actorId: string | null = null
  ): { session: ScheduleSession; appointment: any } {
    const session = this.get(orgId, sessionId);
    if (!session) throw new Error("Sessão não encontrada.");
    if (session.status === "cancelled" || session.status === "completed") {
      const e: any = new Error(`Sessão está ${session.status} — não aceita novos participantes.`);
      e.code = "SESSION_NOT_ACCEPTING"; throw e;
    }

    const contact = db.prepare(
      `SELECT id FROM contacts WHERE organization_id = ? AND id = ?`
    ).get(orgId, input.contactId) as any;
    if (!contact) throw new Error("Paciente não encontrado.");

    // Se careEpisodeId veio, valida specialty igual à da sessão
    if (input.careEpisodeId) {
      const ep = db.prepare(
        `SELECT id, contact_id, specialty_id, status FROM clinic_care_episodes
          WHERE organization_id = ? AND id = ?`
      ).get(orgId, input.careEpisodeId) as any;
      if (!ep) throw new Error("Episódio de cuidado não encontrado.");
      if (ep.contact_id !== input.contactId) throw new Error("Episódio pertence a outro paciente.");
      if (ep.status !== "active" && ep.status !== "on_hold") {
        const e: any = new Error("Episódio não está ativo.");
        e.code = "EPISODE_NOT_ACTIVE"; throw e;
      }
      if (ep.specialty_id !== session.specialtyId) {
        const e: any = new Error("Especialidade do episódio difere da sessão.");
        e.code = "SESSION_SPECIALTY_MISMATCH"; throw e;
      }
    }

    let appointmentId: string | null = null;
    let capacityErr: any = null;
    let dupErr: any = null;

    const tx = db.transaction(() => {
      // Dedup: paciente já está no grupo?
      const already = db.prepare(
        `SELECT id FROM appointments
          WHERE organization_id = ? AND schedule_session_id = ?
            AND contact_id = ? AND status NOT IN ('cancelled')`
      ).get(orgId, sessionId, input.contactId) as any;
      if (already) {
        dupErr = new Error("Paciente já está nesta sessão.");
        dupErr.code = "PARTICIPANT_ALREADY_IN_SESSION";
        dupErr.appointmentId = already.id;
        return;
      }
      // Capacity: COUNT dentro da tx
      const cnt = db.prepare(
        `SELECT COUNT(*) AS c FROM appointments
          WHERE organization_id = ? AND schedule_session_id = ?
            AND status NOT IN ('cancelled')`
      ).get(orgId, sessionId) as any;
      const current = Number(cnt?.c) || 0;
      if (current >= session.capacity) {
        capacityErr = new Error(`Sessão está lotada (${current}/${session.capacity}).`);
        capacityErr.code = "SESSION_CAPACITY_REACHED";
        capacityErr.current = current;
        capacityErr.capacity = session.capacity;
        return;
      }
      // Cria o appointment via ClinicAgendaService — reusa toda a lógica
      // de validações + gate EPISODE_PROFESSIONAL_MISMATCH + snapshots.
      // Fatia 42: passa scheduleSessionId direto — findConflicts agora
      // ignora outros participantes da mesma sessão (RN-006). Sem force=true.
      const appt = ClinicAgendaService.createAppointment(orgId, {
        contactId: input.contactId,
        title: input.title || session.title || "Sessão em grupo",
        scheduledStart: session.scheduledStart,
        professionalId: session.professionalId,
        roomId: session.roomId || undefined,
        durationMinutes: session.durationMinutes,
        careEpisodeId: input.careEpisodeId || undefined,
        scheduleSessionId: sessionId,
      }, actorId ?? undefined);

      // treatment_cycle_id (se veio) precisa ser amarrado depois — o
      // createAppointment não conhece esse campo direto ainda. Fatia 38
      // liga via care_episode_id automaticamente, mas se o operador quer
      // um ciclo específico (ex.: renovado), o service registra explícito.
      if (input.treatmentCycleId) {
        db.prepare(
          `UPDATE appointments SET treatment_cycle_id = ? WHERE id = ? AND organization_id = ?`
        ).run(input.treatmentCycleId, appt.id, orgId);
      }
      appointmentId = appt.id;
    });
    tx();

    if (dupErr) throw dupErr;
    if (capacityErr) throw capacityErr;
    if (!appointmentId) throw new Error("Falha ao adicionar participante.");

    const appt = db.prepare(`SELECT * FROM appointments WHERE id = ?`).get(appointmentId);
    logAuthEvent(orgId, actorId, input.contactId, "CLINIC_GROUP_PARTICIPANT_ADDED", {
      sessionId, appointmentId, contactId: input.contactId,
      careEpisodeId: input.careEpisodeId || null,
    });

    return { session: this.get(orgId, sessionId)!, appointment: appt };
  }

  // ── Remover participante (não cancela sessão) ──────────────────────────

  /**
   * Remove um participante — cancela o APPOINTMENT dele, sessão continua
   * ativa. Reason opcional (default "removido da sessão em grupo").
   */
  static removeParticipant(
    orgId: string,
    sessionId: string,
    appointmentId: string,
    input: { reason?: string } = {},
    actorId: string | null = null
  ): { session: ScheduleSession; removedAppointmentId: string } {
    const session = this.get(orgId, sessionId);
    if (!session) throw new Error("Sessão não encontrada.");

    const appt = db.prepare(
      `SELECT id, contact_id, schedule_session_id, status FROM appointments
        WHERE organization_id = ? AND id = ?`
    ).get(orgId, appointmentId) as any;
    if (!appt) throw new Error("Appointment não encontrado.");
    if (appt.schedule_session_id !== sessionId) {
      throw new Error("Appointment não pertence a esta sessão.");
    }

    // Reusa ClinicAgendaService.cancel — mantém padrão (nunca DELETE,
    // audit CLINIC_APPOINTMENT_CANCELLED com by='staff').
    ClinicAgendaService.cancel(orgId, appointmentId, {
      reason: input.reason || "removido da sessão em grupo",
      cancelledBy: "staff",
    }, actorId ?? undefined);

    logAuthEvent(orgId, actorId, appt.contact_id, "CLINIC_GROUP_PARTICIPANT_REMOVED", {
      sessionId, appointmentId, contactId: appt.contact_id,
      reason: (input.reason || "").slice(0, 200),
    });

    return { session: this.get(orgId, sessionId)!, removedAppointmentId: appointmentId };
  }

  /**
   * Métrica de ocupação (ADR-145 D6 / Fatia 43 / RN-006). Conta OCUPAÇÕES
   * DE AGENDA — grupo de 5 pacientes = 1 ocupação, não 5. Serve pra:
   *   - Dashboard "ocupação real do profissional" (não inflado por grupos).
   *   - Base pra `ClinicMetricsService` calcular utilização vs. capacidade.
   *
   * Regra:
   *   - Cada `schedule_session_id` distinto no período = 1 ocupação.
   *   - Appointments SEM schedule_session_id (individuais legado) contam
   *     cada um como 1 ocupação.
   *   - Cancelled/no_show excluídos.
   *   - Retorna somatório de minutos + contador de blocos.
   */
  static occupationForProfessional(orgId: string, professionalId: string, opts: { from: string; to: string }): {
    groupSessions: number;
    individualAppointments: number;
    totalOccupations: number;
    totalMinutes: number;
    windowFromISO: string;
    windowToISO: string;
  } {
    const fromISO = String(opts.from);
    const toISO = String(opts.to);

    // Grupos: um bloco por schedule_session_id distinto no período
    const groups = db.prepare(
      `SELECT COUNT(DISTINCT s.id) AS c,
              COALESCE(SUM(s.duration_minutes), 0) AS min_sum
         FROM clinic_schedule_sessions s
        WHERE s.organization_id = ?
          AND s.professional_id = ?
          AND s.status NOT IN ('cancelled')
          AND s.scheduled_start >= ? AND s.scheduled_start <= ?`
    ).get(orgId, professionalId, fromISO, toISO) as any;

    // Individuais: appts sem schedule_session_id no período (legado)
    const individuals = db.prepare(
      `SELECT COUNT(*) AS c,
              COALESCE(SUM(expected_duration_minutes), 0) AS min_sum
         FROM appointments
        WHERE organization_id = ?
          AND professional_id = ?
          AND schedule_session_id IS NULL
          AND status NOT IN ('cancelled','no_show')
          AND scheduled_start >= ? AND scheduled_start <= ?`
    ).get(orgId, professionalId, fromISO, toISO) as any;

    const groupSessions = Number(groups?.c) || 0;
    const individualAppointments = Number(individuals?.c) || 0;
    const groupMin = Number(groups?.min_sum) || 0;
    const indMin = Number(individuals?.min_sum) || 0;

    return {
      groupSessions,
      individualAppointments,
      totalOccupations: groupSessions + individualAppointments,
      totalMinutes: groupMin + indMin,
      windowFromISO: fromISO,
      windowToISO: toISO,
    };
  }

  // ── Cancelar sessão inteira ────────────────────────────────────────────

  /**
   * Cancela a sessão E todos os appointments não-cancelled dos participantes.
   * Idempotente: 2× devolve o mesmo estado. Reason obrigatório (audit).
   */
  static cancelSession(
    orgId: string,
    sessionId: string,
    input: { reason: string },
    actorId: string | null = null
  ): { session: ScheduleSession; cancelledAppointments: number } {
    const session = this.get(orgId, sessionId);
    if (!session) throw new Error("Sessão não encontrada.");
    if (session.status === "cancelled") {
      return { session, cancelledAppointments: 0 };
    }
    const reason = String(input.reason || "").trim();
    if (!reason) throw new Error("Motivo do cancelamento é obrigatório.");

    let cancelledCount = 0;
    const participants = this.listParticipants(orgId, sessionId);

    const tx = db.transaction(() => {
      db.prepare(
        `UPDATE clinic_schedule_sessions
            SET status='cancelled', cancelled_at=CURRENT_TIMESTAMP,
                cancelled_reason=?, updated_at=CURRENT_TIMESTAMP
          WHERE id=? AND organization_id=?`
      ).run(reason, sessionId, orgId);
      for (const p of participants) {
        if (p.appointmentStatus !== "cancelled") {
          try {
            ClinicAgendaService.cancel(orgId, p.appointmentId, {
              reason: `Sessão cancelada: ${reason}`,
              cancelledBy: "staff",
            }, actorId ?? undefined);
            cancelledCount++;
          } catch (e) {
            console.error("[Clínica] cancelSession — falha ao cancelar appointment", p.appointmentId, e);
          }
        }
      }
    });
    tx();

    logAuthEvent(orgId, actorId, null, "CLINIC_SCHEDULE_SESSION_CANCELLED", {
      sessionId, reason, cancelledAppointments: cancelledCount,
      totalParticipants: participants.length,
    });

    return { session: this.get(orgId, sessionId)!, cancelledAppointments: cancelledCount };
  }

  // ── Availability (ADR-145 Fase 5 §F47) ─────────────────────────────────

  /**
   * Sugere horários livres pro profissional dentro de uma janela — usado pela
   * IA operacional pra propor 3 opções à recepção na renovação do ciclo.
   *
   * GUARDRAILS (RN-014 §Fase 5): IA NUNCA inventa dado clínico.
   *   - Só devolve horários que existem no calendário do próprio profissional.
   *   - Filtra conflito (findConflicts, ignora mesma sessão), ausência
   *     (ClinicProfessionalAbsenceService.overlaps) e capacidade de sala
   *     (checkRoomCapacity — só se roomId informado).
   *   - NÃO propõe outro profissional ("cabe amanhã com o Dr. X" quebra
   *     RN-003/professional-fixo do episódio).
   *   - NÃO inventa TUSS/carteirinha/autorização — esses viram outro fatia (F48).
   *
   * Determinístico: mesmos inputs → mesmos outputs (sem randomness). Passo
   * de busca é `stepMinutes` (default 30min — padrão de agenda clínica).
   * Alinha o slot ao passo dentro da janela pra evitar propor "10:07".
   *
   * Limite: janela máxima 14 dias (evita varredura desnecessária).
   */
  static availability(
    orgId: string,
    input: {
      professionalId: string;
      durationMinutes: number;
      from: string;
      to: string;
      roomId?: string | null;
      maxSuggestions?: number;
      stepMinutes?: number;
    }
  ): Array<{ startISO: string; endISO: string; durationMinutes: number }> {
    const professionalId = String(input?.professionalId || "").trim();
    if (!professionalId) throw new Error("professionalId é obrigatório.");
    const duration = Math.floor(Number(input?.durationMinutes) || 0);
    if (!Number.isFinite(duration) || duration < 5 || duration > 480) {
      throw new Error("durationMinutes deve estar entre 5 e 480.");
    }
    const fromMs = Date.parse(String(input?.from || ""));
    const toMs = Date.parse(String(input?.to || ""));
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) {
      throw new Error("Janela [from, to) inválida.");
    }
    const MAX_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
    if (toMs - fromMs > MAX_WINDOW_MS) {
      throw new Error("Janela de busca não pode exceder 14 dias.");
    }
    const maxSuggestions = Math.max(1, Math.min(10, Math.floor(Number(input?.maxSuggestions) || 3)));
    const stepMinutes = Math.max(5, Math.min(60, Math.floor(Number(input?.stepMinutes) || 30)));
    const stepMs = stepMinutes * 60000;
    const roomId = input?.roomId ? String(input.roomId).trim() || null : null;

    // Confirma que o profissional pertence à org (evita vazamento cross-tenant).
    const prof = db.prepare(
      `SELECT id FROM clinic_professionals WHERE organization_id = ? AND id = ? AND active = 1`
    ).get(orgId, professionalId) as any;
    if (!prof) throw new Error("Profissional não encontrado ou inativo.");

    if (roomId) {
      const room = db.prepare(
        `SELECT id FROM clinic_rooms WHERE organization_id = ? AND id = ?`
      ).get(orgId, roomId) as any;
      if (!room) throw new Error("Sala não encontrada.");
    }

    // Alinha o cursor ao próximo múltiplo de stepMinutes dentro da janela.
    // Padrão: se from=10:07 e step=30, começa em 10:30 (não 10:07).
    let cursorMs = Math.ceil(fromMs / stepMs) * stepMs;
    const suggestions: Array<{ startISO: string; endISO: string; durationMinutes: number }> = [];

    while (cursorMs + duration * 60000 <= toMs && suggestions.length < maxSuggestions) {
      const startMs = cursorMs;
      const endMs = startMs + duration * 60000;

      // 1) conflito de agenda (profissional/sala 1:1)
      const conflicts = ClinicAgendaService.findConflicts(orgId, {
        professionalId, roomId,
        startMs, endMs,
      });
      if (conflicts.length > 0) { cursorMs += stepMs; continue; }

      // 2) ausência (férias/atestado/etc.)
      const absence = ClinicProfessionalAbsenceService.overlaps(orgId, professionalId, startMs, endMs);
      if (absence) { cursorMs += stepMs; continue; }

      // 3) capacidade de sala (só se roomId informado e sala capacity>1;
      // pra sala 1:1 o findConflicts acima já bloqueou).
      if (roomId) {
        const overflow = ClinicAgendaService.checkRoomCapacity(orgId, roomId, startMs, endMs);
        if (overflow) { cursorMs += stepMs; continue; }
      }

      suggestions.push({
        startISO: new Date(startMs).toISOString(),
        endISO: new Date(endMs).toISOString(),
        durationMinutes: duration,
      });
      cursorMs += stepMs;
    }

    return suggestions;
  }
}

export default ClinicScheduleSessionService;
