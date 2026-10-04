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
import { BusinessSignalService } from "./BusinessSignalService.js";

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
    this.closeDispute(orgId, store.id, store.name, input.month, `A meta de ${input.month} da loja ${store.name} foi corrigida pelo dono para R$ ${v.toLocaleString("pt-BR", { minimumFractionDigits: 2 })}.`);
    return { storeId: store.id, storeName: store.name, month: input.month, goalAmount: v };
  }

  private static disputeKey(storeId: string, month: string) { return `monthly_goal_disputed:${storeId}:${month}`; }

  /**
   * O gerente CONFERE a meta mensal da própria loja (quem define é o dono — `requireNetworkScope`). Se está errada, ele
   * avisa: nasce um sinal na espinha (business_signals, nunca tabela de alerta própria) ligado à loja — o dono vê em
   * Hoje/Central de Saúde e o gerente da loja vê o status — dizendo O QUE, ONDE e o que FAZER. Idempotente por loja+mês.
   * Nunca altera a meta: corrigir é do dono (e, ao corrigir, o aviso é fechado e a loja é avisada).
   */
  static dispute(orgId: string, input: { storeId: string; month: string; note: string }, actorId?: string | null): { ok: true; id: string } {
    if (!MONTH_RE.test(String(input.month))) throw new Error("month deve ser YYYY-MM");
    const note = String(input.note || "").trim().slice(0, 300);
    if (note.length < 3) throw new Error("Explique o que está errado (ex.: \"a meta é R$ 80.000, não 60.000\").");
    const store = db.prepare(`SELECT id, name FROM retail_stores WHERE organization_id = ? AND id = ?`).get(orgId, input.storeId) as any;
    if (!store) throw new Error("Loja não encontrada.");
    const who = String((actorId && (db.prepare("SELECT name FROM users WHERE organization_id = ? AND id = ?").get(orgId, actorId) as any)?.name) || "O gerente");
    const current = this.get(orgId, store.id, input.month);
    const r = BusinessSignalService.publish(orgId, {
      domain: "retail_ops", signalType: "retail_monthly_goal_disputed", severity: "attention", basis: "fact", confidence: 1,
      sourceService: "RetailMonthlyGoalService", sourceEntityType: "retail_store", sourceEntityId: store.id,
      evidence: {
        store: store.name, month: input.month, currentGoal: current, note, reportedBy: who,
        what: `${who} diz que a meta de ${input.month} da loja ${store.name} está errada (hoje: ${current == null ? "sem meta cadastrada" : `R$ ${current.toLocaleString("pt-BR", { minimumFractionDigits: 2 })}`}). Motivo: ${note}`,
        where: "Operação da Rede → Equipe → Escala & cotas → Meta mensal por loja",
        todo: "Confira com o gerente e corrija a meta da loja. Quando você salvar, este aviso fecha sozinho e a loja é avisada.",
      },
      dedupeKey: this.disputeKey(store.id, input.month),
    } as any);
    try { logAuthEvent(orgId, actorId || "system", store.id, "RETAIL_MONTHLY_GOAL_DISPUTED", { storeId: store.id, month: input.month }); } catch { /* noop */ }
    return { ok: true, id: r.id };
  }

  /** Dono corrigiu/removeu a meta: fecha a contestação aberta (se havia) e avisa a loja do resultado. */
  private static closeDispute(orgId: string, storeId: string, storeName: string, month: string, message: string): void {
    try {
      const closed = BusinessSignalService.resolveByDedupe(orgId, this.disputeKey(storeId, month));
      if (!closed.ok) return;
      BusinessSignalService.publish(orgId, {
        domain: "retail_ops", signalType: "retail_monthly_goal_dispute_resolved", severity: "info", basis: "fact", confidence: 1,
        sourceService: "RetailMonthlyGoalService", sourceEntityType: "retail_store", sourceEntityId: storeId,
        evidence: { store: storeName, month, what: message, where: "Operação da Rede → Equipe → Escala & cotas → Meta mensal por loja", todo: "Confira o valor novo. Nada a fazer se estiver certo." },
        dedupeKey: `monthly_goal_dispute_resolved:${storeId}:${month}:${Date.now()}`,
      } as any);
    } catch { /* aviso é best-effort */ }
  }

  static clear(orgId: string, storeId: string, month: string, actorId?: string | null): boolean {
    if (!MONTH_RE.test(month)) throw new Error("month deve ser YYYY-MM");
    const r = db.prepare(`DELETE FROM retail_store_monthly_goals WHERE organization_id = ? AND store_id = ? AND month = ?`).run(orgId, storeId, month);
    if (r.changes) {
      try { logAuthEvent(orgId, actorId || "system", storeId, "RETAIL_MONTHLY_GOAL_CLEARED", { storeId, month }); } catch { /* noop */ }
      const st = db.prepare(`SELECT name FROM retail_stores WHERE organization_id = ? AND id = ?`).get(orgId, storeId) as any;
      this.closeDispute(orgId, storeId, String(st?.name || "loja"), month, `A meta de ${month} da loja ${st?.name || ""} foi removida pelo dono.`);
    }
    return r.changes > 0;
  }
}

export default RetailMonthlyGoalService;
