import { randomUUID } from "crypto";
import db from "./db.js";
import { logAuthEvent } from "./auditLog.js";
import { FinancialLedgerService } from "./FinancialLedgerService.js";
import { SubscriptionService } from "./SubscriptionService.js";

/**
 * Legal Fee (ADR-191 F8) — HONORÁRIOS. COMPÕE o financeiro existente (D7), sem 2º razão:
 *  - FIXO  → um `receivable` (FinancialLedgerService), com `source_type='legal_fee'`.
 *  - AVENÇA (mensal) → um `subscription_plan` + `subscription` (SubscriptionService).
 *
 * `legal_fees` é só o ELO (processo/cliente ↔ instrumento financeiro) — a fonte da verdade
 * do dinheiro continua no razão/assinaturas. RN-ADV-07 (nunca inventa dinheiro): valor
 * acordado é OBRIGATÓRIO (>0); sem valor não cria (não fabrica 0). Honorário por-hora
 * (timesheet) e de êxito (success fee) ficam DEFERIDOS. Dinheiro é role-gated na rota (§73).
 * Isolado por organization_id.
 */

const nowISO = () => new Date().toISOString();
const round2 = (n: number) => Math.round(Number(n) * 100) / 100;

function caseRow(orgId: string, caseId: string): any {
  return db.prepare(`SELECT id, contact_id FROM legal_cases WHERE organization_id = ? AND id = ?`).get(orgId, caseId) || null;
}
function contactExists(orgId: string, contactId: string): boolean {
  return !!db.prepare(`SELECT id FROM contacts WHERE organization_id = ? AND id = ?`).get(orgId, contactId);
}

export interface FixedFeeInput {
  caseId?: string | null;
  contactId?: string | null;
  description: string;
  amount: number;
  dueDate: string;   // YYYY-MM-DD
}
export interface RetainerFeeInput {
  caseId?: string | null;
  contactId?: string | null;
  description: string;
  amount: number;    // mensal
  startDate?: string | null;
}

export class LegalFeeService {
  static get(orgId: string, id: string): any {
    return db.prepare(`SELECT * FROM legal_fees WHERE organization_id = ? AND id = ?`).get(orgId, id) || null;
  }

  static list(orgId: string, opts: { caseId?: string; contactId?: string; status?: string } = {}): any[] {
    const clauses = [`organization_id = ?`]; const args: any[] = [orgId];
    if (opts.caseId) { clauses.push(`case_id = ?`); args.push(opts.caseId); }
    if (opts.contactId) { clauses.push(`contact_id = ?`); args.push(opts.contactId); }
    if (opts.status) { clauses.push(`status = ?`); args.push(opts.status); }
    return db.prepare(`SELECT * FROM legal_fees WHERE ${clauses.join(" AND ")} ORDER BY (status = 'cancelled') ASC, created_at DESC`).all(...args) as any[];
  }

  /** Resolve o cliente (do processo, se houver) e valida. Nunca inventa. */
  private static resolveContact(orgId: string, caseId?: string | null, contactId?: string | null): { contactId: string; caseId: string | null } {
    let cid = contactId || null; let cs: any = null;
    if (caseId) {
      cs = caseRow(orgId, caseId);
      if (!cs) throw new Error("Processo não encontrado.");
      cid = cs.contact_id;
    }
    if (!cid) throw new Error("Informe o cliente (contactId) ou um processo.");
    if (!contactExists(orgId, cid)) throw new Error("Cliente não encontrado.");
    return { contactId: cid, caseId: caseId || null };
  }

  /** Honorário FIXO → recebível (reuso do razão). */
  static createFixed(orgId: string, input: FixedFeeInput, actorId: string | null = null): any {
    const desc = String(input?.description || "").trim();
    if (!desc) throw new Error("Descreva o honorário.");
    const amount = round2(input?.amount);
    if (!(amount > 0)) throw new Error("Valor do honorário é obrigatório (nunca inventa dinheiro).");
    const { contactId, caseId } = this.resolveContact(orgId, input.caseId, input.contactId);

    const id = randomUUID();
    const rec = FinancialLedgerService.addReceivable(orgId, {
      description: `Honorário: ${desc}`, amount, dueDate: input.dueDate, contactId,
      sourceType: "legal_fee", sourceId: id, createdBy: actorId || undefined,
    });
    if (!("ok" in rec) || !rec.ok) throw new Error("Não foi possível registrar o recebível (verifique data e valor).");
    const receivableId = (rec as any).id || null;

    db.prepare(
      `INSERT INTO legal_fees (id, organization_id, case_id, contact_id, fee_type, description, amount, status, receivable_id, created_by)
       VALUES (?, ?, ?, ?, 'fixo', ?, ?, 'active', ?, ?)`
    ).run(id, orgId, caseId, contactId, desc, amount, receivableId, actorId);
    logAuthEvent(orgId, actorId, contactId, "LEGAL_FEE_CREATED", { feeId: id, feeType: "fixo", amount, caseId });
    return this.get(orgId, id);
  }

  /** Honorário de AVENÇA mensal → plano + assinatura (reuso das assinaturas). */
  static createRetainer(orgId: string, input: RetainerFeeInput, actorId: string | null = null): any {
    const desc = String(input?.description || "").trim();
    if (!desc) throw new Error("Descreva a avença.");
    const amount = round2(input?.amount);
    if (!(amount > 0)) throw new Error("Valor mensal da avença é obrigatório (nunca inventa dinheiro).");
    const { contactId, caseId } = this.resolveContact(orgId, input.caseId, input.contactId);

    const plan = SubscriptionService.createPlan(orgId, { name: `Avença: ${desc}`, amount, interval: "monthly", interval_count: 1 });
    const sub = SubscriptionService.subscribe(orgId, { planId: plan.id, contactId, startDate: input.startDate || undefined, createdBy: actorId || undefined });

    const id = randomUUID();
    db.prepare(
      `INSERT INTO legal_fees (id, organization_id, case_id, contact_id, fee_type, description, amount, status, plan_id, subscription_id, created_by)
       VALUES (?, ?, ?, ?, 'avenca', ?, ?, 'active', ?, ?, ?)`
    ).run(id, orgId, caseId, contactId, desc, amount, plan.id, sub.id, actorId);
    logAuthEvent(orgId, actorId, contactId, "LEGAL_FEE_CREATED", { feeId: id, feeType: "avenca", amount, caseId, subscriptionId: sub.id });
    return this.get(orgId, id);
  }

  /** Marca o honorário fixo como recebido (delega ao razão — idempotente). */
  static markFixedPaid(orgId: string, id: string, opts: { date?: string; accountId?: string } = {}, actorId: string | null = null): any {
    const f = this.get(orgId, id);
    if (!f) throw new Error("Honorário não encontrado.");
    if (f.fee_type !== "fixo" || !f.receivable_id) throw new Error("Só honorário fixo tem recebível avulso — avença é cobrada por ciclo.");
    const r = FinancialLedgerService.receiveReceivable(orgId, f.receivable_id, { date: opts.date, accountId: opts.accountId, createdBy: actorId || undefined });
    if (!("ok" in r) || !r.ok) throw new Error("Recebível já recebido ou não encontrado.");
    logAuthEvent(orgId, actorId, f.contact_id, "LEGAL_FEE_PAID", { feeId: id });
    return this.get(orgId, id);
  }

  /** Cancela o honorário + o instrumento financeiro (recebível aberto / assinatura). */
  static cancel(orgId: string, id: string, actorId: string | null = null): any {
    const f = this.get(orgId, id);
    if (!f) throw new Error("Honorário não encontrado.");
    if (f.status === "cancelled") return f;
    if (f.fee_type === "fixo" && f.receivable_id) {
      // só cancela recebível AINDA aberto (recebido preserva o histórico de caixa).
      db.prepare(`UPDATE receivables SET status = 'canceled' WHERE organization_id = ? AND id = ? AND status = 'open'`).run(orgId, f.receivable_id);
    }
    if (f.fee_type === "avenca" && f.subscription_id) {
      try { SubscriptionService.setStatus(orgId, f.subscription_id, "cancelled"); } catch { /* best-effort */ }
    }
    db.prepare(`UPDATE legal_fees SET status = 'cancelled', updated_at = ? WHERE organization_id = ? AND id = ?`).run(nowISO(), orgId, id);
    logAuthEvent(orgId, actorId, f.contact_id, "LEGAL_FEE_CANCELLED", { feeId: id });
    return this.get(orgId, id);
  }

  /** Extrato financeiro por processo/cliente. RN-ADV-07: sem honorário → totais NULL (não R$ 0,00). */
  static statement(orgId: string, opts: { caseId?: string; contactId?: string }): any {
    const fees = this.list(orgId, { caseId: opts.caseId, contactId: opts.contactId, status: "active" });
    if (!fees.length) return { fees: [], agreedTotal: null, receivedTotal: null, openTotal: null };
    let agreed = 0, received = 0, open = 0;
    const items = fees.map((f) => {
      let state = "active", recAmount = f.amount;
      if (f.fee_type === "fixo" && f.receivable_id) {
        const r = db.prepare(`SELECT amount, status FROM receivables WHERE organization_id = ? AND id = ?`).get(orgId, f.receivable_id) as any;
        state = r?.status || "unknown"; recAmount = r ? r.amount : f.amount;
        agreed += recAmount;
        if (r?.status === "received") received += recAmount; else if (r?.status === "open") open += recAmount;
      } else if (f.fee_type === "avenca" && f.subscription_id) {
        // avença: soma faturas pagas × pendentes (fonte: subscription_invoices).
        const paid = (db.prepare(`SELECT COALESCE(SUM(amount),0) s FROM subscription_invoices WHERE organization_id = ? AND subscription_id = ? AND status = 'paid'`).get(orgId, f.subscription_id) as any).s;
        const pending = (db.prepare(`SELECT COALESCE(SUM(amount),0) s FROM subscription_invoices WHERE organization_id = ? AND subscription_id = ? AND status IN ('pending','overdue')`).get(orgId, f.subscription_id) as any).s;
        received += paid; open += pending; agreed += paid + pending;
        state = "recurring";
      }
      return { id: f.id, feeType: f.fee_type, description: f.description, monthlyOrTotal: f.amount, state };
    });
    return { fees: items, agreedTotal: round2(agreed), receivedTotal: round2(received), openTotal: round2(open) };
  }
}

export default LegalFeeService;
