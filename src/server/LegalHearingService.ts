import { randomUUID } from "crypto";
import db from "./db.js";
import { logAuthEvent } from "./auditLog.js";
import { ClinicAgendaService } from "./ClinicAgendaService.js";

/**
 * Legal Hearing (ADR-191 F6) — AUDIÊNCIAS/reuniões da vertical Advocacia.
 *
 * COMPOSIÇÃO PURA sobre a agenda (D1): o compromisso é um `appointment` normal
 * amarrado ao PROCESSO (`legal_cases`) pela coluna aditiva `legal_case_id` —
 * espelha o `care_episode_id` da clínica, sem tabela nova. `hearing_type` distingue
 * audiência/perícia/sustentação/julgamento/reunião/diligência. O cliente do
 * compromisso vem do processo (nunca inventado); o advogado default é o responsável.
 *
 * Conflito de agenda do advogado reusa `ClinicAgendaService.findConflicts`. Missar
 * audiência é grave (revelia/preclusão) — por isso, como no prazo fatal (F5), o
 * compromisso PRÓXIMO/atrasado sinaliza na ESPINHA (`business_signals`, convenção
 * nº 12), nunca em tabela de alerta paralela. Isolado por organization_id.
 */

const nowISO = () => new Date().toISOString();
const HEARING_TYPES = new Set(["audiencia", "pericia", "sustentacao", "julgamento", "reuniao", "diligencia"]);
const LIVE_CASE = new Set(["active", "on_hold"]);

export interface HearingInput {
  caseId: string;
  title?: string | null;
  hearingType?: string | null;
  start: string;                 // ISO datetime (data + hora)
  durationMinutes?: number | null;
  lawyerId?: string | null;      // default: responsável pelo processo
  location?: string | null;      // fórum/sala/link (texto livre)
  force?: boolean;               // ignora conflito de agenda do advogado
}

export class LegalHearingService {
  private static caseRow(orgId: string, caseId: string): any {
    return db.prepare(`SELECT * FROM legal_cases WHERE organization_id = ? AND id = ?`).get(orgId, caseId) || null;
  }

  private static lawyerName(orgId: string, lawyerId: string | null): string | null {
    if (!lawyerId) return null;
    const l = db.prepare(`SELECT name FROM clinic_professionals WHERE organization_id = ? AND id = ?`).get(orgId, lawyerId) as any;
    return l?.name || null;
  }

  /** Agenda uma audiência/reunião amarrada ao processo (reuso da agenda). */
  static schedule(orgId: string, input: HearingInput, actorId: string | null = null): any {
    const c = this.caseRow(orgId, input.caseId);
    if (!c) throw new Error("Processo não encontrado.");
    if (!LIVE_CASE.has(c.status)) throw new Error("Processo encerrado/arquivado — reabra antes de agendar.");

    const hearingType = String(input.hearingType || "audiencia");
    if (!HEARING_TYPES.has(hearingType)) throw new Error(`Tipo de compromisso inválido: ${hearingType}.`);

    const startMs = new Date(String(input.start)).getTime();
    if (!Number.isFinite(startMs)) throw new Error("Data/hora do compromisso inválida.");
    const dur = parseInt(String(input.durationMinutes), 10);
    const durationMinutes = Number.isFinite(dur) && dur > 0 ? Math.max(5, dur) : 60;
    const endMs = startMs + durationMinutes * 60000;

    // Advogado: default o responsável pelo processo; se informado, valida.
    const lawyerId = input.lawyerId || c.responsible_lawyer_id || null;
    if (lawyerId) {
      const l = db.prepare(`SELECT id FROM clinic_professionals WHERE organization_id = ? AND id = ?`).get(orgId, lawyerId) as any;
      if (!l) throw new Error("Advogado não encontrado.");
    }

    // Conflito de agenda do advogado (reuso puro) — não bloqueia sem advogado.
    if (lawyerId && !input.force) {
      const conflicts = ClinicAgendaService.findConflicts(orgId, { professionalId: lawyerId, startMs, endMs });
      if (conflicts.length) {
        const e: any = new Error(`Conflito de agenda do advogado: ${conflicts.map((x: any) => x.title || "compromisso").join(", ")}. Envie force=true para manter.`);
        e.code = "CONFLICT"; e.conflicts = conflicts;
        throw e;
      }
    }

    const title = String(input.title || "").trim() || this.defaultTitle(hearingType, c);
    const id = randomUUID();
    db.prepare(
      `INSERT INTO appointments (id, organization_id, contact_id, title, description, scheduled_start, scheduled_end, status, professional_id, professional_name_snapshot, legal_case_id, hearing_type)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'confirmed', ?, ?, ?, ?)`
    ).run(id, orgId, c.contact_id, title, input.location || null, new Date(startMs).toISOString(), new Date(endMs).toISOString(),
      lawyerId, this.lawyerName(orgId, lawyerId), input.caseId, hearingType);
    logAuthEvent(orgId, actorId, c.contact_id, "LEGAL_HEARING_SCHEDULED", { hearingId: id, caseId: input.caseId, hearingType, start: new Date(startMs).toISOString() });
    return this.get(orgId, id);
  }

  private static defaultTitle(hearingType: string, c: any): string {
    const label = hearingType === "audiencia" ? "Audiência"
      : hearingType === "pericia" ? "Perícia"
      : hearingType === "sustentacao" ? "Sustentação oral"
      : hearingType === "julgamento" ? "Sessão de julgamento"
      : hearingType === "diligencia" ? "Diligência"
      : "Reunião";
    return c?.title ? `${label} — ${c.title}` : label;
  }

  static get(orgId: string, id: string): any {
    return db.prepare(`SELECT * FROM appointments WHERE organization_id = ? AND id = ? AND legal_case_id IS NOT NULL`).get(orgId, id) || null;
  }

  static list(orgId: string, opts: { caseId?: string; status?: string; upcoming?: boolean } = {}): any[] {
    const clauses = [`organization_id = ?`, `legal_case_id IS NOT NULL`];
    const args: any[] = [orgId];
    if (opts.caseId) { clauses.push(`legal_case_id = ?`); args.push(opts.caseId); }
    if (opts.status) { clauses.push(`status = ?`); args.push(opts.status); }
    if (opts.upcoming) { clauses.push(`status = 'confirmed'`); clauses.push(`scheduled_start >= ?`); args.push(nowISO()); }
    return db.prepare(`SELECT * FROM appointments WHERE ${clauses.join(" AND ")} ORDER BY scheduled_start`).all(...args) as any[];
  }

  /** Remarca (reagenda) o compromisso — re-checa conflito do advogado. */
  static reschedule(orgId: string, id: string, start: string, durationMinutes?: number | null, actorId: string | null = null, force = false): any {
    const h = this.get(orgId, id);
    if (!h) throw new Error("Compromisso não encontrado.");
    if (h.status !== "confirmed") throw new Error("Compromisso não está ativo.");
    const startMs = new Date(String(start)).getTime();
    if (!Number.isFinite(startMs)) throw new Error("Data/hora inválida.");
    const dur = parseInt(String(durationMinutes), 10);
    const minutes = Number.isFinite(dur) && dur > 0 ? Math.max(5, dur) : 60;
    const endMs = startMs + minutes * 60000;
    if (h.professional_id && !force) {
      const conflicts = ClinicAgendaService.findConflicts(orgId, { professionalId: h.professional_id, startMs, endMs, ignoreId: id });
      if (conflicts.length) {
        const e: any = new Error(`Conflito de agenda do advogado. Envie force=true para manter.`);
        e.code = "CONFLICT"; e.conflicts = conflicts;
        throw e;
      }
    }
    db.prepare(`UPDATE appointments SET scheduled_start = ?, scheduled_end = ? WHERE organization_id = ? AND id = ?`)
      .run(new Date(startMs).toISOString(), new Date(endMs).toISOString(), orgId, id);
    logAuthEvent(orgId, actorId, h.contact_id, "LEGAL_HEARING_RESCHEDULED", { hearingId: id, start: new Date(startMs).toISOString() });
    // Reagendou → limpa sinal antigo (se remarcou pra longe, deixa o próximo pass reavaliar).
    try { import("./BusinessSignalService.js").then((m) => m.BusinessSignalService.resolveByDedupe(orgId, `legal_hearing:${id}`)); } catch { /* noop */ }
    return this.get(orgId, id);
  }

  static complete(orgId: string, id: string, actorId: string | null = null): any {
    const h = this.get(orgId, id);
    if (!h) throw new Error("Compromisso não encontrado.");
    db.prepare(`UPDATE appointments SET status = 'completed' WHERE organization_id = ? AND id = ?`).run(orgId, id);
    logAuthEvent(orgId, actorId, h.contact_id, "LEGAL_HEARING_COMPLETED", { hearingId: id });
    try { import("./BusinessSignalService.js").then((m) => m.BusinessSignalService.resolveByDedupe(orgId, `legal_hearing:${id}`)); } catch { /* noop */ }
    return this.get(orgId, id);
  }

  static cancel(orgId: string, id: string, reason: string | null = null, actorId: string | null = null): any {
    const h = this.get(orgId, id);
    if (!h) throw new Error("Compromisso não encontrado.");
    db.prepare(`UPDATE appointments SET status = 'cancelled', cancelled_at = ?, cancelled_by = 'staff', cancellation_reason = ? WHERE organization_id = ? AND id = ?`)
      .run(nowISO(), reason || null, orgId, id);
    logAuthEvent(orgId, actorId, h.contact_id, "LEGAL_HEARING_CANCELLED", { hearingId: id, reason });
    try { import("./BusinessSignalService.js").then((m) => m.BusinessSignalService.resolveByDedupe(orgId, `legal_hearing:${id}`)); } catch { /* noop */ }
    return this.get(orgId, id);
  }

  /** Sinaliza na ESPINHA os compromissos CONFIRMADOS próximos (≤ withinDays) ou já passados
   *  sem baixa — nunca inventa, só o que está agendado. severity: passado/hoje=critical, perto=risk. */
  static async signalUpcoming(orgId: string, withinDays = 2): Promise<{ signaled: number }> {
    const { BusinessSignalService } = await import("./BusinessSignalService.js");
    const now = Date.now();
    const limitISO = new Date(now + withinDays * 86400000).toISOString();
    const rows = db.prepare(
      `SELECT * FROM appointments WHERE organization_id = ? AND legal_case_id IS NOT NULL AND status = 'confirmed' AND scheduled_start <= ? ORDER BY scheduled_start`
    ).all(orgId, limitISO) as any[];
    let signaled = 0;
    for (const h of rows) {
      const startMs = new Date(h.scheduled_start).getTime();
      const past = Number.isFinite(startMs) && startMs < now;
      try {
        BusinessSignalService.publish(orgId, {
          domain: "legal", signalType: "hearing_upcoming", severity: past ? "critical" : "risk", basis: "fact", confidence: 1,
          impactAmount: null, impactUnit: null, sourceService: "LegalHearingService",
          evidence: { hearingId: h.id, caseId: h.legal_case_id, hearingType: h.hearing_type, start: h.scheduled_start, past,
            note: `${past ? "COMPROMISSO SEM BAIXA" : "Compromisso chegando"}: ${h.title} (${h.scheduled_start})` },
          dedupeKey: `legal_hearing:${h.id}`,
        });
        signaled += 1;
      } catch { /* best-effort */ }
    }
    return { signaled };
  }

  /** Scheduler pass: sinaliza audiências próximas pras orgs de advocacia. Best-effort. */
  static async pass(): Promise<void> {
    let orgs: any[] = [];
    try { orgs = db.prepare(`SELECT organization_id FROM organization_settings WHERE vertical = 'advocacia' AND status = 'active'`).all() as any[]; } catch { return; }
    for (const o of orgs) { try { await this.signalUpcoming(o.organization_id); } catch (e) { console.error("[LegalHearing] signal falhou", o.organization_id, e); } }
  }
}

export default LegalHearingService;
