/**
 * TaxReferenceService — ADR-181 F2: Base de Referência Tributária CURADA (CBS/IBS/IS).
 *
 * A fonte da VERDADE das alíquotas da Reforma. GLOBAL (a lei é igual p/ todos — sem
 * organization_id), DATE-EFFECTIVE, escrita SÓ pelo admin master. Espelha o
 * `LaborLawAdvisorService`/`labor_law_entries` (ADR-178): NASCE VAZIA e cada entrada exige
 * `reviewedBy`. O motor de cálculo (F3) consulta `rateFor` — e é AQUI que o guardrail nº 1
 * mora: sem entrada vigente p/ a data → `null` (`no_rate_for_period`), NUNCA um palpite.
 *
 * Guardrails RN-FISCAL:
 *  - 1 (nunca inventa): `rateFor` só devolve o que foi CURADO; base vazia → null.
 *  - 2 (nasce vazia + reviewed_by): `curate` EXIGE `reviewedBy`; nenhuma seed embutida.
 *  - 3 (date-effective): a alíquota vale pela DATA do fato gerador (janela from..to).
 *  - 6 (isolamento): base GLOBAL, sem nenhum dado de tenant.
 *  - 10 (referência viva): mudança de lei = nova entrada/vigência, sem tocar código.
 */
import { randomUUID } from "crypto";
import db from "./db.js";
import { logAuthEvent } from "./auditLog.js";

/** Tributos da Reforma do Consumo. IS = Imposto Seletivo. */
export const TRIBUTES = ["cbs", "ibs", "is"] as const;
export type Tribute = (typeof TRIBUTES)[number];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface TaxRate {
  id: string;
  tribute: Tribute;
  phase: string;
  ratePercent: number;
  appliesTo: string | null;   // null = geral
  effectiveFrom: string;      // YYYY-MM-DD
  effectiveTo: string | null; // YYYY-MM-DD ou null (em aberto)
  source: string | null;
  notes: string | null;
  reviewedBy: string;
  status: "published" | "archived";
}

export interface CurateInput {
  tribute: string;
  phase: string;
  ratePercent: number | string;
  reviewedBy: string;
  appliesTo?: string | null;
  effectiveFrom: string;
  effectiveTo?: string | null;
  source?: string | null;
  notes?: string | null;
}

function mapRow(r: any): TaxRate {
  return {
    id: r.id, tribute: r.tribute, phase: r.phase, ratePercent: Number(r.rate_percent),
    appliesTo: r.applies_to ?? null, effectiveFrom: r.effective_from, effectiveTo: r.effective_to ?? null,
    source: r.source ?? null, notes: r.notes ?? null, reviewedBy: r.reviewed_by, status: r.status,
  };
}

export class TaxReferenceService {
  /**
   * Publica uma alíquota curada (master-only). Valida FORMA aqui (invariante da base):
   * tributo conhecido, alíquota numérica ≥ 0, datas YYYY-MM-DD coerentes, `reviewedBy`
   * obrigatório (RN-FISCAL-2). Não deduplica: fases sobrepostas são responsabilidade do
   * curador (o `rateFor` desempata pela vigência mais recente + recorte mais específico).
   */
  static curate(input: CurateInput, actorId?: string): TaxRate {
    const tribute = String(input.tribute || "").trim().toLowerCase();
    if (!TRIBUTES.includes(tribute as Tribute)) throw new Error("tribute_invalid");
    const rate = Number(input.ratePercent);
    if (!Number.isFinite(rate) || rate < 0) throw new Error("rate_invalid");
    const phase = String(input.phase || "").trim();
    if (!phase) throw new Error("phase_required");
    const reviewedBy = String(input.reviewedBy || "").trim();
    if (!reviewedBy) throw new Error("reviewed_by_required");           // RN-FISCAL-2
    const from = String(input.effectiveFrom || "").trim();
    if (!DATE_RE.test(from)) throw new Error("effective_from_invalid");
    const to = input.effectiveTo == null || String(input.effectiveTo).trim() === "" ? null : String(input.effectiveTo).trim();
    if (to !== null && !DATE_RE.test(to)) throw new Error("effective_to_invalid");
    if (to !== null && to < from) throw new Error("effective_range_invalid");
    const appliesTo = input.appliesTo == null || String(input.appliesTo).trim() === "" ? null : String(input.appliesTo).trim().toLowerCase();

    const id = randomUUID();
    db.prepare(
      `INSERT INTO tax_reference_rates (id, tribute, phase, rate_percent, applies_to, effective_from, effective_to, source, notes, reviewed_by, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, tribute, phase, rate, appliesTo, from, to, input.source ? String(input.source).slice(0, 300) : null,
          input.notes ? String(input.notes).slice(0, 1000) : null, reviewedBy, actorId || null);
    try { logAuthEvent(null, actorId || "master", null, "TAX_RATE_CURATE", { id, tribute, phase, rate, from, to, appliesTo }); } catch { /* noop */ }
    return this.getById(id)!;
  }

  static getById(id: string): TaxRate | null {
    const r = db.prepare(`SELECT * FROM tax_reference_rates WHERE id = ?`).get(id) as any;
    return r ? mapRow(r) : null;
  }

  /** Todas as entradas (published + archived), p/ o painel de curadoria master. */
  static list(opts?: { tribute?: string; includeArchived?: boolean }): TaxRate[] {
    const where: string[] = [];
    const vals: any[] = [];
    if (opts?.tribute) { where.push("tribute = ?"); vals.push(String(opts.tribute).toLowerCase()); }
    if (!opts?.includeArchived) where.push("status = 'published'");
    const sql = `SELECT * FROM tax_reference_rates ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY tribute, effective_from DESC`;
    return (db.prepare(sql).all(...vals) as any[]).map(mapRow);
  }

  static archive(id: string, actorId?: string): { archived: boolean } {
    const r = db.prepare(`UPDATE tax_reference_rates SET status = 'archived', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'published'`).run(id);
    if (r.changes > 0) { try { logAuthEvent(null, actorId || "master", null, "TAX_RATE_ARCHIVE", { id }); } catch { /* noop */ } }
    return { archived: r.changes > 0 };
  }

  /**
   * A ALÍQUOTA VIGENTE de um tributo numa data (o coração do guardrail nº 1). Retorna a
   * entrada published cuja janela `effective_from`..`effective_to` contém `date`, com
   * PRECEDÊNCIA de recorte: se `appliesTo` casa exatamente (ex.: 'simples_das'), ganha do
   * geral (`applies_to IS NULL`); dentro do mesmo recorte, a vigência mais recente ganha.
   * SEM entrada → null (RN-FISCAL-1 — nunca inventa; o caller decide o que fazer com o gap).
   */
  static rateFor(tribute: string, dateISO: string, opts?: { appliesTo?: string | null }): TaxRate | null {
    const t = String(tribute || "").trim().toLowerCase();
    if (!TRIBUTES.includes(t as Tribute)) throw new Error("tribute_invalid");
    const date = String(dateISO || "").slice(0, 10);
    if (!DATE_RE.test(date)) throw new Error("date_invalid");
    const scope = opts?.appliesTo == null || String(opts.appliesTo).trim() === "" ? null : String(opts.appliesTo).trim().toLowerCase();

    // Candidatas vigentes na data (recorte exato OU geral). Ordena: recorte-exato primeiro
    // (applies_to = scope antes de NULL), depois vigência mais recente.
    const rows = db.prepare(
      `SELECT * FROM tax_reference_rates
        WHERE tribute = ? AND status = 'published'
          AND effective_from <= ?
          AND (effective_to IS NULL OR effective_to >= ?)
          AND (applies_to IS ? OR applies_to IS NULL)
        ORDER BY (applies_to IS NULL) ASC, effective_from DESC
        LIMIT 1`
    ).get(t, date, date, scope) as any;
    return rows ? mapRow(rows) : null;
  }

  /** Cobertura da base p/ a UI (honesto: base vazia diz que está vazia — não finge pronto). */
  static status(): { total: number; byTribute: Record<string, number>; empty: boolean } {
    const rows = db.prepare(`SELECT tribute, COUNT(*) n FROM tax_reference_rates WHERE status = 'published' GROUP BY tribute`).all() as any[];
    const byTribute: Record<string, number> = { cbs: 0, ibs: 0, is: 0 };
    let total = 0;
    for (const r of rows) { byTribute[r.tribute] = Number(r.n); total += Number(r.n); }
    return { total, byTribute, empty: total === 0 };
  }
}

export default TaxReferenceService;
