/**
 * RetailMonthlyGoalService — META MENSAL por loja e competência como DADO (PRD Fase 1 §12).
 *
 * Antes não existia "meta mensal" em lugar nenhum: só a cota DIÁRIA (`retail_store_quotas`, vinda da planilha/distribuição)
 * e o resumo da noite dividia o acumulado do mês pela SOMA DAS COTAS DIÁRIAS. O dono confirmou metas mensais por loja
 * (ex.: Carioca R$ 60.000) — agora há onde cadastrá-las, sem inventar nenhuma.
 *  - NÃO substitui nem recalcula a cota diária: "a distribuição diária continua vindo da configuração/planilha válida —
 *    NÃO meta mensal ÷ dias". Esta tabela só alimenta o denominador "Mês X / R$ meta" do fechamento da noite.
 *  - Sem meta cadastrada → `null` (nunca 0): o resumo cai pro comportamento anterior (soma das cotas).
 *  - Valor precisa ser > 0 (meta 0 não existe); pra tirar a meta, `clear`. Loja tem que ser da org (isolamento).
 *  - Escrita é decisão do dono/co-admin sem loja (quem define a meta da rede) — a rota é `requireNetworkScope`.
 * Isola por organization_id. Sem LLM.
 */
import { randomUUID } from "crypto";
import db from "./db.js";
import { logAuthEvent } from "./auditLog.js";

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const round2 = (n: number) => Math.round(n * 100) / 100;

export type MonthlyGoal = { storeId: string; storeName: string | null; month: string; goalAmount: number };

export class RetailMonthlyGoalService {
  /** Metas da competência por loja (só as cadastradas). */
  static list(orgId: string, month: string): MonthlyGoal[] {
    if (!MONTH_RE.test(month)) throw new Error("month deve ser YYYY-MM");
    return (db.prepare(
      `SELECT g.store_id, s.name AS store_name, g.month, g.goal_amount FROM retail_store_monthly_goals g
         LEFT JOIN retail_stores s ON s.organization_id = g.organization_id AND s.id = g.store_id
        WHERE g.organization_id = ? AND g.month = ? ORDER BY s.name`,
    ).all(orgId, month) as any[]).map((r) => ({ storeId: r.store_id, storeName: r.store_name || null, month: r.month, goalAmount: Number(r.goal_amount) }));
  }

  /** Meta da loja na competência, ou `null` (não cadastrada ≠ zero). */
  static get(orgId: string, storeId: string, month: string): number | null {
    const r = db.prepare(`SELECT goal_amount FROM retail_store_monthly_goals WHERE organization_id = ? AND store_id = ? AND month = ?`).get(orgId, storeId, month) as any;
    const v = r ? Number(r.goal_amount) : NaN;
    return Number.isFinite(v) && v > 0 ? v : null;
  }

  /** Mapa storeId → meta (só cadastradas) pra consumo em lote (resumo da noite). */
  static map(orgId: string, month: string): Map<string, number> {
    const m = new Map<string, number>();
    for (const g of this.list(orgId, month)) if (g.goalAmount > 0) m.set(g.storeId, g.goalAmount);
    return m;
  }

  static set(orgId: string, input: { storeId: string; month: string; goalAmount: unknown }, actorId?: string | null): MonthlyGoal {
    if (!MONTH_RE.test(String(input.month))) throw new Error("month deve ser YYYY-MM");
    const amount = typeof input.goalAmount === "number" ? input.goalAmount : Number(String(input.goalAmount ?? "").replace(",", "."));
    if (!Number.isFinite(amount) || amount <= 0) throw new Error("A meta mensal precisa ser maior que zero (pra remover, apague a meta).");
    const store = db.prepare(`SELECT id, name FROM retail_stores WHERE organization_id = ? AND id = ?`).get(orgId, input.storeId) as any;
    if (!store) throw new Error("Loja não encontrada.");
    const v = round2(amount);
    db.prepare(
      `INSERT INTO retail_store_monthly_goals (id, organization_id, store_id, month, goal_amount, created_by)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (organization_id, store_id, month) DO UPDATE SET goal_amount = excluded.goal_amount, updated_at = CURRENT_TIMESTAMP`,
    ).run(randomUUID(), orgId, store.id, input.month, v, actorId || null);
    try { logAuthEvent(orgId, actorId || "system", store.id, "RETAIL_MONTHLY_GOAL_SET", { storeId: store.id, month: input.month, goalAmount: v }); } catch { /* noop */ }
    return { storeId: store.id, storeName: store.name, month: input.month, goalAmount: v };
  }

  static clear(orgId: string, storeId: string, month: string, actorId?: string | null): boolean {
    if (!MONTH_RE.test(month)) throw new Error("month deve ser YYYY-MM");
    const r = db.prepare(`DELETE FROM retail_store_monthly_goals WHERE organization_id = ? AND store_id = ? AND month = ?`).run(orgId, storeId, month);
    if (r.changes) { try { logAuthEvent(orgId, actorId || "system", storeId, "RETAIL_MONTHLY_GOAL_CLEARED", { storeId, month }); } catch { /* noop */ } }
    return r.changes > 0;
  }
}

export default RetailMonthlyGoalService;
