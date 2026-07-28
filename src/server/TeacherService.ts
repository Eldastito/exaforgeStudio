import db from "./db.js";
import { randomUUID } from "node:crypto";
import { logAuthEvent } from "./auditLog.js";
import { BusinessSignalService } from "./BusinessSignalService.js";

/**
 * Módulo Escola (ADR-144, Fatia 2) — Agenda do professor.
 *
 * ADAPTA a Agenda Clínica (ADR-080): o professor é ENTIDADE PRÓPRIA (molde de
 * clinic_professionals, D2) — desacoplado de `users` (link opcional p/ portal
 * futuro). Diferente do aluno (menor, sem telefone), o professor RECEBE o
 * "resumo antes da aula" no WhatsApp, então tem telefone próprio + `notify_opt_in`
 * como PORTA (D6: nada é empurrado sem opt-in).
 *
 * A grade é RECORRENTE por turma (weekday + horário), resolvida para um dia sob
 * demanda (determinístico, sem Date.now no caminho). A "confirmação pós-aula"
 * registra se a aula aconteceu; quando NÃO aconteceu, publica um sinal no domínio
 * `education` que a coordenação já leva ao Pareto/briefing (ADR-132/136).
 */
export class TeacherService {
  /** Dia da semana (0=domingo..6=sábado) de uma data YYYY-MM-DD, determinístico. */
  static weekdayOf(date: string): number {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ""))) throw new Error("Data inválida (use YYYY-MM-DD).");
    return new Date(`${date}T12:00:00Z`).getUTCDay();
  }

  // ── Professor ──────────────────────────────────────────────────────────
  static createTeacher(orgId: string, input: {
    fullName: string; subject?: string; phone?: string; color?: string; userId?: string; notes?: string;
  }, actorId?: string): any {
    const name = String(input?.fullName || "").trim();
    if (!name) throw new Error("Nome do professor é obrigatório.");
    const id = randomUUID();
    db.prepare(`INSERT INTO teacher_profiles (id, organization_id, full_name, subject, phone, color, user_id, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, orgId, name, String(input?.subject || "").trim() || null, String(input?.phone || "").trim() || null,
        String(input?.color || "").trim() || null, input?.userId || null, String(input?.notes || "").trim() || null);
    logAuthEvent(orgId, actorId, id, "TEACHER_CREATED", { subject: input?.subject });
    return this.getTeacher(orgId, id);
  }

  static getTeacher(orgId: string, teacherId: string): any {
    const teacher = db.prepare("SELECT * FROM teacher_profiles WHERE id = ? AND organization_id = ?").get(teacherId, orgId) as any;
    if (!teacher) throw new Error("Professor não encontrado.");
    const schedule = db.prepare(`SELECT * FROM class_schedule_items WHERE organization_id = ? AND teacher_id = ? AND status = 'active'
      ORDER BY weekday ASC, time_label ASC, created_at ASC`).all(orgId, teacherId) as any[];
    return { teacher, schedule };
  }

  static listTeachers(orgId: string, opts: { q?: string; subject?: string } = {}): any[] {
    let sql = "SELECT * FROM teacher_profiles WHERE organization_id = ? AND status = 'active'";
    const params: any[] = [orgId];
    if (opts.q) { sql += " AND full_name LIKE ?"; params.push(`%${opts.q}%`); }
    if (opts.subject) { sql += " AND subject = ?"; params.push(opts.subject); }
    sql += " ORDER BY full_name ASC LIMIT 500";
    return db.prepare(sql).all(...params) as any[];
  }

  static updateTeacher(orgId: string, teacherId: string, input: {
    fullName?: string; subject?: string; phone?: string; color?: string; userId?: string; status?: string; notes?: string;
  }, actorId?: string): any {
    const existing = db.prepare("SELECT id FROM teacher_profiles WHERE id = ? AND organization_id = ?").get(teacherId, orgId);
    if (!existing) throw new Error("Professor não encontrado.");
    const fields: string[] = [], params: any[] = [];
    const set = (col: string, val: any) => { fields.push(`${col} = ?`); params.push(val); };
    if (input.fullName !== undefined) set("full_name", String(input.fullName || "").trim() || null);
    if (input.subject !== undefined) set("subject", String(input.subject || "").trim() || null);
    if (input.phone !== undefined) set("phone", String(input.phone || "").trim() || null);
    if (input.color !== undefined) set("color", String(input.color || "").trim() || null);
    if (input.userId !== undefined) set("user_id", input.userId || null);
    if (input.status !== undefined) set("status", input.status === "inactive" ? "inactive" : "active");
    if (input.notes !== undefined) set("notes", String(input.notes || "").trim() || null);
    if (fields.length) {
      params.push(teacherId, orgId);
      db.prepare(`UPDATE teacher_profiles SET ${fields.join(", ")}, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND organization_id = ?`).run(...params);
      logAuthEvent(orgId, actorId, teacherId, "TEACHER_UPDATED", { fields: fields.map(f => f.split(" ")[0]) });
    }
    return this.getTeacher(orgId, teacherId);
  }

  /**
   * Liga/desliga o recebimento do "resumo antes da aula" (opt-in, PORTA do D6).
   * Sem opt-in, o passe pula sem enviar e sem marcar dedupe.
   */
  static setNotifyOptIn(orgId: string, teacherId: string, optIn: boolean, actorId?: string): any {
    const existing = db.prepare("SELECT id FROM teacher_profiles WHERE id = ? AND organization_id = ?").get(teacherId, orgId);
    if (!existing) throw new Error("Professor não encontrado.");
    db.prepare("UPDATE teacher_profiles SET notify_opt_in = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND organization_id = ?")
      .run(optIn ? 1 : 0, teacherId, orgId);
    logAuthEvent(orgId, actorId, teacherId, optIn ? "TEACHER_NOTIFY_OPT_IN" : "TEACHER_NOTIFY_OPT_OUT", {});
    return this.getTeacher(orgId, teacherId);
  }

  // ── Grade por turma (recorrente) ───────────────────────────────────────
  static addScheduleItem(orgId: string, teacherId: string, input: {
    turma: string; weekday: number; timeLabel?: string; subject?: string;
  }, actorId?: string): any {
    const teacher = db.prepare("SELECT id, subject FROM teacher_profiles WHERE id = ? AND organization_id = ?").get(teacherId, orgId) as any;
    if (!teacher) throw new Error("Professor não encontrado.");
    const turma = String(input?.turma || "").trim();
    if (!turma) throw new Error("Turma é obrigatória.");
    const weekday = Number(input?.weekday);
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) throw new Error("Dia da semana inválido (0=domingo..6=sábado).");
    const id = randomUUID();
    db.prepare(`INSERT INTO class_schedule_items (id, organization_id, teacher_id, turma, weekday, time_label, subject) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(id, orgId, teacherId, turma, weekday, String(input?.timeLabel || "").trim() || null,
        String(input?.subject || "").trim() || teacher.subject || null);
    return { id };
  }

  static removeScheduleItem(orgId: string, scheduleItemId: string): { ok: boolean } {
    const r = db.prepare("UPDATE class_schedule_items SET status = 'inactive', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND organization_id = ?")
      .run(scheduleItemId, orgId);
    return { ok: r.changes > 0 };
  }

  /** Aulas do professor num dia (resolve a grade recorrente pelo weekday da data). */
  static scheduleForDay(orgId: string, teacherId: string, date: string): any[] {
    const weekday = this.weekdayOf(date);
    return db.prepare(`SELECT * FROM class_schedule_items WHERE organization_id = ? AND teacher_id = ? AND weekday = ? AND status = 'active'
      ORDER BY time_label ASC, created_at ASC`).all(orgId, teacherId, weekday) as any[];
  }

  /** Aulas de uma TURMA num dia (grade por turma — base p/ visão da coordenação). */
  static turmaScheduleForDay(orgId: string, turma: string, date: string): any[] {
    const weekday = this.weekdayOf(date);
    return db.prepare(`
      SELECT cs.*, t.full_name AS teacher_name
      FROM class_schedule_items cs
      JOIN teacher_profiles t ON t.id = cs.teacher_id AND t.organization_id = cs.organization_id
      WHERE cs.organization_id = ? AND cs.turma = ? AND cs.weekday = ? AND cs.status = 'active'
      ORDER BY cs.time_label ASC, cs.created_at ASC`).all(orgId, turma, weekday) as any[];
  }

  // ── Confirmação pós-aula ───────────────────────────────────────────────
  /**
   * Registra a confirmação pós-aula de uma ocorrência (item da grade + data).
   * `held` = a aula aconteceu; `not_held` = não aconteceu (falta de professor,
   * cancelamento…) → publica sinal `class_not_held` no domínio `education` para a
   * coordenação. Idempotente por (item, data): reconfirmar sobrescreve o status,
   * e quando volta a `held` o sinal é resolvido.
   */
  static confirmClass(orgId: string, input: {
    scheduleItemId: string; date: string; status: string; note?: string;
  }, actorId?: string): { id: string; status: string; signalId?: string; deduped?: boolean } {
    const item = db.prepare(`SELECT cs.*, t.full_name AS teacher_name FROM class_schedule_items cs
      JOIN teacher_profiles t ON t.id = cs.teacher_id AND t.organization_id = cs.organization_id
      WHERE cs.id = ? AND cs.organization_id = ?`).get(input?.scheduleItemId, orgId) as any;
    if (!item) throw new Error("Aula (item de grade) não encontrada.");
    const date = String(input?.date || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("Data inválida (use YYYY-MM-DD).");
    const status = input?.status === "not_held" ? "not_held" : input?.status === "held" ? "held" : "";
    if (!status) throw new Error("Status deve ser 'held' ou 'not_held'.");

    const existing = db.prepare("SELECT id FROM class_confirmations WHERE organization_id = ? AND schedule_item_id = ? AND date = ?")
      .get(orgId, input.scheduleItemId, date) as any;
    let id: string;
    if (existing) {
      id = existing.id;
      db.prepare("UPDATE class_confirmations SET status = ?, note = ?, confirmed_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
        .run(status, String(input?.note || "").trim() || null, actorId || null, id);
    } else {
      id = randomUUID();
      db.prepare(`INSERT INTO class_confirmations (id, organization_id, schedule_item_id, date, status, note, confirmed_by) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(id, orgId, input.scheduleItemId, date, status, String(input?.note || "").trim() || null, actorId || null);
    }
    logAuthEvent(orgId, actorId, input.scheduleItemId, "CLASS_CONFIRMATION_RECORDED", { date, status });

    const dedupeKey = `education:class_not_held:${input.scheduleItemId}:${date}`;
    if (status === "not_held") {
      const res = BusinessSignalService.publish(orgId, {
        domain: "education",
        signalType: "class_not_held",
        severity: "attention",
        basis: "fact",
        confidence: 1,
        sourceService: "TeacherService",
        sourceEntityType: "class_schedule_item",
        sourceEntityId: input.scheduleItemId,
        evidence: { turma: item.turma, subject: item.subject, teacher: item.teacher_name, date, note: input?.note || null },
        dedupeKey,
      });
      return { id, status, signalId: res.id, deduped: res.deduped };
    }
    // Voltou a acontecer → resolve o sinal (IA sugere, humano decide: o registro corrige).
    BusinessSignalService.resolveByDedupe(orgId, dedupeKey);
    return { id, status };
  }

  static confirmationsForDay(orgId: string, date: string): any[] {
    return db.prepare(`SELECT * FROM class_confirmations WHERE organization_id = ? AND date = ? ORDER BY created_at ASC`).all(orgId, date) as any[];
  }
}

export default TeacherService;
