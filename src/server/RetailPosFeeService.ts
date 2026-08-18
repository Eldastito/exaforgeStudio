/**
 * RetailPosFeeService — tarifas POS por loja × meio de pagamento (PDR TOULON,
 * Fatia 3 / POS-001..005, §7.5).
 *
 * Detalha a tarifa da maquininha por CRÉDITO/DÉBITO (percent + fixo por
 * transação). REGRA DURA (RN §6/§8): quando existe regra detalhada, ela
 * SUBSTITUI a tarifa agregada legada (`card_fee` em retail_store_variable_costs)
 * no cálculo — NUNCA soma as duas (evita dupla contabilização).
 *
 * `expectedCost` calcula o custo esperado das tarifas a partir do resumo do POS
 * (valor + qtd por meio), com a fórmula e a origem (detailed|legacy) explícitas.
 *
 * Determinístico; isolado por organization_id.
 */
import { randomUUID } from "crypto";
import db from "./db.js";
import { logAuthEvent } from "./auditLog.js";

const round2 = (n: any) => Math.round((Number(n) || 0) * 100) / 100;
const PAYMENT_TYPES = ["credit", "debit"] as const;
type PaymentType = (typeof PAYMENT_TYPES)[number];

export class RetailPosFeeService {
  /** Regras detalhadas VIGENTES da loja (crédito/débito) + se há alguma. */
  static rules(orgId: string, storeId: string): any {
    const rows = db.prepare(
      `SELECT payment_type, percent, fixed_per_transaction, provider FROM retail_store_pos_fee_rules
        WHERE organization_id = ? AND store_id = ? AND effective_to IS NULL`
    ).all(orgId, storeId) as any[];
    const byType: Record<string, any> = {};
    for (const r of rows) byType[r.payment_type] = { percent: round2(r.percent), fixedPerTransaction: round2(r.fixed_per_transaction), provider: r.provider || null };
    return { credit: byType.credit || null, debit: byType.debit || null, hasDetailed: rows.length > 0 };
  }

  /**
   * Define as tarifas detalhadas (owner/admin). Fecha a regra vigente (histórico:
   * effective_to) e insere a nova. Só mexe nos tipos enviados. `null` num tipo
   * remove a regra detalhada dele (volta ao legado, se não sobrar detalhada).
   */
  static set(orgId: string, storeId: string, payload: { credit?: any; debit?: any; provider?: string | null }, actorId?: string): any {
    if (!db.prepare(`SELECT 1 FROM retail_stores WHERE organization_id = ? AND id = ?`).get(orgId, storeId)) throw new Error("Loja não encontrada.");
    const provider = payload.provider != null ? String(payload.provider).slice(0, 80) : null;
    const tx = db.transaction(() => {
      for (const pt of PAYMENT_TYPES) {
        if (!(pt in payload)) continue;
        const val = (payload as any)[pt];
        // fecha a vigente
        db.prepare(`UPDATE retail_store_pos_fee_rules SET effective_to = CURRENT_TIMESTAMP WHERE organization_id = ? AND store_id = ? AND payment_type = ? AND effective_to IS NULL`).run(orgId, storeId, pt);
        if (val == null) continue; // remover a regra detalhada deste tipo
        const percent = Number(val.percent);
        const fixed = Number(val.fixedPerTransaction ?? val.fixed);
        if (!Number.isFinite(percent) || percent < 0 || percent > 100) throw new Error(`Percentual de ${pt} inválido (0 a 100).`);
        if (!Number.isFinite(fixed) || fixed < 0) throw new Error(`Tarifa fixa de ${pt} inválida.`);
        db.prepare(
          `INSERT INTO retail_store_pos_fee_rules (id, organization_id, store_id, payment_type, percent, fixed_per_transaction, provider, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(randomUUID(), orgId, storeId, pt, round2(percent), round2(fixed), provider, actorId || null);
      }
    });
    tx();
    try { logAuthEvent(orgId, actorId || "system", storeId, "RETAIL_POS_FEE_SET", { provider }); } catch { /* noop */ }
    return this.rules(orgId, storeId);
  }

  /** Tarifa agregada legada (card_fee) da loja — fallback quando não há detalhada. */
  private static legacyCardFee(orgId: string, storeId: string): { percent: number; fixedPerSale: number } {
    const r = db.prepare(`SELECT percent, fixed_per_sale FROM retail_store_variable_costs WHERE organization_id = ? AND store_id = ? AND category = 'card_fee'`).get(orgId, storeId) as any;
    return { percent: round2(r?.percent || 0), fixedPerSale: round2(r?.fixed_per_sale || 0) };
  }

  /**
   * POS-003 — custo esperado das tarifas a partir do resumo do POS. Precedência:
   * regra DETALHADA (crédito/débito) substitui a legada; NUNCA soma as duas.
   */
  static expectedCost(orgId: string, storeId: string, input: { creditValue?: number; creditQty?: number; debitValue?: number; debitQty?: number }): any {
    const cv = Number(input.creditValue) || 0, cq = Math.trunc(Number(input.creditQty) || 0);
    const dv = Number(input.debitValue) || 0, dq = Math.trunc(Number(input.debitQty) || 0);
    const rules = this.rules(orgId, storeId);

    if (rules.hasDetailed) {
      const line = (rule: any, value: number, qty: number) => {
        if (!rule) return { cost: 0, percent: 0, fixed: 0, applied: false };
        const cost = round2(value * (rule.percent / 100) + qty * rule.fixedPerTransaction);
        return { cost, percent: rule.percent, fixed: rule.fixedPerTransaction, applied: true };
      };
      const credit = line(rules.credit, cv, cq);
      const debit = line(rules.debit, dv, dq);
      return {
        basis: "detailed",
        credit, debit,
        total: round2(credit.cost + debit.cost),
        provider: rules.credit?.provider || rules.debit?.provider || null,
        formula: "valor × percentual + qtd × tarifa fixa (por meio de pagamento)",
        note: (!rules.credit || !rules.debit) ? "Configure crédito E débito para o custo esperado cobrir os dois — o meio sem regra detalhada não é tarifado aqui." : null,
      };
    }
    // Fallback legado (card_fee agregado): aplica sobre o total, sem distinguir meio.
    const legacy = this.legacyCardFee(orgId, storeId);
    const totalValue = round2(cv + dv), totalQty = cq + dq;
    const cost = round2(totalValue * (legacy.percent / 100) + totalQty * legacy.fixedPerSale);
    return {
      basis: legacy.percent > 0 || legacy.fixedPerSale > 0 ? "legacy" : "none",
      legacy: { percent: legacy.percent, fixedPerSale: legacy.fixedPerSale },
      total: cost,
      formula: "valor total × percentual + qtd total × tarifa fixa (taxa de cartão agregada)",
      note: "Tarifa agregada (card_fee). Configure crédito/débito para separar as taxas.",
    };
  }
}

export default RetailPosFeeService;
