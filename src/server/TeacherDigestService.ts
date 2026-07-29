import db from "./db.js";
import { TeacherService } from "./TeacherService.js";
import { onlyDigits } from "./phoneMatch.js";

/**
 * Módulo Escola (ADR-144, Fatia 2) — o "RESUMO ANTES DA AULA" ao professor.
 *
 * Espelha o SchoolDigestService/BusinessTutorService (ADR-131): conteúdo
 * DETERMINÍSTICO (zero-token) a partir da grade do dia, janela da manhã em hora
 * de São Paulo, dedupe por dia (`teacher_profiles.last_agenda_date`), envio `send`
 * INJETADO (testável sem rede). A PORTA aqui é `notify_opt_in` (o professor é
 * adulto/colaborador — opt-in explícito, não consentimento-de-menor). Professor
 * sem aulas no dia não recebe nada (e não marca dedupe).
 */

export interface TeacherAgendaResult {
  sent: number;
  skipped: number;
  results: Array<{ teacherId: string; phone?: string; reason?: string; sent: boolean }>;
}

export class TeacherDigestService {
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

  /** Texto do resumo antes da aula do professor para uma data (SP). Zero-token. */
  static dailyAgenda(orgId: string, teacherId: string, date: string): { text: string; classCount: number } {
    const teacher = db.prepare("SELECT full_name FROM teacher_profiles WHERE id = ? AND organization_id = ?").get(teacherId, orgId) as any;
    if (!teacher) throw new Error("Professor não encontrado.");
    const classes = TeacherService.scheduleForDay(orgId, teacherId, date);

    const lines: string[] = [];
    lines.push(`☀️ *Bom dia, professor(a) ${this.firstName(teacher.full_name)}!* Suas aulas de hoje:`);
    lines.push("");

    if (classes.length) {
      classes.forEach((c: any) => {
        const time = c.time_label ? `${c.time_label} — ` : "";
        const subj = c.subject ? `${c.subject} · ` : "";
        lines.push(`• ${time}${subj}${c.turma}`);
      });
      lines.push("");
      lines.push("Depois de cada aula, confirme por aqui se aconteceu. 👍");
    } else {
      lines.push("Sem aulas na sua grade de hoje. 👍");
    }
    return { text: lines.join("\n"), classCount: classes.length };
  }

  /**
   * Passe do resumo antes da aula de uma org (injeta o envio). Para cada professor
   * ativo com `notify_opt_in`, telefone válido, DENTRO da janela da manhã (SP),
   * COM aulas hoje e ainda não enviado hoje (dedupe por dia SP), envia. Marca a
   * data só APÓS o envio (retenta no próximo tick se falhar). Sem opt-in / sem
   * aulas → pula sem marcar.
   */
  static async runAgendaPass(orgId: string, opts: { now: Date; send: (phone: string, text: string) => any; force?: boolean }): Promise<TeacherAgendaResult> {
    const out: TeacherAgendaResult = { sent: 0, skipped: 0, results: [] };
    const { dateSP, hourSP } = this.spParts(opts.now);
    if (!opts.force && (hourSP < this.MORNING_START || hourSP >= this.MORNING_END)) return out;

    const teachers = db.prepare(`SELECT id, phone, last_agenda_date FROM teacher_profiles
      WHERE organization_id = ? AND status = 'active' AND notify_opt_in = 1`).all(orgId) as any[];

    for (const t of teachers) {
      if (!opts.force && t.last_agenda_date === dateSP) { out.skipped++; out.results.push({ teacherId: t.id, reason: "already_sent", sent: false }); continue; }
      const phone = onlyDigits(t.phone);
      if (!phone) { out.skipped++; out.results.push({ teacherId: t.id, reason: "no_phone", sent: false }); continue; }
      const { text, classCount } = this.dailyAgenda(orgId, t.id, dateSP);
      if (!classCount) { out.skipped++; out.results.push({ teacherId: t.id, reason: "no_classes", sent: false }); continue; }
      await opts.send(phone, text);
      db.prepare("UPDATE teacher_profiles SET last_agenda_date = ? WHERE id = ? AND organization_id = ?").run(dateSP, t.id, orgId);
      out.sent++;
      out.results.push({ teacherId: t.id, phone, sent: true });
    }
    return out;
  }

  /**
   * Envio manual (botão "enviar teste") — ignora janela e dedupe, mas RESPEITA o
   * opt-in e a existência de aulas (a porta nunca é ignorada).
   */
  static async sendNow(orgId: string, teacherId: string, opts: { now?: Date; send: (phone: string, text: string) => any }): Promise<{ sent: number; skipped: number; reason?: string }> {
    const { dateSP } = this.spParts(opts.now || new Date());
    const teacher = db.prepare("SELECT id, phone, notify_opt_in FROM teacher_profiles WHERE id = ? AND organization_id = ? AND status = 'active'").get(teacherId, orgId) as any;
    if (!teacher) return { sent: 0, skipped: 1, reason: "not_found" };
    if (!teacher.notify_opt_in) return { sent: 0, skipped: 1, reason: "no_opt_in" };
    const phone = onlyDigits(teacher.phone);
    if (!phone) return { sent: 0, skipped: 1, reason: "no_phone" };
    const { text, classCount } = this.dailyAgenda(orgId, teacherId, dateSP);
    if (!classCount) return { sent: 0, skipped: 1, reason: "no_classes" };
    await opts.send(phone, text);
    return { sent: 1, skipped: 0 };
  }
}

export default TeacherDigestService;
