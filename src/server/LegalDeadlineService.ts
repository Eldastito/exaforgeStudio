import { randomUUID } from "crypto";
import db from "./db.js";
import { logAuthEvent } from "./auditLog.js";
import { TaskService } from "./TaskService.js";

/**
 * Legal Deadline (ADR-191 F5) — PRAZOS processuais. A borda MAIS crítica da vertical:
 * perder prazo é erro profissional. Nenhum motor existente conta em DIAS ÚTEIS com
 * FERIADOS FORENSES (grep zero) — este é o motor novo.
 *
 * CONTAGEM (CPC art. 219/224): prazos processuais em dias contam SÓ dias úteis,
 * excluindo o dia do começo (a publicação) e incluindo o vencimento; se o vencimento
 * cair em dia não útil, protrai pro próximo dia útil. Modo `calendar` (corridos) existe
 * pra prazos materiais/administrativos que a lei manda contar corrido.
 *
 * NUNCA INVENTA (RN-ADV-02/03): a contagem só é confiável com o calendário de feriados
 * CARREGADO — se o período não tem cobertura, marca `holidaysLoaded=false` (a UI avisa;
 * o advogado confirma). O prazo é HIPÓTESE materializada numa `task` (reuso ADR-171) +
 * sinaliza o FATAL na ESPINHA (`business_signals`, convenção nº 12) quando perto/vencido.
 * Isolado por org. Datas em UTC (YYYY-MM-DD) pra não derivar por fuso.
 */

const MS_DAY = 86400000;
const toUTC = (ymd: string): number => { const [y, m, d] = ymd.split("-").map(Number); return Date.UTC(y, m - 1, d); };
const fromUTC = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const nowISO = () => new Date().toISOString();
const todayYMD = () => new Date().toISOString().slice(0, 10);

// Páscoa (Meeus/Jones/Butcher, gregoriano) → feriados MÓVEIS forenses.
function easter(year: number): number {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return Date.UTC(year, month - 1, day);
}

export interface DeadlineInput {
  caseId?: string | null;
  title: string;
  publicationDate: string;   // YYYY-MM-DD
  termDays: number;
  countingMode?: "business" | "calendar";
  isFatal?: boolean;
}

export class LegalDeadlineService {
  // ── Calendário de feriados (por-org) ──

  static addHoliday(orgId: string, date: string, name: string, type = "local"): void {
    try {
      db.prepare(`INSERT INTO legal_holidays (id, organization_id, date, name, holiday_type) VALUES (?, ?, ?, ?, ?)`)
        .run(randomUUID(), orgId, date, name, type);
    } catch { /* duplicata (mesma data) → ignora */ }
  }

  static listHolidays(orgId: string, year?: number): any[] {
    if (year) return db.prepare(`SELECT * FROM legal_holidays WHERE organization_id = ? AND date LIKE ? ORDER BY date`).all(orgId, `${year}-%`) as any[];
    return db.prepare(`SELECT * FROM legal_holidays WHERE organization_id = ? ORDER BY date`).all(orgId) as any[];
  }

  /** Semeia o calendário forense de um ANO: nacionais fixos + móveis (Páscoa) + recesso
   *  (art. 220 — 20/12 a 06/01). É um PONTO DE PARTIDA — o escritório ajusta feriados
   *  locais/tribunal (RN-ADV-03: não inventa; seed determinístico, editável). Idempotente. */
  static seedNationalHolidays(orgId: string, year: number): { created: number } {
    const before = this.listHolidays(orgId, year).length;
    const y = year;
    const fixed: Array<[string, string]> = [
      [`${y}-01-01`, "Confraternização Universal"], [`${y}-04-21`, "Tiradentes"], [`${y}-05-01`, "Dia do Trabalho"],
      [`${y}-09-07`, "Independência"], [`${y}-10-12`, "N. Sra. Aparecida"], [`${y}-11-02`, "Finados"],
      [`${y}-11-15`, "Proclamação da República"], [`${y}-12-25`, "Natal"],
    ];
    for (const [d, n] of fixed) this.addHoliday(orgId, d, n, "national");
    // Móveis forenses (comumente observados; o tribunal pode variar).
    const e = easter(y);
    this.addHoliday(orgId, fromUTC(e - 2 * MS_DAY), "Sexta-feira Santa", "forum_movable");
    this.addHoliday(orgId, fromUTC(e - 48 * MS_DAY), "Carnaval (segunda)", "forum_movable");
    this.addHoliday(orgId, fromUTC(e - 47 * MS_DAY), "Carnaval (terça)", "forum_movable");
    this.addHoliday(orgId, fromUTC(e + 60 * MS_DAY), "Corpus Christi", "forum_movable");
    // Recesso forense (art. 220): 20/12..31/12 do ano + 01/01..06/01 (tail do ano anterior).
    for (let d = 20; d <= 31; d++) this.addHoliday(orgId, `${y}-12-${String(d).padStart(2, "0")}`, "Recesso forense", "forum_recess");
    for (let d = 1; d <= 6; d++) this.addHoliday(orgId, `${y}-01-${String(d).padStart(2, "0")}`, "Recesso forense", "forum_recess");
    return { created: this.listHolidays(orgId, year).length - before };
  }

  // ── Motor de contagem ──

  private static holidaySet(orgId: string): Set<string> {
    return new Set(db.prepare(`SELECT date FROM legal_holidays WHERE organization_id = ?`).all(orgId).map((r: any) => r.date));
  }

  static isBusinessDay(orgId: string, ymd: string, holidays?: Set<string>): boolean {
    const dow = new Date(toUTC(ymd)).getUTCDay(); // 0=dom, 6=sáb
    if (dow === 0 || dow === 6) return false;
    return !(holidays || this.holidaySet(orgId)).has(ymd);
  }

  /** Data-fim do prazo. business: conta N dias úteis excluindo a publicação, incluindo o
   *  vencimento (CPC 219/224). calendar: +N corridos, protrai vencimento p/ dia útil (224 §1). */
  static computeDeadline(orgId: string, publicationDate: string, termDays: number, mode: "business" | "calendar" = "business"): { dueDate: string; holidaysLoaded: boolean } {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(publicationDate)) throw new Error("Data de publicação inválida (use YYYY-MM-DD).");
    if (!Number.isInteger(termDays) || termDays < 1) throw new Error("Prazo (dias) inválido.");
    const holidays = this.holidaySet(orgId);
    let cursor = toUTC(publicationDate);
    if (mode === "calendar") {
      cursor += termDays * MS_DAY;
      while (!this.isBusinessDay(orgId, fromUTC(cursor), holidays)) cursor += MS_DAY; // protrai (224 §1)
    } else {
      let counted = 0;
      while (counted < termDays) { cursor += MS_DAY; if (this.isBusinessDay(orgId, fromUTC(cursor), holidays)) counted++; }
    }
    const dueDate = fromUTC(cursor);
    // Cobertura honesta: há feriado carregado no ano da publicação e no ano do vencimento?
    const yearsCovered = new Set([publicationDate.slice(0, 4), dueDate.slice(0, 4)]);
    const holidaysLoaded = [...yearsCovered].every((yr) => this.listHolidays(orgId, Number(yr)).length > 0);
    return { dueDate, holidaysLoaded };
  }

  // ── Prazos (persistência + materialização) ──

  static create(orgId: string, input: DeadlineInput, actorId: string | null = null): any {
    const title = String(input?.title || "").trim();
    if (!title) throw new Error("Descreva o prazo.");
    const mode = input.countingMode === "calendar" ? "calendar" : "business";
    if (input.caseId) {
      const c = db.prepare(`SELECT id, responsible_lawyer_id FROM legal_cases WHERE organization_id = ? AND id = ?`).get(orgId, input.caseId) as any;
      if (!c) throw new Error("Processo não encontrado.");
    }
    const { dueDate, holidaysLoaded } = this.computeDeadline(orgId, input.publicationDate, input.termDays, mode);
    const isFatal = input.isFatal === false ? 0 : 1;

    // Materializa uma TAREFA (reuso ADR-171) pro advogado responsável, com vencimento na data-fim.
    let taskId: string | null = null;
    try {
      const caseRow = input.caseId ? db.prepare(`SELECT responsible_lawyer_id, title FROM legal_cases WHERE organization_id = ? AND id = ?`).get(orgId, input.caseId) as any : null;
      const t = TaskService.create(orgId, {
        title: `Prazo: ${title}`, dueAt: `${dueDate}T12:00:00.000Z`, priority: isFatal ? "alta" : "media",
        assignedTo: caseRow?.responsible_lawyer_id || null, source: "manual",
        refLabel: caseRow?.title ? `Processo: ${caseRow.title}` : "Prazo processual",
      }, actorId || undefined);
      taskId = t?.id || null;
    } catch { /* materialização best-effort — o prazo existe mesmo sem a tarefa */ }

    const id = randomUUID();
    db.prepare(
      `INSERT INTO legal_deadlines (id, organization_id, case_id, title, publication_date, term_days, counting_mode, due_date, is_fatal, status, task_id, holidays_loaded, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`
    ).run(id, orgId, input.caseId || null, title, input.publicationDate, input.termDays, mode, dueDate, isFatal, taskId, holidaysLoaded ? 1 : 0, actorId);
    logAuthEvent(orgId, actorId, input.caseId || null, "LEGAL_DEADLINE_CREATED", { deadlineId: id, dueDate, holidaysLoaded });
    return this.get(orgId, id);
  }

  static get(orgId: string, id: string): any {
    return db.prepare(`SELECT * FROM legal_deadlines WHERE organization_id = ? AND id = ?`).get(orgId, id) || null;
  }

  static list(orgId: string, opts: { status?: string; caseId?: string } = {}): any[] {
    if (opts.caseId) return db.prepare(`SELECT * FROM legal_deadlines WHERE organization_id = ? AND case_id = ? ORDER BY due_date`).all(orgId, opts.caseId) as any[];
    if (opts.status) return db.prepare(`SELECT * FROM legal_deadlines WHERE organization_id = ? AND status = ? ORDER BY due_date`).all(orgId, opts.status) as any[];
    return db.prepare(`SELECT * FROM legal_deadlines WHERE organization_id = ? ORDER BY (status != 'open') ASC, due_date`).all(orgId) as any[];
  }

  static complete(orgId: string, id: string, actorId: string | null = null): any {
    const d = this.get(orgId, id);
    if (!d) throw new Error("Prazo não encontrado.");
    db.prepare(`UPDATE legal_deadlines SET status = 'done', updated_at = ? WHERE organization_id = ? AND id = ?`).run(nowISO(), orgId, id);
    // Resolve o sinal fatal se estava aberto (self-healing).
    try { import("./BusinessSignalService.js").then((m) => m.BusinessSignalService.resolveByDedupe(orgId, `legal_deadline:${id}`)); } catch { /* noop */ }
    return this.get(orgId, id);
  }

  static cancel(orgId: string, id: string, actorId: string | null = null): any {
    const d = this.get(orgId, id);
    if (!d) throw new Error("Prazo não encontrado.");
    db.prepare(`UPDATE legal_deadlines SET status = 'cancelled', updated_at = ? WHERE organization_id = ? AND id = ?`).run(nowISO(), orgId, id);
    try { import("./BusinessSignalService.js").then((m) => m.BusinessSignalService.resolveByDedupe(orgId, `legal_deadline:${id}`)); } catch { /* noop */ }
    return this.get(orgId, id);
  }

  /** Sinaliza na ESPINHA os prazos FATAIS abertos vencendo em ≤ `withinBusinessDays` (ou já
   *  vencidos) — nunca inventa, só o que está armazenado. severity: vencido=critical, perto=risk. */
  static async signalFatal(orgId: string, withinBusinessDays = 3): Promise<{ signaled: number }> {
    const { BusinessSignalService } = await import("./BusinessSignalService.js");
    const holidays = this.holidaySet(orgId);
    const today = todayYMD();
    // limite = hoje + N dias úteis
    let cursor = toUTC(today), counted = 0;
    while (counted < withinBusinessDays) { cursor += MS_DAY; if (this.isBusinessDay(orgId, fromUTC(cursor), holidays)) counted++; }
    const limit = fromUTC(cursor);
    const due = db.prepare(`SELECT * FROM legal_deadlines WHERE organization_id = ? AND status = 'open' AND is_fatal = 1 AND due_date <= ?`).all(orgId, limit) as any[];
    let signaled = 0;
    for (const d of due) {
      const overdue = d.due_date < today;
      try {
        BusinessSignalService.publish(orgId, {
          domain: "legal", signalType: "deadline_due", severity: overdue ? "critical" : "risk", basis: "fact", confidence: 1,
          impactAmount: null, impactUnit: null, sourceService: "LegalDeadlineService",
          evidence: { deadlineId: d.id, title: d.title, dueDate: d.due_date, overdue, holidaysLoaded: !!d.holidays_loaded, note: `${overdue ? "PRAZO VENCIDO" : "Prazo fatal chegando"}: ${d.title} (vence ${d.due_date})` },
          dedupeKey: `legal_deadline:${d.id}`,
        });
        signaled += 1;
      } catch { /* best-effort */ }
    }
    return { signaled };
  }

  /** Scheduler pass: sinaliza prazos fatais pras orgs de advocacia. Best-effort. */
  static async pass(): Promise<void> {
    let orgs: any[] = [];
    try { orgs = db.prepare(`SELECT organization_id FROM organization_settings WHERE vertical = 'advocacia' AND status = 'active'`).all() as any[]; } catch { return; }
    for (const o of orgs) { try { await this.signalFatal(o.organization_id); } catch (e) { console.error("[LegalDeadline] signal falhou", o.organization_id, e); } }
  }
}

export default LegalDeadlineService;
