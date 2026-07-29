import db from "./db.js";
import { randomUUID } from "node:crypto";
import { logAuthEvent } from "./auditLog.js";

/**
 * Módulo Escola (ADR-144, Fatia 3) — Extracurriculares.
 *
 * ADAPTA o padrão do ReservationService (capacidade/vagas + matrícula ATÔMICA
 * anti-overbooking + lista de espera), mas em tabelas próprias da escola: o aluno
 * é entidade própria (não um contato/período de hotel), e a atividade é uma turma
 * recorrente com `capacity` vagas (D8).
 *
 * - `enroll`: enquanto houver vaga → `enrolled`; senão → `waitlisted` com `position`.
 *   Idempotente por (atividade, aluno); atômico (transação) para não estourar vaga.
 * - `cancelEnrollment`: libera a vaga e PROMOVE o 1º da lista de espera.
 * - `recordAttendance`: presença por sessão (data), idempotente.
 *
 * O "aviso ao responsável" fica no ExtracurricularNoticeService (envio injetado,
 * gated pela porta de consentimento da Fatia 1).
 */
export class ExtracurricularService {
  // ── Atividade ──────────────────────────────────────────────────────────
  static createActivity(orgId: string, input: {
    name: string; description?: string; capacity?: number; dayLabel?: string; timeLabel?: string; location?: string; teacherId?: string;
  }, actorId?: string): any {
    const name = String(input?.name || "").trim();
    if (!name) throw new Error("Nome da atividade é obrigatório.");
    const cap = Number(input?.capacity);
    const capacity = Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : 1;
    const id = randomUUID();
    db.prepare(`INSERT INTO extracurricular_activities (id, organization_id, name, description, capacity, day_label, time_label, location, teacher_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, orgId, name, String(input?.description || "").trim() || null, capacity,
        String(input?.dayLabel || "").trim() || null, String(input?.timeLabel || "").trim() || null,
        String(input?.location || "").trim() || null, input?.teacherId || null);
    logAuthEvent(orgId, actorId, id, "EXTRACURRICULAR_CREATED", { capacity });
    return this.getActivity(orgId, id);
  }

  static getActivity(orgId: string, activityId: string): any {
    const activity = db.prepare("SELECT * FROM extracurricular_activities WHERE id = ? AND organization_id = ?").get(activityId, orgId) as any;
    if (!activity) throw new Error("Atividade não encontrada.");
    const counts = db.prepare(`SELECT status, COUNT(*) AS n FROM extracurricular_enrollments WHERE organization_id = ? AND activity_id = ? GROUP BY status`).all(orgId, activityId) as any[];
    const by = (s: string) => Number(counts.find((c: any) => c.status === s)?.n || 0);
    const enrolled = by("enrolled");
    return { activity, enrolled, waitlisted: by("waitlisted"), seatsLeft: Math.max(0, Number(activity.capacity) - enrolled) };
  }

  static listActivities(orgId: string, opts: { q?: string } = {}): any[] {
    let sql = `SELECT a.*,
        (SELECT COUNT(*) FROM extracurricular_enrollments e WHERE e.organization_id = a.organization_id AND e.activity_id = a.id AND e.status = 'enrolled') AS enrolled,
        (SELECT COUNT(*) FROM extracurricular_enrollments e WHERE e.organization_id = a.organization_id AND e.activity_id = a.id AND e.status = 'waitlisted') AS waitlisted
      FROM extracurricular_activities a WHERE a.organization_id = ? AND a.status = 'active'`;
    const params: any[] = [orgId];
    if (opts.q) { sql += " AND a.name LIKE ?"; params.push(`%${opts.q}%`); }
    sql += " ORDER BY a.name ASC LIMIT 500";
    return db.prepare(sql).all(...params) as any[];
  }

  static updateActivity(orgId: string, activityId: string, input: {
    name?: string; description?: string; capacity?: number; dayLabel?: string; timeLabel?: string; location?: string; teacherId?: string; status?: string;
  }, actorId?: string): any {
    const existing = db.prepare("SELECT id FROM extracurricular_activities WHERE id = ? AND organization_id = ?").get(activityId, orgId);
    if (!existing) throw new Error("Atividade não encontrada.");
    const fields: string[] = [], params: any[] = [];
    const set = (col: string, val: any) => { fields.push(`${col} = ?`); params.push(val); };
    if (input.name !== undefined) set("name", String(input.name || "").trim() || null);
    if (input.description !== undefined) set("description", String(input.description || "").trim() || null);
    if (input.capacity !== undefined) { const c = Number(input.capacity); set("capacity", Number.isFinite(c) && c > 0 ? Math.floor(c) : 1); }
    if (input.dayLabel !== undefined) set("day_label", String(input.dayLabel || "").trim() || null);
    if (input.timeLabel !== undefined) set("time_label", String(input.timeLabel || "").trim() || null);
    if (input.location !== undefined) set("location", String(input.location || "").trim() || null);
    if (input.teacherId !== undefined) set("teacher_id", input.teacherId || null);
    if (input.status !== undefined) set("status", input.status === "inactive" ? "inactive" : "active");
    if (fields.length) {
      params.push(activityId, orgId);
      db.prepare(`UPDATE extracurricular_activities SET ${fields.join(", ")}, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND organization_id = ?`).run(...params);
      logAuthEvent(orgId, actorId, activityId, "EXTRACURRICULAR_UPDATED", { fields: fields.map(f => f.split(" ")[0]) });
    }
    return this.getActivity(orgId, activityId);
  }

  // ── Matrícula (vagas + lista de espera), atômica ───────────────────────
  /**
   * Matricula um aluno. Enquanto houver vaga (`enrolled < capacity`) entra como
   * `enrolled`; senão entra na lista de espera (`waitlisted`) com a próxima
   * `position`. Idempotente por (atividade, aluno). Atômico p/ não estourar vaga.
   */
  static enroll(orgId: string, activityId: string, studentId: string, actorId?: string): { id: string; status: string; position: number | null; deduped: boolean } {
    const tx = db.transaction(() => {
      const activity = db.prepare("SELECT id, capacity FROM extracurricular_activities WHERE id = ? AND organization_id = ? AND status = 'active'").get(activityId, orgId) as any;
      if (!activity) throw new Error("Atividade não encontrada.");
      const student = db.prepare("SELECT id FROM student_profiles WHERE id = ? AND organization_id = ? AND status = 'active'").get(studentId, orgId) as any;
      if (!student) throw new Error("Aluno não encontrado.");

      const existing = db.prepare("SELECT id, status, position FROM extracurricular_enrollments WHERE organization_id = ? AND activity_id = ? AND student_id = ?").get(orgId, activityId, studentId) as any;
      if (existing && existing.status !== "cancelled") {
        return { id: existing.id, status: existing.status, position: existing.position ?? null, deduped: true };
      }

      const enrolledCount = Number((db.prepare("SELECT COUNT(*) AS n FROM extracurricular_enrollments WHERE organization_id = ? AND activity_id = ? AND status = 'enrolled'").get(orgId, activityId) as any).n);
      let status = "enrolled", position: number | null = null;
      if (enrolledCount >= Number(activity.capacity)) {
        status = "waitlisted";
        const maxPos = Number((db.prepare("SELECT COALESCE(MAX(position),0) AS m FROM extracurricular_enrollments WHERE organization_id = ? AND activity_id = ? AND status = 'waitlisted'").get(orgId, activityId) as any).m);
        position = maxPos + 1;
      }

      let id: string;
      if (existing) { // reativa uma matrícula cancelada
        id = existing.id;
        db.prepare("UPDATE extracurricular_enrollments SET status = ?, position = ?, enrolled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(status, position, id);
      } else {
        id = randomUUID();
        db.prepare("INSERT INTO extracurricular_enrollments (id, organization_id, activity_id, student_id, status, position) VALUES (?, ?, ?, ?, ?, ?)").run(id, orgId, activityId, studentId, status, position);
      }
      return { id, status, position, deduped: false };
    });
    const res = tx();
    if (!res.deduped) logAuthEvent(orgId, actorId, studentId, "EXTRACURRICULAR_ENROLLED", { activityId, status: res.status, position: res.position });
    return res;
  }

  /**
   * Cancela a matrícula de um aluno. Se ele estava `enrolled`, a vaga liberada
   * PROMOVE o 1º da lista de espera (menor `position`) para `enrolled`. Atômico.
   * Retorna o aluno promovido (se houve), para o aviso ao responsável.
   */
  static cancelEnrollment(orgId: string, activityId: string, studentId: string, actorId?: string): { cancelled: boolean; promotedStudentId: string | null } {
    const tx = db.transaction(() => {
      const existing = db.prepare("SELECT id, status FROM extracurricular_enrollments WHERE organization_id = ? AND activity_id = ? AND student_id = ?").get(orgId, activityId, studentId) as any;
      if (!existing || existing.status === "cancelled") throw new Error("Matrícula não encontrada.");
      const wasEnrolled = existing.status === "enrolled";
      db.prepare("UPDATE extracurricular_enrollments SET status = 'cancelled', position = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(existing.id);

      let promotedStudentId: string | null = null;
      if (wasEnrolled) {
        const next = db.prepare("SELECT id, student_id FROM extracurricular_enrollments WHERE organization_id = ? AND activity_id = ? AND status = 'waitlisted' ORDER BY position ASC, enrolled_at ASC LIMIT 1").get(orgId, activityId) as any;
        if (next) {
          db.prepare("UPDATE extracurricular_enrollments SET status = 'enrolled', position = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(next.id);
          promotedStudentId = next.student_id;
        }
      }
      return { cancelled: true, promotedStudentId };
    });
    const res = tx();
    logAuthEvent(orgId, actorId, studentId, "EXTRACURRICULAR_CANCELLED", { activityId, promoted: res.promotedStudentId });
    return res;
  }

  /** Turma da atividade: matriculados + lista de espera (ordenada), com nome do aluno. */
  static roster(orgId: string, activityId: string): { enrolled: any[]; waitlist: any[] } {
    const rows = db.prepare(`
      SELECT e.*, s.full_name AS student_name, s.turma AS student_turma
      FROM extracurricular_enrollments e
      JOIN student_profiles s ON s.id = e.student_id AND s.organization_id = e.organization_id
      WHERE e.organization_id = ? AND e.activity_id = ? AND e.status IN ('enrolled','waitlisted')
      ORDER BY CASE e.status WHEN 'enrolled' THEN 0 ELSE 1 END, e.position ASC, e.enrolled_at ASC`).all(orgId, activityId) as any[];
    return {
      enrolled: rows.filter((r: any) => r.status === "enrolled"),
      waitlist: rows.filter((r: any) => r.status === "waitlisted"),
    };
  }

  // ── Presença por sessão ────────────────────────────────────────────────
  /** Registra presença/falta de um aluno matriculado numa sessão. Idempotente por (atividade, aluno, data). */
  static recordAttendance(orgId: string, input: {
    activityId: string; studentId: string; date: string; status: string; note?: string;
  }, actorId?: string): { id: string; status: string } {
    const activity = db.prepare("SELECT id FROM extracurricular_activities WHERE id = ? AND organization_id = ?").get(input?.activityId, orgId);
    if (!activity) throw new Error("Atividade não encontrada.");
    const date = String(input?.date || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("Data inválida (use YYYY-MM-DD).");
    const status = input?.status === "absent" ? "absent" : input?.status === "present" ? "present" : "";
    if (!status) throw new Error("Status deve ser 'present' ou 'absent'.");
    const enrollment = db.prepare("SELECT id FROM extracurricular_enrollments WHERE organization_id = ? AND activity_id = ? AND student_id = ? AND status = 'enrolled'").get(orgId, input.activityId, input.studentId);
    if (!enrollment) throw new Error("Aluno não está matriculado nesta atividade.");

    const existing = db.prepare("SELECT id FROM extracurricular_attendance WHERE organization_id = ? AND activity_id = ? AND student_id = ? AND date = ?").get(orgId, input.activityId, input.studentId, date) as any;
    let id: string;
    if (existing) {
      id = existing.id;
      db.prepare("UPDATE extracurricular_attendance SET status = ?, note = ?, recorded_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(status, String(input?.note || "").trim() || null, actorId || null, id);
    } else {
      id = randomUUID();
      db.prepare("INSERT INTO extracurricular_attendance (id, organization_id, activity_id, student_id, date, status, note, recorded_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(id, orgId, input.activityId, input.studentId, date, status, String(input?.note || "").trim() || null, actorId || null);
    }
    logAuthEvent(orgId, actorId, input.studentId, "EXTRACURRICULAR_ATTENDANCE", { activityId: input.activityId, date, status });
    return { id, status };
  }
}

export default ExtracurricularService;
