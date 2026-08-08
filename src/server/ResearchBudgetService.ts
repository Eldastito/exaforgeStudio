import db from "./db.js";
import { randomUUID } from "crypto";

/**
 * ResearchBudgetService (ADR-156 D6, DI-4.2) — orçamento de pesquisa de
 * PLATAFORMA. Como a pesquisa é disparada pelo admin master (D5), o gasto é de
 * plataforma (1 pesquisa/nicho amortizada), não por-tenant.
 *
 * É o GUARDRAIL que precede o provider real (DI-4.4): entra antes de existir
 * gasto de verdade, para que a DI-4.4 não dispare custo sem teto. O gasto do mês
 * é DERIVADO por SUM(cost_cents) do `research_usage_log` (RN-004 — nunca contador
 * mutável). Budget em `platform_settings.research_monthly_budget_cents`
 * (0 = ilimitado). Isolamento não se aplica (é plataforma, sem org).
 */

const BUDGET_KEY = "research_monthly_budget_cents";

export class ResearchBudgetService {
  /** Teto mensal em centavos (0 = ilimitado). */
  static getBudgetCents(): number {
    const row = db.prepare("SELECT value FROM platform_settings WHERE key = ?").get(BUDGET_KEY) as any;
    return Math.max(0, parseInt(row?.value ?? "0", 10) || 0);
  }

  /** Define o teto mensal (só admin master, na camada de rota). */
  static setBudgetCents(cents: number): { budgetCents: number } {
    const v = String(Math.max(0, Math.floor(Number(cents) || 0)));
    db.prepare(`INSERT INTO platform_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`).run(BUDGET_KEY, v);
    return { budgetCents: Number(v) };
  }

  /** Gasto de pesquisa no mês corrente (derivado). */
  static spentThisMonthCents(): number {
    const row = db.prepare("SELECT COALESCE(SUM(cost_cents),0) s FROM research_usage_log WHERE created_at >= datetime('now','start of month')").get() as any;
    return Number(row?.s) || 0;
  }

  /** Situação do orçamento: gasto, teto, restante, %, esgotado?. */
  static status(): { budgetCents: number; spentCents: number; remainingCents: number; pct: number | null; exhausted: boolean; unlimited: boolean } {
    const budget = this.getBudgetCents();
    const spent = this.spentThisMonthCents();
    const unlimited = budget === 0;
    const remaining = unlimited ? Infinity : Math.max(0, budget - spent);
    const pct = unlimited ? null : Math.min(100, Math.round((spent / budget) * 100));
    return {
      budgetCents: budget, spentCents: spent,
      remainingCents: unlimited ? -1 : remaining,   // -1 sinaliza ilimitado no JSON
      pct, exhausted: !unlimited && spent >= budget, unlimited,
    };
  }

  /** Pode disparar uma nova pesquisa agora? (bloqueia se o teto já estourou.) */
  static canSpend(): boolean {
    return !this.status().exhausted;
  }

  /** Registra o custo de uma chamada ao provider (append-only). */
  static record(entry: { fingerprint?: string; vertical?: string; topic?: string; provider?: string; costCents: number }): void {
    db.prepare(`INSERT INTO research_usage_log (id, fingerprint, vertical, topic, provider, cost_cents) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(randomUUID(), entry.fingerprint || null, entry.vertical || null, entry.topic || null, entry.provider || null, Math.max(0, Math.floor(Number(entry.costCents) || 0)));
  }
}

export default ResearchBudgetService;
