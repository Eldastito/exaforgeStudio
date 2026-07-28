import db from "./db.js";
import { StudentService } from "./StudentService.js";
import { onlyDigits } from "./phoneMatch.js";

/**
 * Módulo Escola (ADR-144, Fatia 1) — o RESUMO DIÁRIO ao responsável no WhatsApp.
 *
 * Espelha o BusinessTutorService (ADR-131): conteúdo DETERMINÍSTICO (zero-token),
 * janela da manhã em hora de São Paulo, dedupe por dia, envio `send` INJETADO
 * (testável sem rede). A diferença é a CHAVE: aqui o passe itera por ALUNO e
 * envia a cada RESPONSÁVEL que CONSENTIU (a porta do ADR-144 D3) — o dedupe é
 * por relação responsável↔aluno (`student_guardians.last_digest_date`).
 */

export interface DigestSendResult {
  sent: number;
  skipped: number;
  results: Array<{ studentId: string; guardianContactId: string; phone?: string; reason?: string; sent: boolean }>;
}

export class SchoolDigestService {
  private static MORNING_START = 6;
  private static MORNING_END = 12; // exclusivo

  /** Data e hora em São Paulo a partir de um Date (determinístico p/ teste). */
  static spParts(now: Date): { dateSP: string; hourSP: number } {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Sao_Paulo",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", hourCycle: "h23",
    }).formatToParts(now);
    const get = (t: string) => parts.find((p) => p.type === t)?.value || "";
    return { dateSP: `${get("year")}-${get("month")}-${get("day")}`, hourSP: Number(get("hour")) };
  }

  private static firstName(full: string): string {
    return String(full || "").trim().split(/\s+/)[0] || String(full || "").trim();
  }

  /** Texto do resumo diário de um aluno para uma data (SP). Determinístico, zero-token. */
  static dailyDigest(orgId: string, studentId: string, date: string, opts: { guardianName?: string } = {}): { text: string; itemCount: number } {
    const student = db.prepare("SELECT full_name, turma FROM student_profiles WHERE id = ? AND organization_id = ?").get(studentId, orgId) as any;
    if (!student) throw new Error("Aluno não encontrado.");
    const items = StudentService.agendaForDay(orgId, studentId, date);

    const lines: string[] = [];
    const greet = opts.guardianName ? `☀️ *Bom dia, ${this.firstName(opts.guardianName)}!*` : "☀️ *Bom dia!*";
    const turma = student.turma ? ` (${student.turma})` : "";
    lines.push(`${greet} Resumo de hoje do *${this.firstName(student.full_name)}*${turma}:`);
    lines.push("");

    if (items.length) {
      const classes = items.filter((i: any) => i.kind === "class");
      const activities = items.filter((i: any) => i.kind === "activity");
      const notices = items.filter((i: any) => i.kind === "notice");
      const pickups = items.filter((i: any) => i.kind === "pickup");

      if (classes.length) {
        const withTime = classes.find((c: any) => c.time_label);
        const first = withTime ? ` — 1ª ${withTime.time_label}` : "";
        lines.push(`• ${classes.length} aula(s)${first}`);
      }
      activities.forEach((a: any) => lines.push(`• ${a.title}${a.time_label ? ` às ${a.time_label}` : ""}`));
      notices.forEach((n: any) => {
        const pend = String(n.status || "").toLowerCase() === "pending" ? ": *pendente*" : "";
        lines.push(`📌 ${n.title}${pend}`);
      });
      pickups.forEach((p: any) => lines.push(`🚪 ${p.title}${p.time_label ? `: ${p.time_label}` : ""}`));
    } else {
      lines.push("Sem novidades na agenda de hoje. 👍");
    }

    lines.push("");
    lines.push("Dúvidas? Responda por aqui. Para não receber mais, responda *SAIR*.");
    return { text: lines.join("\n"), itemCount: items.length };
  }

  /**
   * Passe do resumo diário de uma org (injeta o envio). Para cada aluno ativo com
   * responsável que CONSENTIU, dentro da janela da manhã (SP) e ainda não enviado
   * hoje (dedupe por relação), envia a cada responsável. Marca a data só APÓS o
   * envio (retenta no próximo tick se falhar). Sem consentimento → pula sem marcar.
   */
  static async runDigestPass(orgId: string, opts: { now: Date; send: (phone: string, text: string) => any; force?: boolean }): Promise<DigestSendResult> {
    const out: DigestSendResult = { sent: 0, skipped: 0, results: [] };
    const { dateSP, hourSP } = this.spParts(opts.now);
    if (!opts.force && (hourSP < this.MORNING_START || hourSP >= this.MORNING_END)) return out;

    // Relações que consentiram, de alunos ativos, ainda não enviadas hoje.
    const links = db.prepare(`
      SELECT sg.id AS link_id, sg.student_id, sg.guardian_contact_id, sg.last_digest_date,
             s.full_name AS student_name, c.name AS guardian_name, c.identifier AS guardian_identifier
      FROM student_guardians sg
      JOIN student_profiles s ON s.id = sg.student_id AND s.organization_id = sg.organization_id AND s.status = 'active'
      JOIN contacts c ON c.id = sg.guardian_contact_id AND c.organization_id = sg.organization_id
      WHERE sg.organization_id = ? AND sg.digest_consent = 1`).all(orgId) as any[];

    for (const l of links) {
      if (!opts.force && l.last_digest_date === dateSP) { out.skipped++; out.results.push({ studentId: l.student_id, guardianContactId: l.guardian_contact_id, reason: "already_sent", sent: false }); continue; }
      const phone = onlyDigits(l.guardian_identifier);
      if (!phone) { out.skipped++; out.results.push({ studentId: l.student_id, guardianContactId: l.guardian_contact_id, reason: "no_phone", sent: false }); continue; }
      const { text } = this.dailyDigest(orgId, l.student_id, dateSP, { guardianName: l.guardian_name });
      await opts.send(phone, text);
      db.prepare("UPDATE student_guardians SET last_digest_date = ? WHERE id = ?").run(dateSP, l.link_id);
      out.sent++;
      out.results.push({ studentId: l.student_id, guardianContactId: l.guardian_contact_id, phone, sent: true });
    }
    return out;
  }

  /**
   * Envio manual de um aluno específico (botão "enviar teste") — ignora janela e
   * dedupe, mas RESPEITA o consentimento (a porta nunca é ignorada).
   */
  static async sendNow(orgId: string, studentId: string, opts: { now?: Date; send: (phone: string, text: string) => any }): Promise<{ sent: number; skipped: number }> {
    const { dateSP } = this.spParts(opts.now || new Date());
    const links = db.prepare(`
      SELECT sg.guardian_contact_id, c.name AS guardian_name, c.identifier AS guardian_identifier
      FROM student_guardians sg JOIN contacts c ON c.id = sg.guardian_contact_id AND c.organization_id = sg.organization_id
      WHERE sg.organization_id = ? AND sg.student_id = ? AND sg.digest_consent = 1`).all(orgId, studentId) as any[];
    let sent = 0, skipped = 0;
    for (const l of links) {
      const phone = onlyDigits(l.guardian_identifier);
      if (!phone) { skipped++; continue; }
      const { text } = this.dailyDigest(orgId, studentId, dateSP, { guardianName: l.guardian_name });
      await opts.send(phone, text);
      sent++;
    }
    return { sent, skipped };
  }
}

export default SchoolDigestService;
