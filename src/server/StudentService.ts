import db from "./db.js";
import { randomUUID } from "node:crypto";
import { logAuthEvent } from "./auditLog.js";
import { BusinessSignalService } from "./BusinessSignalService.js";

/**
 * Módulo Escola (ADR-144, Fatia 1) — cadastro de alunos, vínculo com o
 * responsável e o CONSENTIMENTO-DE-MENOR.
 *
 * O aluno é ENTIDADE PRÓPRIA (menor, sem telefone; molde de clinic_professionals,
 * ADR-080 D2) — não é um contato do CRM. O responsável É um `contacts` (tem
 * WhatsApp). O consentimento vive na RELAÇÃO responsável↔aluno e é a PORTA do
 * envio (ADR-144 D3): sem ele, o resumo nem é montado. Tudo escopado por
 * `organization_id` e auditado.
 */
export class StudentService {
  // ── Aluno ──────────────────────────────────────────────────────────────
  static createStudent(orgId: string, input: {
    fullName: string; birthDate?: string; turma?: string; enrollmentCode?: string; notes?: string;
  }, actorId?: string): any {
    const name = String(input?.fullName || "").trim();
    if (!name) throw new Error("Nome do aluno é obrigatório.");
    const id = randomUUID();
    db.prepare(`INSERT INTO student_profiles (id, organization_id, full_name, birth_date, turma, enrollment_code, notes) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(id, orgId, name, input?.birthDate || null, String(input?.turma || "").trim() || null,
        String(input?.enrollmentCode || "").trim() || null, String(input?.notes || "").trim() || null);
    logAuthEvent(orgId, actorId, id, "STUDENT_CREATED", { turma: input?.turma });
    return this.getStudent(orgId, id);
  }

  static getStudent(orgId: string, studentId: string): any {
    const student = db.prepare("SELECT * FROM student_profiles WHERE id = ? AND organization_id = ?").get(studentId, orgId) as any;
    if (!student) throw new Error("Aluno não encontrado.");
    const guardians = db.prepare(`
      SELECT sg.*, c.name AS guardian_name, c.identifier AS guardian_identifier
      FROM student_guardians sg JOIN contacts c ON c.id = sg.guardian_contact_id AND c.organization_id = sg.organization_id
      WHERE sg.student_id = ? AND sg.organization_id = ? ORDER BY sg.is_primary DESC, sg.created_at ASC`).all(studentId, orgId) as any[];
    return { student, guardians };
  }

  static listStudents(orgId: string, opts: { q?: string; turma?: string } = {}): any[] {
    let sql = "SELECT * FROM student_profiles WHERE organization_id = ? AND status = 'active'";
    const params: any[] = [orgId];
    if (opts.q) { sql += " AND (full_name LIKE ? OR enrollment_code LIKE ?)"; const t = `%${opts.q}%`; params.push(t, t); }
    if (opts.turma) { sql += " AND turma = ?"; params.push(opts.turma); }
    sql += " ORDER BY full_name ASC LIMIT 500";
    return db.prepare(sql).all(...params) as any[];
  }

  static updateStudent(orgId: string, studentId: string, input: {
    fullName?: string; birthDate?: string; turma?: string; enrollmentCode?: string; status?: string; notes?: string;
  }, actorId?: string): any {
    const existing = db.prepare("SELECT id FROM student_profiles WHERE id = ? AND organization_id = ?").get(studentId, orgId);
    if (!existing) throw new Error("Aluno não encontrado.");
    const fields: string[] = [], params: any[] = [];
    const set = (col: string, val: any) => { fields.push(`${col} = ?`); params.push(val); };
    if (input.fullName !== undefined) set("full_name", String(input.fullName || "").trim() || null);
    if (input.birthDate !== undefined) set("birth_date", input.birthDate || null);
    if (input.turma !== undefined) set("turma", String(input.turma || "").trim() || null);
    if (input.enrollmentCode !== undefined) set("enrollment_code", String(input.enrollmentCode || "").trim() || null);
    if (input.status !== undefined) set("status", input.status === "inactive" ? "inactive" : "active");
    if (input.notes !== undefined) set("notes", String(input.notes || "").trim() || null);
    if (fields.length) {
      params.push(studentId, orgId);
      db.prepare(`UPDATE student_profiles SET ${fields.join(", ")}, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND organization_id = ?`).run(...params);
      logAuthEvent(orgId, actorId, studentId, "STUDENT_UPDATED", { fields: fields.map(f => f.split(" ")[0]) });
    }
    return this.getStudent(orgId, studentId);
  }

  // ── Responsável (vínculo) ──────────────────────────────────────────────
  /** Vincula um responsável (contato existente) ao aluno. Idempotente por (aluno, contato). */
  static linkGuardian(orgId: string, studentId: string, input: {
    guardianContactId: string; relationship?: string; isPrimary?: boolean;
  }, actorId?: string): any {
    const student = db.prepare("SELECT id FROM student_profiles WHERE id = ? AND organization_id = ?").get(studentId, orgId);
    if (!student) throw new Error("Aluno não encontrado.");
    const contact = db.prepare("SELECT id FROM contacts WHERE id = ? AND organization_id = ?").get(input?.guardianContactId, orgId);
    if (!contact) throw new Error("Contato do responsável não encontrado.");
    const existing = db.prepare("SELECT id FROM student_guardians WHERE organization_id = ? AND student_id = ? AND guardian_contact_id = ?")
      .get(orgId, studentId, input.guardianContactId) as any;
    if (existing) {
      db.prepare("UPDATE student_guardians SET relationship = ?, is_primary = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
        .run(String(input?.relationship || "").trim() || null, input?.isPrimary ? 1 : 0, existing.id);
    } else {
      db.prepare(`INSERT INTO student_guardians (id, organization_id, student_id, guardian_contact_id, relationship, is_primary) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(randomUUID(), orgId, studentId, input.guardianContactId, String(input?.relationship || "").trim() || null, input?.isPrimary ? 1 : 0);
      logAuthEvent(orgId, actorId, studentId, "STUDENT_GUARDIAN_LINKED", { guardianContactId: input.guardianContactId });
    }
    return this.getStudent(orgId, studentId);
  }

  /**
   * Registra ou revoga o CONSENTIMENTO do responsável para receber o resumo do
   * aluno (ADR-144 D3, consentimento-de-menor). É a porta do envio.
   */
  static setConsent(orgId: string, studentId: string, guardianContactId: string, consent: boolean, actorId?: string): any {
    const link = db.prepare("SELECT id FROM student_guardians WHERE organization_id = ? AND student_id = ? AND guardian_contact_id = ?")
      .get(orgId, studentId, guardianContactId) as any;
    if (!link) throw new Error("Vínculo responsável↔aluno não encontrado.");
    if (consent) {
      db.prepare("UPDATE student_guardians SET digest_consent = 1, digest_consent_at = CURRENT_TIMESTAMP, digest_consent_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
        .run(actorId || null, link.id);
      logAuthEvent(orgId, actorId, studentId, "STUDENT_DIGEST_CONSENT_GRANTED", { guardianContactId });
    } else {
      db.prepare("UPDATE student_guardians SET digest_consent = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(link.id);
      logAuthEvent(orgId, actorId, studentId, "STUDENT_DIGEST_CONSENT_REVOKED", { guardianContactId });
    }
    return this.getStudent(orgId, studentId);
  }

  // ── Agenda do dia (fonte do resumo) ────────────────────────────────────
  static addAgendaItem(orgId: string, studentId: string, input: {
    date: string; kind?: string; title: string; timeLabel?: string; status?: string;
  }, actorId?: string): any {
    const student = db.prepare("SELECT id FROM student_profiles WHERE id = ? AND organization_id = ?").get(studentId, orgId);
    if (!student) throw new Error("Aluno não encontrado.");
    const date = String(input?.date || "").trim();
    const title = String(input?.title || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("Data inválida (use YYYY-MM-DD).");
    if (!title) throw new Error("Título do item é obrigatório.");
    const KINDS = new Set(["class", "activity", "notice", "pickup"]);
    const kind = KINDS.has(String(input?.kind)) ? String(input.kind) : "notice";
    const id = randomUUID();
    db.prepare(`INSERT INTO student_agenda_items (id, organization_id, student_id, date, kind, title, time_label, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, orgId, studentId, date, kind, title, String(input?.timeLabel || "").trim() || null, String(input?.status || "").trim() || null);
    return { id };
  }

  static agendaForDay(orgId: string, studentId: string, date: string): any[] {
    // Ordena por tipo (aulas primeiro, avisos/saída depois) e horário textual.
    return db.prepare(`SELECT * FROM student_agenda_items WHERE organization_id = ? AND student_id = ? AND date = ?
      ORDER BY CASE kind WHEN 'class' THEN 0 WHEN 'activity' THEN 1 WHEN 'notice' THEN 2 WHEN 'pickup' THEN 3 ELSE 4 END, time_label ASC, created_at ASC`)
      .all(orgId, studentId, date) as any[];
  }

  // ── Sinal de coordenação: falta (ADR-144 D5) ──────────────────────────
  /**
   * Registra uma falta do aluno e PUBLICA um sinal no domínio `education`, que o
   * Pareto/briefing da coordenação já leva à ação (ADR-132/136). Não envia nada
   * ao responsável (audiência distinta) — só sinaliza à escola. Idempotente por
   * (aluno, data) via dedupeKey.
   */
  static recordAbsence(orgId: string, studentId: string, date: string, reason?: string, actorId?: string): { signalId: string; deduped: boolean } {
    const student = db.prepare("SELECT id, full_name, turma FROM student_profiles WHERE id = ? AND organization_id = ?").get(studentId, orgId) as any;
    if (!student) throw new Error("Aluno não encontrado.");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ""))) throw new Error("Data inválida (use YYYY-MM-DD).");
    const justified = !!String(reason || "").trim();
    const res = BusinessSignalService.publish(orgId, {
      domain: "education",
      signalType: "student_absence",
      severity: justified ? "info" : "attention",
      basis: "fact",
      confidence: 1,
      sourceService: "StudentService",
      sourceEntityType: "student",
      sourceEntityId: studentId,
      evidence: { student: student.full_name, turma: student.turma, date, justified, reason: reason || null },
      dedupeKey: `education:absence:${studentId}:${date}`,
    });
    logAuthEvent(orgId, actorId, studentId, "STUDENT_ABSENCE_RECORDED", { date, justified });
    return { signalId: res.id, deduped: res.deduped };
  }
}

export default StudentService;
