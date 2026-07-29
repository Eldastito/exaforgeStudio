import db from "./db.js";
import { onlyDigits } from "./phoneMatch.js";

/**
 * Módulo Escola (ADR-144, Fatia 3) — o "AVISO AO RESPONSÁVEL" das
 * extracurriculares.
 *
 * Texto DETERMINÍSTICO (zero-token) para os eventos da matrícula (confirmada /
 * lista de espera / vaga liberada / falta) e fan-out para os responsáveis do
 * aluno com envio `send` INJETADO (testável sem rede). A PORTA é a mesma da
 * Fatia 1 (ADR-144 D3): só notifica responsáveis com `digest_consent = 1` —
 * consentimento-de-menor vale para qualquer mensagem sobre o aluno.
 */
export interface NoticeResult {
  sent: number;
  skipped: number;
  results: Array<{ guardianContactId: string; phone?: string; reason?: string; sent: boolean }>;
}

export class ExtracurricularNoticeService {
  private static firstName(full: string): string {
    return String(full || "").trim().split(/\s+/)[0] || String(full || "").trim();
  }

  private static when(activity: any): string {
    const day = String(activity?.day_label || "").trim();
    const time = String(activity?.time_label || "").trim();
    if (day && time) return ` (${day}, ${time})`;
    if (day) return ` (${day})`;
    if (time) return ` (${time})`;
    return "";
  }

  private static optOut(lines: string[]): string {
    lines.push("");
    lines.push("Dúvidas? Responda por aqui. Para não receber mais, responda *SAIR*.");
    return lines.join("\n");
  }

  /** Texto do aviso de matrícula: confirmada (`enrolled`) ou lista de espera (`waitlisted`). */
  static enrollmentText(studentName: string, activity: any, status: string, position: number | null): string {
    const aluno = this.firstName(studentName);
    const nome = String(activity?.name || "atividade");
    if (status === "waitlisted") {
      const pos = position ? ` — posição *${position}*` : "";
      return this.optOut([`📋 *${aluno}* entrou na *lista de espera* de *${nome}*${this.when(activity)}${pos}.`, "Avisamos assim que abrir uma vaga."]);
    }
    return this.optOut([`✅ *Matrícula confirmada!* ${aluno} está inscrito(a) em *${nome}*${this.when(activity)}.`]);
  }

  /** Texto do aviso de promoção (saiu da lista de espera). */
  static promotionText(studentName: string, activity: any): string {
    const aluno = this.firstName(studentName);
    const nome = String(activity?.name || "atividade");
    return this.optOut([`🎉 *Abriu vaga!* ${aluno} saiu da lista de espera e está *matriculado(a)* em *${nome}*${this.when(activity)}.`]);
  }

  /** Texto do aviso de falta numa sessão. */
  static absenceText(studentName: string, activity: any, date: string): string {
    const aluno = this.firstName(studentName);
    const nome = String(activity?.name || "atividade");
    return this.optOut([`⚠️ *${aluno}* faltou hoje em *${nome}* (${date}).`]);
  }

  /**
   * Notifica os responsáveis do aluno que CONSENTIRAM (porta D3) e têm telefone.
   * `send` é injetado. Não depende de janela nem de dedupe (é evento pontual).
   */
  static async notifyGuardians(orgId: string, studentId: string, text: string, opts: { send: (phone: string, text: string) => any }): Promise<NoticeResult> {
    const out: NoticeResult = { sent: 0, skipped: 0, results: [] };
    const links = db.prepare(`
      SELECT sg.guardian_contact_id, c.identifier AS guardian_identifier
      FROM student_guardians sg
      JOIN contacts c ON c.id = sg.guardian_contact_id AND c.organization_id = sg.organization_id
      WHERE sg.organization_id = ? AND sg.student_id = ? AND sg.digest_consent = 1`).all(orgId, studentId) as any[];
    for (const l of links) {
      const phone = onlyDigits(l.guardian_identifier);
      if (!phone) { out.skipped++; out.results.push({ guardianContactId: l.guardian_contact_id, reason: "no_phone", sent: false }); continue; }
      await opts.send(phone, text);
      out.sent++;
      out.results.push({ guardianContactId: l.guardian_contact_id, phone, sent: true });
    }
    return out;
  }

  /** Nome do aluno (helper p/ montar o texto sem repetir SELECT nos chamadores). */
  static studentName(orgId: string, studentId: string): string {
    const s = db.prepare("SELECT full_name FROM student_profiles WHERE id = ? AND organization_id = ?").get(studentId, orgId) as any;
    return s?.full_name || "";
  }
}

export default ExtracurricularNoticeService;
