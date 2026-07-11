import db from "./db.js";
import { randomUUID } from "node:crypto";
import { logAuthEvent } from "./auditLog.js";
import { AppointmentService } from "./AppointmentService.js";

/**
 * Módulo Clínica — Agenda Clínica (ADR-080, Fase C).
 *
 * Camada clínica SOBRE `appointments`, sem tocar no motor de disponibilidade
 * (AppointmentService, usado pela IA). Traz o que o PRD pede e a agenda base
 * não tinha:
 *  - profissionais como entidade própria (D2) + salas;
 *  - duração POR consulta, sem teto de 150 min;
 *  - check-in → início → saída, com status de permanência;
 *  - conflito por PROFISSIONAL e por SALA (a base só via capacidade agregada);
 *  - NUNCA excluir por tempo excedido (D3): excedeu → status, não delete.
 *
 * O alerta visual de permanência é derivado dos timestamps (overrunState),
 * para o cliente recalcular ao vivo sem job no Scheduler (D3).
 */
const CONTINUATION = ["pending", "continue", "finish", "reschedule"];

export class ClinicAgendaService {
  // ── Profissionais ────────────────────────────────────────────────────────
  static listProfessionals(orgId: string, includeInactive = false): any[] {
    return db.prepare(`SELECT * FROM clinic_professionals WHERE organization_id = ?${includeInactive ? "" : " AND active = 1"} ORDER BY name`).all(orgId) as any[];
  }

  static createProfessional(orgId: string, input: { name?: string; specialty?: string; color?: string; userId?: string }, actorId?: string): any {
    const name = String(input?.name || "").trim();
    if (!name) throw new Error("Dê um nome ao profissional.");
    if (input?.userId) {
      const u = db.prepare("SELECT id FROM users WHERE id = ? AND organization_id = ?").get(input.userId, orgId);
      if (!u) throw new Error("Usuário para vincular não encontrado nesta organização.");
    }
    const id = randomUUID();
    db.prepare(`INSERT INTO clinic_professionals (id, organization_id, name, specialty, color, user_id) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(id, orgId, name, String(input?.specialty || "").trim() || null, String(input?.color || "").trim() || null, input?.userId || null);
    logAuthEvent(orgId, actorId, null, "CLINIC_PROFESSIONAL_CREATED", { professionalId: id, name });
    return db.prepare("SELECT * FROM clinic_professionals WHERE id = ?").get(id);
  }

  static updateProfessional(orgId: string, id: string, patch: any, actorId?: string): any {
    const cur = db.prepare("SELECT id FROM clinic_professionals WHERE id = ? AND organization_id = ?").get(id, orgId);
    if (!cur) throw new Error("Profissional não encontrado.");
    const fields: string[] = [], params: any[] = [];
    if (patch.name !== undefined) { const n = String(patch.name).trim(); if (n) { fields.push("name = ?"); params.push(n); } }
    if (patch.specialty !== undefined) { fields.push("specialty = ?"); params.push(String(patch.specialty || "").trim() || null); }
    if (patch.color !== undefined) { fields.push("color = ?"); params.push(String(patch.color || "").trim() || null); }
    if (patch.active !== undefined) { fields.push("active = ?"); params.push(patch.active ? 1 : 0); }
    if (!fields.length) return db.prepare("SELECT * FROM clinic_professionals WHERE id = ?").get(id);
    params.push(id, orgId);
    db.prepare(`UPDATE clinic_professionals SET ${fields.join(", ")}, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND organization_id = ?`).run(...params);
    logAuthEvent(orgId, actorId, null, "CLINIC_PROFESSIONAL_UPDATED", { professionalId: id });
    return db.prepare("SELECT * FROM clinic_professionals WHERE id = ?").get(id);
  }

  // ── Salas ────────────────────────────────────────────────────────────────
  static listRooms(orgId: string): any[] {
    return db.prepare("SELECT * FROM clinic_rooms WHERE organization_id = ? AND active = 1 ORDER BY name").all(orgId) as any[];
  }
  static createRoom(orgId: string, name: string, actorId?: string): any {
    const n = String(name || "").trim();
    if (!n) throw new Error("Dê um nome à sala.");
    const id = randomUUID();
    db.prepare("INSERT INTO clinic_rooms (id, organization_id, name) VALUES (?, ?, ?)").run(id, orgId, n);
    logAuthEvent(orgId, actorId, null, "CLINIC_ROOM_CREATED", { roomId: id, name: n });
    return db.prepare("SELECT * FROM clinic_rooms WHERE id = ?").get(id);
  }

  // ── Duração e permanência (derivados dos timestamps) ─────────────────────
  /** Minutos previstos: da consulta, senão do slot global da org. */
  static durationMin(orgId: string, appt: any): number {
    const d = parseInt(String(appt.expected_duration_minutes), 10);
    if (Number.isFinite(d) && d > 0) return d;
    return AppointmentService.config(orgId).slotMin;
  }

  /**
   * Fim EFETIVO previsto: se o atendimento começou (care_started_at), conta a
   * duração a partir daí; senão a partir do horário agendado. Base do alerta.
   */
  static effectiveEndMs(orgId: string, appt: any): number | null {
    const base = AppointmentService.ms(appt.care_started_at) ?? AppointmentService.ms(appt.scheduled_start);
    if (base == null) return null;
    return base + this.durationMin(orgId, appt) * 60000;
  }

  /**
   * Estado de permanência (para a UI recalcular ao vivo — D3, sem job):
   *  - 'done' se já saiu; 'on_time' com folga; 'near_end' dentro do aviso;
   *  - 'over_time' se passou do fim previsto e ainda está em atendimento.
   */
  static overrunState(orgId: string, appt: any, nowMs: number, warningMin: number): "done" | "on_time" | "near_end" | "over_time" | "idle" {
    if (appt.checkout_at || appt.status === "completed") return "done";
    if (!appt.care_started_at && appt.status !== "in_care") return "idle";
    const end = this.effectiveEndMs(orgId, appt);
    if (end == null) return "idle";
    if (nowMs >= end) return "over_time";
    if (nowMs >= end - warningMin * 60000) return "near_end";
    return "on_time";
  }

  private static warningMin(orgId: string): number {
    const r = db.prepare("SELECT clinic_overrun_warning_minutes FROM organization_settings WHERE organization_id = ?").get(orgId) as any;
    const v = parseInt(String(r?.clinic_overrun_warning_minutes), 10);
    return Number.isFinite(v) && v > 0 ? v : 15;
  }

  /** Hidrata um agendamento com duração, fim efetivo e estado de permanência. */
  static hydrate(orgId: string, appt: any, nowMs = Date.now()): any {
    const w = this.warningMin(orgId);
    const endMs = this.effectiveEndMs(orgId, appt);
    return {
      ...appt,
      duration_minutes: this.durationMin(orgId, appt),
      effective_end: endMs ? new Date(endMs).toISOString() : null,
      overrun_state: this.overrunState(orgId, appt, nowMs, w),
      warning_minutes: w,
    };
  }

  // ── Conflito por profissional / sala ─────────────────────────────────────
  /** Agendamentos ativos do profissional OU da sala que colidem com a janela. */
  static findConflicts(orgId: string, opts: { professionalId?: string | null; roomId?: string | null; startMs: number; endMs: number; ignoreId?: string }): any[] {
    const rows = db.prepare(`
      SELECT id, title, professional_id, room_id, scheduled_start, scheduled_end, expected_duration_minutes
      FROM appointments
      WHERE organization_id = ? AND status NOT IN ('cancelled','no_show','completed')
        AND (professional_id = ? OR room_id = ?)${opts.ignoreId ? " AND id != ?" : ""}
    `).all(...(opts.ignoreId ? [orgId, opts.professionalId || "\0", opts.roomId || "\0", opts.ignoreId] : [orgId, opts.professionalId || "\0", opts.roomId || "\0"])) as any[];
    const out: any[] = [];
    for (const r of rows) {
      const st = AppointmentService.ms(r.scheduled_start);
      if (st == null) continue;
      const en = AppointmentService.ms(r.scheduled_end) ?? (st + this.durationMin(orgId, r) * 60000);
      if (en > opts.startMs && st < opts.endMs) {
        out.push({ id: r.id, title: r.title, reason: r.professional_id === opts.professionalId ? "professional" : "room", start: r.scheduled_start });
      }
    }
    return out;
  }

  // ── Agenda do dia / por profissional ─────────────────────────────────────
  static agendaForDay(orgId: string, dateISO?: string, opts: { professionalId?: string; roomId?: string; status?: string } = {}, nowMs = Date.now()): any {
    // dateISO 'YYYY-MM-DD' no fuso do negócio; sem data → hoje. Filtra por prefixo.
    const day = (dateISO && /^\d{4}-\d{2}-\d{2}$/.test(dateISO)) ? dateISO : new Date(nowMs).toISOString().slice(0, 10);
    let sql = `
      SELECT a.*, c.name AS contact_name, c.identifier AS contact_identifier,
             p.name AS professional_name, p.color AS professional_color,
             pp.insurance_name, pp.current_plan_name
      FROM appointments a
      LEFT JOIN contacts c ON c.id = a.contact_id AND c.organization_id = a.organization_id
      LEFT JOIN clinic_professionals p ON p.id = a.professional_id AND p.organization_id = a.organization_id
      LEFT JOIN patient_profiles pp ON pp.contact_id = a.contact_id AND pp.organization_id = a.organization_id
      WHERE a.organization_id = ? AND substr(a.scheduled_start, 1, 10) = ?`;
    const params: any[] = [orgId, day];
    if (opts.professionalId) { sql += " AND a.professional_id = ?"; params.push(opts.professionalId); }
    if (opts.roomId) { sql += " AND a.room_id = ?"; params.push(opts.roomId); }
    if (opts.status) { sql += " AND a.status = ?"; params.push(opts.status); }
    sql += " ORDER BY a.scheduled_start ASC";
    const rows = db.prepare(sql).all(...params) as any[];
    return { date: day, appointments: rows.map(r => this.hydrate(orgId, r, nowMs)) };
  }

  // ── Ciclo de vida da consulta (nunca exclui) ─────────────────────────────
  /** Cria consulta clínica com profissional/sala/duração, checando conflito. */
  static createAppointment(orgId: string, input: {
    contactId?: string; title?: string; scheduledStart?: string; professionalId?: string; roomId?: string; durationMinutes?: number; force?: boolean;
  }, actorId?: string): any {
    const contactId = String(input?.contactId || "");
    if (!contactId) throw new Error("Selecione o paciente.");
    const start = String(input?.scheduledStart || "").trim();
    const startMs = AppointmentService.ms(start);
    if (startMs == null) throw new Error("Informe uma data/hora válida.");
    const contact = db.prepare("SELECT name FROM contacts WHERE id = ? AND organization_id = ?").get(contactId, orgId) as any;
    if (!contact) throw new Error("Paciente não encontrado.");

    let professional: any = null;
    if (input?.professionalId) {
      professional = db.prepare("SELECT id, name FROM clinic_professionals WHERE id = ? AND organization_id = ?").get(input.professionalId, orgId);
      if (!professional) throw new Error("Profissional não encontrado.");
    }
    let room: any = null;
    if (input?.roomId) {
      room = db.prepare("SELECT id, name FROM clinic_rooms WHERE id = ? AND organization_id = ?").get(input.roomId, orgId);
      if (!room) throw new Error("Sala não encontrada.");
    }
    // Duração por consulta: >= 5 min, SEM teto de 150 (dor da clínica). 0/vazio = usa slot da org.
    const dur = parseInt(String(input?.durationMinutes), 10);
    const durationMinutes = Number.isFinite(dur) && dur > 0 ? Math.max(5, dur) : null;
    const endMs = startMs + (durationMinutes ?? AppointmentService.config(orgId).slotMin) * 60000;

    // Conflito por profissional/sala — não bloqueia sem profissional nem sala.
    if (professional || room) {
      const conflicts = this.findConflicts(orgId, { professionalId: professional?.id, roomId: room?.id, startMs, endMs });
      if (conflicts.length && !input?.force) {
        const e: any = new Error(`Conflito de horário: ${conflicts.map(c => c.title || "agendamento").join(", ")}. Envie force=true para manter mesmo assim.`);
        e.conflicts = conflicts; e.code = "CONFLICT";
        throw e;
      }
    }

    const id = randomUUID();
    const endISO = new Date(endMs).toISOString();
    db.prepare(`INSERT INTO appointments (id, organization_id, contact_id, title, scheduled_start, scheduled_end, status, professional_id, professional_name_snapshot, room_id, room_name_snapshot, expected_duration_minutes) VALUES (?, ?, ?, ?, ?, ?, 'confirmed', ?, ?, ?, ?, ?)`)
      .run(id, orgId, contactId, String(input?.title || "Consulta").trim() || "Consulta", start, endISO, professional?.id || null, professional?.name || null, room?.id || null, room?.name || null, durationMinutes);
    logAuthEvent(orgId, actorId, contactId, "CLINIC_APPOINTMENT_CREATED", { appointmentId: id, professionalId: professional?.id || null, roomId: room?.id || null, durationMinutes });
    return this.hydrate(orgId, db.prepare("SELECT * FROM appointments WHERE id = ?").get(id));
  }

  private static get(orgId: string, id: string): any {
    const a = db.prepare("SELECT * FROM appointments WHERE id = ? AND organization_id = ?").get(id, orgId) as any;
    if (!a) throw new Error("Agendamento não encontrado.");
    return a;
  }

  static checkIn(orgId: string, id: string, actorId?: string): any {
    const a = this.get(orgId, id);
    if (a.checkin_at) throw new Error("Paciente já fez check-in.");
    db.prepare("UPDATE appointments SET checkin_at = CURRENT_TIMESTAMP, status = 'arrived' WHERE id = ? AND organization_id = ?").run(id, orgId);
    logAuthEvent(orgId, actorId, a.contact_id, "CLINIC_CHECKIN", { appointmentId: id });
    return this.hydrate(orgId, this.get(orgId, id));
  }

  static startCare(orgId: string, id: string, actorId?: string): any {
    const a = this.get(orgId, id);
    if (a.care_started_at) throw new Error("Atendimento já iniciado.");
    db.prepare("UPDATE appointments SET care_started_at = CURRENT_TIMESTAMP, status = 'in_care', continuation_status = 'pending' WHERE id = ? AND organization_id = ?").run(id, orgId);
    logAuthEvent(orgId, actorId, a.contact_id, "CLINIC_CARE_STARTED", { appointmentId: id });
    return this.hydrate(orgId, this.get(orgId, id));
  }

  /** Estende a duração (nunca recria o agendamento). Recalcula scheduled_end e checa conflito. */
  static extend(orgId: string, id: string, addMinutes: number, force = false, actorId?: string): any {
    const a = this.get(orgId, id);
    const add = parseInt(String(addMinutes), 10);
    if (!Number.isFinite(add) || add <= 0) throw new Error("Informe os minutos a adicionar.");
    const newDuration = this.durationMin(orgId, a) + add;
    const base = AppointmentService.ms(a.care_started_at) ?? AppointmentService.ms(a.scheduled_start)!;
    const newEndMs = base + newDuration * 60000;
    if (a.professional_id || a.room_id) {
      const startMs = AppointmentService.ms(a.scheduled_start)!;
      const conflicts = this.findConflicts(orgId, { professionalId: a.professional_id, roomId: a.room_id, startMs, endMs: newEndMs, ignoreId: id });
      if (conflicts.length && !force) {
        const e: any = new Error(`Estender até ${AppointmentService.label(newEndMs)} conflita com: ${conflicts.map(c => c.title || "agendamento").join(", ")}. Envie force=true para manter.`);
        e.conflicts = conflicts; e.code = "CONFLICT";
        throw e;
      }
    }
    db.prepare("UPDATE appointments SET expected_duration_minutes = ?, scheduled_end = ?, continuation_status = 'continue' WHERE id = ? AND organization_id = ?")
      .run(newDuration, new Date(newEndMs).toISOString(), id, orgId);
    logAuthEvent(orgId, actorId, a.contact_id, "CLINIC_APPOINTMENT_EXTENDED", { appointmentId: id, addMinutes: add, newDuration });
    return this.hydrate(orgId, this.get(orgId, id));
  }

  /** Marca a decisão "paciente continuará?" (continue | finish | reschedule). Nunca exclui. */
  static setContinuation(orgId: string, id: string, status: string, actorId?: string): any {
    if (!CONTINUATION.includes(status)) throw new Error("Status de continuidade inválido.");
    const a = this.get(orgId, id);
    db.prepare("UPDATE appointments SET continuation_status = ? WHERE id = ? AND organization_id = ?").run(status, id, orgId);
    logAuthEvent(orgId, actorId, a.contact_id, "CLINIC_CONTINUATION_SET", { appointmentId: id, continuation: status });
    return this.hydrate(orgId, this.get(orgId, id));
  }

  static complete(orgId: string, id: string, actorId?: string): any {
    const a = this.get(orgId, id);
    db.prepare("UPDATE appointments SET checkout_at = CURRENT_TIMESTAMP, status = 'completed', continuation_status = 'finish' WHERE id = ? AND organization_id = ?").run(id, orgId);
    logAuthEvent(orgId, actorId, a.contact_id, "CLINIC_APPOINTMENT_COMPLETED", { appointmentId: id });
    return this.hydrate(orgId, this.get(orgId, id));
  }
}
