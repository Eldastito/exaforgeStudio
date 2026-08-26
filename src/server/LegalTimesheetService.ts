import { randomUUID } from "crypto";
import db from "./db.js";
import { logAuthEvent } from "./auditLog.js";
import { LegalFeeService } from "./LegalFeeService.js";

/**
 * Legal Timesheet (ADR-191 F11) — HONORÁRIO POR-HORA. Diferido do F8.
 *
 * O advogado registra HORAS por processo/cliente; o faturamento DERIVA horas × valor-hora
 * e vira um honorário FIXO (reuso do F8 → `receivable`, sem 2º razão). O valor-hora vem
 * ACORDADO por lançamento (ou um override no faturamento) — NUNCA arbitrado pela IA.
 *
 * RN-ADV-07 (nunca inventa dinheiro): lançamento sem valor-hora tem HORAS mas `amount`
 * NULL e NÃO é faturável até ter tarifa; `summary` separa o faturável do pendente-de-tarifa.
 * RN-ADV-01: isolado por organization_id. Retenção: anular é `billable=0`, nunca DELETE após faturado.
 */

const nowISO = () => new Date().toISOString();
const round2 = (n: number) => Math.round(Number(n) * 100) / 100;
const todayYMD = () => new Date().toISOString().slice(0, 10);

function caseRow(orgId: string, caseId: string): any {
  return db.prepare(`SELECT id, contact_id FROM legal_cases WHERE organization_id = ? AND id = ?`).get(orgId, caseId) || null;
}

export interface TimeEntryInput {
  caseId?: string | null;
  contactId?: string | null;
  professionalId?: string | null;
  description: string;
  minutes: number;
  ratePerHour?: number | null;
  entryDate?: string | null;
  billable?: boolean;
}

/** amount = horas × valor-hora; NULL sem tarifa (RN-ADV-07). */
function entryAmount(row: any): number | null {
  if (row.rate_per_hour == null) return null;
  return round2((Number(row.minutes) / 60) * Number(row.rate_per_hour));
}

export class LegalTimesheetService {
  static get(orgId: string, id: string): any {
    const r = db.prepare(`SELECT * FROM legal_time_entries WHERE organization_id = ? AND id = ?`).get(orgId, id) as any;
    if (!r) return null;
    return { ...r, amount: entryAmount(r) };
  }

  static list(orgId: string, opts: { caseId?: string; contactId?: string; professionalId?: string; billed?: boolean } = {}): any[] {
    const clauses = [`organization_id = ?`]; const args: any[] = [orgId];
    if (opts.caseId) { clauses.push(`case_id = ?`); args.push(opts.caseId); }
    if (opts.contactId) { clauses.push(`contact_id = ?`); args.push(opts.contactId); }
    if (opts.professionalId) { clauses.push(`professional_id = ?`); args.push(opts.professionalId); }
    if (opts.billed !== undefined) { clauses.push(`billed = ?`); args.push(opts.billed ? 1 : 0); }
    const rows = db.prepare(`SELECT * FROM legal_time_entries WHERE ${clauses.join(" AND ")} ORDER BY entry_date DESC, created_at DESC`).all(...args) as any[];
    return rows.map((r) => ({ ...r, amount: entryAmount(r) }));
  }

  /** Registra horas. Cliente vem do processo (se houver) ou do contactId. Nunca inventa tarifa. */
  static logTime(orgId: string, input: TimeEntryInput, actorId: string | null = null): any {
    const desc = String(input?.description || "").trim();
    if (!desc) throw new Error("Descreva o trabalho realizado.");
    const minutes = Math.floor(Number(input?.minutes));
    if (!Number.isFinite(minutes) || minutes <= 0) throw new Error("Informe a duração em minutos (> 0).");

    let contactId = input.contactId || null;
    if (input.caseId) {
      const c = caseRow(orgId, input.caseId);
      if (!c) throw new Error("Processo não encontrado.");
      contactId = c.contact_id;
    }
    if (!contactId) throw new Error("Informe o cliente (contactId) ou um processo.");
    if (!db.prepare(`SELECT id FROM contacts WHERE organization_id = ? AND id = ?`).get(orgId, contactId)) throw new Error("Cliente não encontrado.");
    if (input.professionalId && !db.prepare(`SELECT id FROM clinic_professionals WHERE organization_id = ? AND id = ?`).get(orgId, input.professionalId)) throw new Error("Advogado não encontrado.");

    let rate: number | null = null;
    if (input.ratePerHour != null && input.ratePerHour !== ("" as any)) {
      rate = round2(input.ratePerHour);
      if (!(rate > 0)) throw new Error("Valor-hora inválido (deve ser > 0 quando informado).");
    }
    const entryDate = input.entryDate && /^\d{4}-\d{2}-\d{2}$/.test(String(input.entryDate)) ? String(input.entryDate) : todayYMD();

    const id = randomUUID();
    db.prepare(
      `INSERT INTO legal_time_entries (id, organization_id, case_id, contact_id, professional_id, description, minutes, rate_per_hour, entry_date, billable, billed, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`
    ).run(id, orgId, input.caseId || null, contactId, input.professionalId || null, desc, minutes, rate, entryDate, input.billable === false ? 0 : 1, actorId);
    logAuthEvent(orgId, actorId, contactId, "LEGAL_TIME_LOGGED", { entryId: id, minutes, hasRate: rate != null, caseId: input.caseId || null });
    return this.get(orgId, id);
  }

  /** Anula um lançamento (não faturado) — não conta mais. Retenção: nunca DELETE após faturado. */
  static voidEntry(orgId: string, id: string, actorId: string | null = null): any {
    const e = this.get(orgId, id);
    if (!e) throw new Error("Lançamento não encontrado.");
    if (e.billed) throw new Error("Lançamento já faturado não pode ser anulado.");
    db.prepare(`UPDATE legal_time_entries SET billable = 0, updated_at = ? WHERE organization_id = ? AND id = ?`).run(nowISO(), orgId, id);
    logAuthEvent(orgId, actorId, e.contact_id, "LEGAL_TIME_VOIDED", { entryId: id });
    return this.get(orgId, id);
  }

  /** Resumo por processo/cliente: horas faturáveis com tarifa (→ R$) × pendentes de tarifa.
   *  RN-ADV-07: sem lançamento faturável → billableAmount NULL (não R$ 0,00). */
  static summary(orgId: string, opts: { caseId?: string; contactId?: string; onlyUnbilled?: boolean } = {}): any {
    const rows = this.list(orgId, { caseId: opts.caseId, contactId: opts.contactId }).filter((r) => r.billable && (!opts.onlyUnbilled || !r.billed));
    if (!rows.length) return { entries: 0, totalMinutes: 0, billableAmount: null, pendingRateMinutes: 0, billedAmount: null };
    let totalMinutes = 0, billableAmount = 0, pendingRateMinutes = 0, billedAmount = 0, hasBillable = false, hasBilled = false;
    for (const r of rows) {
      totalMinutes += r.minutes;
      if (r.amount == null) { pendingRateMinutes += r.minutes; continue; }
      hasBillable = true;
      if (r.billed) { billedAmount += r.amount; hasBilled = true; } else billableAmount += r.amount;
    }
    return {
      entries: rows.length, totalMinutes,
      billableAmount: hasBillable ? round2(billableAmount) : null,   // ainda não faturado (com tarifa)
      billedAmount: hasBilled ? round2(billedAmount) : null,         // já faturado
      pendingRateMinutes,                                            // horas sem tarifa (não faturáveis ainda)
    };
  }

  /** Fatura as horas NÃO faturadas (com tarifa) de um processo/cliente num honorário FIXO (reuso F8).
   *  `defaultRatePerHour` preenche a tarifa dos lançamentos SEM tarifa (opt-in — nunca arbitra sozinho). */
  static bill(orgId: string, opts: { caseId?: string; contactId?: string; dueDate: string; defaultRatePerHour?: number | null; description?: string }, actorId: string | null = null): any {
    if (!opts.caseId && !opts.contactId) throw new Error("Informe caseId ou contactId.");
    const candidates = this.list(orgId, { caseId: opts.caseId, contactId: opts.contactId, billed: false }).filter((r) => r.billable);
    // Aplica a tarifa-default aos sem-tarifa, se fornecida (RN-ADV-07 — só com decisão humana explícita).
    const defRate = opts.defaultRatePerHour != null ? round2(opts.defaultRatePerHour) : null;
    if (defRate != null && !(defRate > 0)) throw new Error("Valor-hora default inválido.");

    let totalAmount = 0, totalMinutes = 0; const toBill: string[] = [];
    for (const r of candidates) {
      const rate = r.rate_per_hour != null ? Number(r.rate_per_hour) : defRate;
      if (rate == null) continue; // sem tarifa → não fatura (RN-ADV-07)
      const amount = round2((r.minutes / 60) * rate);
      totalAmount += amount; totalMinutes += r.minutes; toBill.push(r.id);
      // congela a tarifa aplicada no próprio lançamento (auditável).
      if (r.rate_per_hour == null) db.prepare(`UPDATE legal_time_entries SET rate_per_hour = ? WHERE organization_id = ? AND id = ?`).run(rate, orgId, r.id);
    }
    if (!toBill.length) throw new Error("Nenhuma hora faturável (sem tarifa acordada). Informe defaultRatePerHour ou preencha o valor-hora dos lançamentos.");

    const hours = round2(totalMinutes / 60);
    const contactId = opts.contactId || (opts.caseId ? caseRow(orgId, opts.caseId)?.contact_id : null);
    const fee = LegalFeeService.createFixed(orgId, {
      caseId: opts.caseId || null, contactId,
      description: opts.description || `Honorário por hora (${hours}h)`, amount: round2(totalAmount), dueDate: opts.dueDate,
    }, actorId);

    // Marca os lançamentos como faturados + amarra ao honorário.
    const stmt = db.prepare(`UPDATE legal_time_entries SET billed = 1, fee_id = ?, updated_at = ? WHERE organization_id = ? AND id = ?`);
    const tx = db.transaction((ids: string[]) => { for (const id of ids) stmt.run(fee.id, nowISO(), orgId, id); });
    tx(toBill);
    logAuthEvent(orgId, actorId, contactId, "LEGAL_TIME_BILLED", { feeId: fee.id, entries: toBill.length, hours, amount: round2(totalAmount) });
    return { fee, entriesBilled: toBill.length, hours, amount: round2(totalAmount) };
  }
}

export default LegalTimesheetService;
