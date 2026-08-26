import { randomUUID } from "crypto";
import db from "./db.js";
import { logAuthEvent } from "./auditLog.js";
import { LegalFeeService } from "./LegalFeeService.js";

/**
 * Legal Success Fee (ADR-191 F12) — HONORÁRIO DE ÊXITO. Diferido do F8.
 *
 * Percentual ACORDADO sobre o PROVEITO ECONÔMICO do processo, cobrado só quando o
 * resultado favorável se confirma. É AQUI que a honestidade importa: o percentual é
 * combinado com o cliente, mas o VALOR DA CAUSA / proveito econômico é informado pelo
 * HUMANO no momento da confirmação — a IA NUNCA arbitra quanto o cliente ganhou.
 *
 * RN-ADV-07 (nunca inventa dinheiro): fica `pending` com `base_amount`/`amount` NULL até
 * a confirmação com o proveito econômico real; só então vira honorário FIXO (reuso F8 →
 * `receivable`). RN-ADV-01: isolado por organization_id. Retenção: cancelar é UPDATE.
 */

const nowISO = () => new Date().toISOString();
const round2 = (n: number) => Math.round(Number(n) * 100) / 100;

function caseRow(orgId: string, caseId: string): any {
  return db.prepare(`SELECT id, contact_id FROM legal_cases WHERE organization_id = ? AND id = ?`).get(orgId, caseId) || null;
}

export interface SuccessFeeInput {
  caseId: string;
  percent: number;
  description?: string | null;
}

export class LegalSuccessFeeService {
  static get(orgId: string, id: string): any {
    return db.prepare(`SELECT * FROM legal_success_fees WHERE organization_id = ? AND id = ?`).get(orgId, id) || null;
  }

  static list(orgId: string, opts: { caseId?: string; contactId?: string; status?: string } = {}): any[] {
    const clauses = [`organization_id = ?`]; const args: any[] = [orgId];
    if (opts.caseId) { clauses.push(`case_id = ?`); args.push(opts.caseId); }
    if (opts.contactId) { clauses.push(`contact_id = ?`); args.push(opts.contactId); }
    if (opts.status) { clauses.push(`status = ?`); args.push(opts.status); }
    return db.prepare(`SELECT * FROM legal_success_fees WHERE ${clauses.join(" AND ")} ORDER BY (status = 'cancelled') ASC, created_at DESC`).all(...args) as any[];
  }

  /** Registra o ACORDO de êxito (percentual). base_amount/amount ficam NULL até confirmar. */
  static agree(orgId: string, input: SuccessFeeInput, actorId: string | null = null): any {
    const c = caseRow(orgId, input.caseId);
    if (!c) throw new Error("Processo não encontrado.");
    const percent = round2(input?.percent);
    if (!(percent > 0) || percent > 100) throw new Error("Percentual de êxito inválido (0 < % ≤ 100).");
    const desc = String(input?.description || "").trim() || `Êxito ${percent}%`;

    const id = randomUUID();
    db.prepare(
      `INSERT INTO legal_success_fees (id, organization_id, case_id, contact_id, description, percent, status, created_by)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`
    ).run(id, orgId, input.caseId, c.contact_id, desc, percent, actorId);
    logAuthEvent(orgId, actorId, c.contact_id, "LEGAL_SUCCESS_FEE_AGREED", { successFeeId: id, caseId: input.caseId, percent });
    return this.get(orgId, id);
  }

  /** Prévia do valor SEM persistir: proveito × percent. Nunca inventa o proveito. */
  static preview(orgId: string, id: string, baseAmount: number): { percent: number; baseAmount: number; amount: number } {
    const sf = this.get(orgId, id);
    if (!sf) throw new Error("Honorário de êxito não encontrado.");
    const base = round2(baseAmount);
    if (!(base > 0)) throw new Error("Proveito econômico inválido.");
    return { percent: sf.percent, baseAmount: base, amount: round2(base * sf.percent / 100) };
  }

  /** CONFIRMA o êxito: o HUMANO informa o proveito econômico → vira honorário FIXO (F8). */
  static confirm(orgId: string, id: string, opts: { baseAmount: number; dueDate: string }, actorId: string | null = null): any {
    const sf = this.get(orgId, id);
    if (!sf) throw new Error("Honorário de êxito não encontrado.");
    if (sf.status === "confirmed") return sf;
    if (sf.status === "cancelled") throw new Error("Honorário de êxito cancelado não pode ser confirmado.");
    const base = round2(opts?.baseAmount);
    if (!(base > 0)) throw new Error("Informe o proveito econômico obtido (valor real — nunca inventado).");

    const amount = round2(base * sf.percent / 100);
    const fee = LegalFeeService.createFixed(orgId, {
      caseId: sf.case_id, contactId: sf.contact_id,
      description: `${sf.description} (êxito ${sf.percent}% sobre ${base})`, amount, dueDate: opts.dueDate,
    }, actorId);

    db.prepare(`UPDATE legal_success_fees SET status = 'confirmed', base_amount = ?, amount = ?, fee_id = ?, confirmed_at = ?, updated_at = ? WHERE organization_id = ? AND id = ?`)
      .run(base, amount, fee.id, nowISO(), nowISO(), orgId, id);
    logAuthEvent(orgId, actorId, sf.contact_id, "LEGAL_SUCCESS_FEE_CONFIRMED", { successFeeId: id, baseAmount: base, amount, feeId: fee.id });
    return this.get(orgId, id);
  }

  /** Cancela o acordo (resultado desfavorável / desistência). Retenção: nunca DELETE. */
  static cancel(orgId: string, id: string, actorId: string | null = null): any {
    const sf = this.get(orgId, id);
    if (!sf) throw new Error("Honorário de êxito não encontrado.");
    if (sf.status === "cancelled") return sf;
    if (sf.status === "confirmed") throw new Error("Honorário de êxito já confirmado — cancele o honorário fixo gerado, não o acordo.");
    db.prepare(`UPDATE legal_success_fees SET status = 'cancelled', updated_at = ? WHERE organization_id = ? AND id = ?`).run(nowISO(), orgId, id);
    logAuthEvent(orgId, actorId, sf.contact_id, "LEGAL_SUCCESS_FEE_CANCELLED", { successFeeId: id });
    return this.get(orgId, id);
  }
}

export default LegalSuccessFeeService;
