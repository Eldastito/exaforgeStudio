import db from "./db.js";
import { randomUUID } from "node:crypto";
import { onlyDigits } from "./phoneMatch.js";
import { StudentService } from "./StudentService.js";
import { TeacherService } from "./TeacherService.js";
import { logAuthEvent } from "./auditLog.js";

/**
 * Módulo Escola (ADR-144, Fatia 5) — Conectores reais: o motor de IMPORT.
 *
 * Entrada AGNÓSTICA e DETERMINÍSTICA para o que a escola já produz (planilha,
 * Google Sheets, ou o payload normalizado de um conector por cliente). Um único
 * motor idempotente alimenta o modelo das Fatias 1-4; os dois caminhos de entrega
 * (rota JWT da secretaria e webhook por token) chamam este serviço.
 *
 * Idempotência (reimportar não duplica):
 *  - aluno: casa por `enrollment_code` (matrícula); senão por nome+turma.
 *  - responsável: casa o contato por telefone (dígitos) no canal da org; o vínculo
 *    aluno↔responsável é idempotente; consentimento é opt-in explícito (D3).
 *  - grade: dedupe por (professor, turma, weekday, horário).
 *  - agenda: dedupe por (aluno, data, título).
 *
 * NÃO envia nada — só ingere. O valor (resumo/agenda/sinais) já roda por cima.
 */

export interface SectionReport { created: number; updated: number; skipped: number; }
const empty = (): SectionReport => ({ created: 0, updated: 0, skipped: 0 });

export interface ImportPayload {
  students?: Array<{ fullName?: string; enrollmentCode?: string; turma?: string; birthDate?: string; notes?: string }>;
  guardians?: Array<{ student?: string; name?: string; phone?: string; relationship?: string; isPrimary?: boolean; consent?: boolean }>;
  schedule?: Array<{ teacher?: string; teacherPhone?: string; turma?: string; weekday?: number; timeLabel?: string; subject?: string }>;
  agenda?: Array<{ student?: string; date?: string; kind?: string; title?: string; timeLabel?: string; status?: string }>;
}

export class SchoolImportService {
  private static norm(s: any): string { return String(s ?? "").trim().toLowerCase(); }

  /** Resolve um aluno por matrícula (enrollment_code) ou por nome exato. */
  private static resolveStudentId(orgId: string, ref?: string): string | null {
    const r = String(ref ?? "").trim();
    if (!r) return null;
    const byCode = db.prepare("SELECT id FROM student_profiles WHERE organization_id = ? AND enrollment_code IS NOT NULL AND lower(enrollment_code) = lower(?)").get(orgId, r) as any;
    if (byCode) return byCode.id;
    const byName = db.prepare("SELECT id FROM student_profiles WHERE organization_id = ? AND lower(full_name) = lower(?) ORDER BY created_at ASC LIMIT 1").get(orgId, r) as any;
    return byName?.id || null;
  }

  // ── Alunos ─────────────────────────────────────────────────────────────
  static importStudents(orgId: string, rows: ImportPayload["students"] = [], actorId?: string): SectionReport {
    const rep = empty();
    for (const row of rows || []) {
      const name = String(row?.fullName || "").trim();
      if (!name) { rep.skipped++; continue; }
      const code = String(row?.enrollmentCode || "").trim();
      let existing: any = null;
      if (code) existing = db.prepare("SELECT id FROM student_profiles WHERE organization_id = ? AND lower(enrollment_code) = lower(?)").get(orgId, code);
      if (!existing) existing = db.prepare("SELECT id FROM student_profiles WHERE organization_id = ? AND lower(full_name) = lower(?) AND COALESCE(lower(turma),'') = COALESCE(lower(?),'')").get(orgId, name, String(row?.turma || "").trim() || null);
      if (existing) {
        StudentService.updateStudent(orgId, existing.id, { fullName: name, turma: row?.turma, enrollmentCode: code || undefined, birthDate: row?.birthDate, notes: row?.notes }, actorId);
        rep.updated++;
      } else {
        StudentService.createStudent(orgId, { fullName: name, turma: row?.turma, enrollmentCode: code || undefined, birthDate: row?.birthDate, notes: row?.notes }, actorId);
        rep.created++;
      }
    }
    return rep;
  }

  // ── Responsáveis (contato + vínculo + consentimento) ───────────────────
  static importGuardians(orgId: string, rows: ImportPayload["guardians"] = [], actorId?: string): SectionReport {
    const rep = empty();
    if (!(rows || []).length) return rep;
    // Um contato precisa de canal (contacts.channel_id NOT NULL). Usa o canal da org.
    const channel = db.prepare(`SELECT id FROM channels WHERE organization_id = ? ORDER BY (status != 'disabled') DESC, created_at ASC LIMIT 1`).get(orgId) as any;
    for (const row of rows || []) {
      const studentId = this.resolveStudentId(orgId, row?.student);
      if (!studentId) { rep.skipped++; continue; }
      const phone = onlyDigits(row?.phone);
      if (!phone) { rep.skipped++; continue; }
      if (!channel) { rep.skipped++; continue; }
      // Upsert do contato por (org, canal, identificador=telefone).
      let contact = db.prepare("SELECT id FROM contacts WHERE organization_id = ? AND channel_id = ? AND identifier = ?").get(orgId, channel.id, phone) as any;
      if (!contact) {
        const cid = randomUUID();
        db.prepare("INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, ?, ?, ?)").run(cid, orgId, channel.id, String(row?.name || "").trim() || null, phone);
        contact = { id: cid };
      } else if (row?.name) {
        db.prepare("UPDATE contacts SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(String(row.name).trim(), contact.id);
      }
      const hadLink = db.prepare("SELECT id FROM student_guardians WHERE organization_id = ? AND student_id = ? AND guardian_contact_id = ?").get(orgId, studentId, contact.id);
      StudentService.linkGuardian(orgId, studentId, { guardianContactId: contact.id, relationship: row?.relationship, isPrimary: row?.isPrimary }, actorId);
      if (row?.consent === true) StudentService.setConsent(orgId, studentId, contact.id, true, actorId);
      if (hadLink) rep.updated++; else rep.created++;
    }
    return rep;
  }

  // ── Grade por turma ────────────────────────────────────────────────────
  static importSchedule(orgId: string, rows: ImportPayload["schedule"] = [], actorId?: string): SectionReport {
    const rep = empty();
    for (const row of rows || []) {
      const teacherName = String(row?.teacher || "").trim();
      const turma = String(row?.turma || "").trim();
      const weekday = Number(row?.weekday);
      if (!teacherName || !turma || !Number.isInteger(weekday) || weekday < 0 || weekday > 6) { rep.skipped++; continue; }
      // Upsert do professor por nome (case-insensitive).
      let teacher = db.prepare("SELECT id FROM teacher_profiles WHERE organization_id = ? AND lower(full_name) = lower(?) ORDER BY created_at ASC LIMIT 1").get(orgId, teacherName) as any;
      if (!teacher) {
        teacher = TeacherService.createTeacher(orgId, { fullName: teacherName, phone: row?.teacherPhone, subject: row?.subject }, actorId).teacher;
      } else if (row?.teacherPhone) {
        const cur = db.prepare("SELECT phone FROM teacher_profiles WHERE id = ?").get(teacher.id) as any;
        if (!cur?.phone) db.prepare("UPDATE teacher_profiles SET phone = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(onlyDigits(row.teacherPhone) || null, teacher.id);
      }
      const timeLabel = String(row?.timeLabel || "").trim() || null;
      const dupe = db.prepare("SELECT id FROM class_schedule_items WHERE organization_id = ? AND teacher_id = ? AND turma = ? AND weekday = ? AND COALESCE(time_label,'') = COALESCE(?,'') AND status = 'active'").get(orgId, teacher.id, turma, weekday, timeLabel);
      if (dupe) { rep.updated++; continue; } // já existe idêntico → idempotente
      TeacherService.addScheduleItem(orgId, teacher.id, { turma, weekday, timeLabel: timeLabel || undefined, subject: row?.subject }, actorId);
      rep.created++;
    }
    return rep;
  }

  // ── Agenda do aluno (fonte do resumo diário) ───────────────────────────
  static importAgenda(orgId: string, rows: ImportPayload["agenda"] = [], actorId?: string): SectionReport {
    const rep = empty();
    for (const row of rows || []) {
      const studentId = this.resolveStudentId(orgId, row?.student);
      const date = String(row?.date || "").trim();
      const title = String(row?.title || "").trim();
      if (!studentId || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !title) { rep.skipped++; continue; }
      const dupe = db.prepare("SELECT id FROM student_agenda_items WHERE organization_id = ? AND student_id = ? AND date = ? AND lower(title) = lower(?)").get(orgId, studentId, date, title);
      if (dupe) { rep.updated++; continue; }
      StudentService.addAgendaItem(orgId, studentId, { date, kind: row?.kind, title, timeLabel: row?.timeLabel, status: row?.status }, actorId);
      rep.created++;
    }
    return rep;
  }

  /** Importa um payload completo (qualquer seção é opcional). Idempotente. */
  static importData(orgId: string, payload: ImportPayload = {}, opts: { source?: string; actorId?: string } = {}): { source: string; students: SectionReport; guardians: SectionReport; schedule: SectionReport; agenda: SectionReport } {
    const actorId = opts.actorId;
    const out = {
      source: opts.source || "import",
      students: this.importStudents(orgId, payload?.students, actorId),
      guardians: this.importGuardians(orgId, payload?.guardians, actorId),
      schedule: this.importSchedule(orgId, payload?.schedule, actorId),
      agenda: this.importAgenda(orgId, payload?.agenda, actorId),
    };
    const total = (r: SectionReport) => r.created + r.updated;
    logAuthEvent(orgId, actorId, orgId, "SCHOOL_IMPORT", {
      source: out.source,
      students: total(out.students), guardians: total(out.guardians), schedule: total(out.schedule), agenda: total(out.agenda),
    });
    return out;
  }
}

export default SchoolImportService;
