import db from "./db.js";
import { randomUUID } from "crypto";

/**
 * RecoveryDebtService — Mapa da Dívida (Financial Recovery OS, PRD-ZF-UNIFIED-GAP-CLOSURE-03
 * F3.3 / PR-5). CADASTRO das obrigações externas de recuperação (banco, tributo,
 * fornecedor, folha, judicial, cartão, aluguel…) que o motor de caixa (ADR-125) NÃO
 * representa: `payables` são contas a pagar operacionais; dívida de recuperação é uma
 * obrigação com juros/risco jurídico/negociabilidade que o dono cadastra explicitamente.
 *
 * É a ÚNICA primitiva de DADOS nova do F3 (auditoria F0: nenhuma tabela de dívida existe).
 * Aditiva, isolada por org, opt-in pela flag `financial_recovery_enabled`.
 *
 * Guardrails (RN-FR, testados):
 * - RN-FR-1 NUNCA inventa dívida — só grava o que o operador cadastra (ou fonte real via
 *   source='payable'). Campo desconhecido fica `null`, jamais 0 ou fabricado (null≠0).
 * - RN-FR-2 Debt Map ≠ payables: não copia payables automaticamente nesta fatia (evita
 *   dupla contagem); pode só REFERENCIAR (source_id) quando o dono ancora manualmente.
 * - RN-FR-3 NUNCA dá parecer jurídico: `legal_risk` é rótulo do operador/derivado, não conselho.
 * - RN-FR-4 NÃO prioriza ordem de pagamento aqui (Debt Priority Matrix é PR-7, com evidência).
 *   Esta fatia só cadastra + agrega valores conhecidos.
 * - RN-FR-5 Isolamento multi-tenant (orgId 1º arg, todo WHERE filtra org).
 * - RN-FR-9 Retenção: cancelar é UPDATE status='canceled' (nunca DELETE).
 */

export type DebtCategory =
  | "payroll" | "tax" | "supplier" | "service_provider" | "loan"
  | "rent" | "utility" | "judicial" | "credit_card" | "other";
export type DebtStatus = "open" | "renegotiating" | "settled" | "canceled";
export type RiskBand = "low" | "medium" | "high";
export type DebtConfidence = "confirmed" | "likely" | "estimated";

const CATEGORIES: DebtCategory[] = ["payroll", "tax", "supplier", "service_provider", "loan", "rent", "utility", "judicial", "credit_card", "other"];
const STATUSES: DebtStatus[] = ["open", "renegotiating", "settled", "canceled"];
const BANDS: RiskBand[] = ["low", "medium", "high"];
const CONFIDENCES: DebtConfidence[] = ["confirmed", "likely", "estimated"];

export interface DebtInput {
  creditor: string;
  category: DebtCategory;
  amountTotal: number;
  amountOverdue?: number | null;
  monthlyPayment?: number | null;
  dueDate?: string | null;          // YYYY-MM-DD
  interestRate?: number | null;     // % a.m., só se conhecido
  secured?: boolean | null;         // garantia real? null = desconhecido
  operationalCriticality?: RiskBand | null;
  legalRisk?: RiskBand | null;
  negotiability?: RiskBand | null;
  source?: string;                  // manual | payable | derived
  sourceId?: string | null;
  confidence?: DebtConfidence;
  note?: string | null;
}

function num(v: any): number | null { const n = Number(v); return Number.isFinite(n) ? n : null; }
function band(v: any): RiskBand | null { return BANDS.includes(v) ? v : null; }

export class RecoveryDebtService {
  /** Cadastra uma obrigação de dívida. Valida categoria/valores; nunca inventa campo desconhecido. */
  static create(orgId: string, input: DebtInput, actorId?: string): any {
    if (!orgId) throw new Error("orgId obrigatório");
    const creditor = String(input?.creditor || "").trim();
    if (!creditor) throw new Error("creditor obrigatório");
    if (!CATEGORIES.includes(input?.category)) throw new Error("category inválida");
    const amountTotal = num(input?.amountTotal);
    if (amountTotal == null || amountTotal < 0) throw new Error("amountTotal inválido");
    const confidence: DebtConfidence = CONFIDENCES.includes(input?.confidence as any) ? (input!.confidence as DebtConfidence) : "estimated";
    const id = randomUUID();
    db.prepare(
      `INSERT INTO recovery_debt_items
        (id, organization_id, creditor, category, amount_total, amount_overdue, monthly_payment,
         due_date, interest_rate, secured, operational_criticality, legal_risk, negotiability,
         source, source_id, confidence, status, note, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`
    ).run(
      id, orgId, creditor, input.category, amountTotal,
      num(input?.amountOverdue), num(input?.monthlyPayment),
      input?.dueDate || null, num(input?.interestRate),
      input?.secured == null ? null : (input.secured ? 1 : 0),
      band(input?.operationalCriticality), band(input?.legalRisk), band(input?.negotiability),
      String(input?.source || "manual"), input?.sourceId || null, confidence,
      input?.note || null, actorId || null,
    );
    return this.get(orgId, id);
  }

  /** Atualiza campos parciais (patch). Nunca fabrica: só grava o que veio no patch. */
  static update(orgId: string, id: string, patch: Partial<DebtInput> & { status?: DebtStatus }, actorId?: string): any {
    const row = this.get(orgId, id);
    if (!row) throw new Error("dívida não encontrada");
    const sets: string[] = [];
    const vals: any[] = [];
    const push = (col: string, v: any) => { sets.push(`${col} = ?`); vals.push(v); };
    if (patch.creditor !== undefined) { const c = String(patch.creditor).trim(); if (!c) throw new Error("creditor vazio"); push("creditor", c); }
    if (patch.category !== undefined) { if (!CATEGORIES.includes(patch.category)) throw new Error("category inválida"); push("category", patch.category); }
    if (patch.amountTotal !== undefined) { const a = num(patch.amountTotal); if (a == null || a < 0) throw new Error("amountTotal inválido"); push("amount_total", a); }
    if (patch.amountOverdue !== undefined) push("amount_overdue", num(patch.amountOverdue));
    if (patch.monthlyPayment !== undefined) push("monthly_payment", num(patch.monthlyPayment));
    if (patch.dueDate !== undefined) push("due_date", patch.dueDate || null);
    if (patch.interestRate !== undefined) push("interest_rate", num(patch.interestRate));
    if (patch.secured !== undefined) push("secured", patch.secured == null ? null : (patch.secured ? 1 : 0));
    if (patch.operationalCriticality !== undefined) push("operational_criticality", band(patch.operationalCriticality));
    if (patch.legalRisk !== undefined) push("legal_risk", band(patch.legalRisk));
    if (patch.negotiability !== undefined) push("negotiability", band(patch.negotiability));
    if (patch.confidence !== undefined) push("confidence", CONFIDENCES.includes(patch.confidence as any) ? patch.confidence : "estimated");
    if (patch.note !== undefined) push("note", patch.note || null);
    if (patch.status !== undefined) { if (!STATUSES.includes(patch.status)) throw new Error("status inválido"); push("status", patch.status); }
    if (!sets.length) return row;
    push("updated_at", new Date().toISOString());
    push("updated_by", actorId || null);
    vals.push(orgId, id);
    db.prepare(`UPDATE recovery_debt_items SET ${sets.join(", ")} WHERE organization_id = ? AND id = ?`).run(...vals);
    return this.get(orgId, id);
  }

  /** Cancela (retenção: UPDATE status, nunca DELETE — RN-FR-9). */
  static cancel(orgId: string, id: string, actorId?: string): any {
    return this.update(orgId, id, { status: "canceled" }, actorId);
  }

  static get(orgId: string, id: string): any {
    return db.prepare(`SELECT * FROM recovery_debt_items WHERE organization_id = ? AND id = ?`).get(orgId, id) || null;
  }

  /** Lista (opcional filtro por status/category). Default esconde canceladas. */
  static list(orgId: string, opts: { status?: DebtStatus; category?: DebtCategory; includeCanceled?: boolean } = {}): any[] {
    const where: string[] = ["organization_id = ?"];
    const vals: any[] = [orgId];
    if (opts.status) { where.push("status = ?"); vals.push(opts.status); }
    else if (!opts.includeCanceled) where.push("status != 'canceled'");
    if (opts.category) { where.push("category = ?"); vals.push(opts.category); }
    return db.prepare(`SELECT * FROM recovery_debt_items WHERE ${where.join(" AND ")} ORDER BY (due_date IS NULL), due_date ASC, created_at ASC`).all(...vals) as any[];
  }

  /**
   * Resumo agregado do Mapa da Dívida (só obrigações ativas: open|renegotiating).
   * Honesto (RN-FR-1): agrega apenas valores CONHECIDOS; conta separadamente as linhas com
   * campo ausente pra `dataCompleteness` não fingir precisão. NÃO prioriza (RN-FR-4).
   */
  static summary(orgId: string): {
    itemsCount: number;
    totalKnown: number;
    totalOverdue: number;
    monthlyServiceKnown: number;
    monthlyServiceMissingCount: number;
    byCategory: { category: DebtCategory; count: number; total: number }[];
    dataCompleteness: "empty" | "partial" | "ok";
  } {
    const rows = this.list(orgId).filter((r) => r.status === "open" || r.status === "renegotiating");
    let totalKnown = 0, totalOverdue = 0, monthlyServiceKnown = 0, monthlyServiceMissingCount = 0;
    const cat = new Map<DebtCategory, { count: number; total: number }>();
    for (const r of rows) {
      totalKnown += Number(r.amount_total) || 0;
      totalOverdue += Number(r.amount_overdue) || 0;
      if (r.monthly_payment == null) monthlyServiceMissingCount++;
      else monthlyServiceKnown += Number(r.monthly_payment) || 0;
      const c = (r.category as DebtCategory);
      const acc = cat.get(c) || { count: 0, total: 0 };
      acc.count++; acc.total += Number(r.amount_total) || 0;
      cat.set(c, acc);
    }
    const byCategory = [...cat.entries()].map(([category, v]) => ({ category, ...v })).sort((a, b) => b.total - a.total);
    const dataCompleteness: "empty" | "partial" | "ok" =
      rows.length === 0 ? "empty" : monthlyServiceMissingCount > 0 ? "partial" : "ok";
    return { itemsCount: rows.length, totalKnown, totalOverdue, monthlyServiceKnown, monthlyServiceMissingCount, byCategory, dataCompleteness };
  }
}

export default RecoveryDebtService;
