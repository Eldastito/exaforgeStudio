import db from "./db.js";
import { v4 as uuidv4 } from "uuid";

/**
 * Consumo excedente de IA (ADR-091 §4, Bloco D). Quando a org atinge o limite
 * mensal de "ações de IA" do plano, pode comprar um PACOTE EXTRA (pay-as-you-go,
 * sem forçar upgrade) — ou ligar a recompra automática ao atingir 90%.
 *
 * A folga extra vale só no MÊS da compra (ledger `ai_topup_credits`). Fica
 * decoupled do PlanService (lê o plano/uso direto) pra evitar import circular:
 * PlanService.aiAllowed chama ConsumptionService, nunca o contrário.
 *
 * A cobrança real (fatura avulsa via ASAAS) é plugada quando o Bloco B estiver
 * ligado; aqui o crédito é registrado na compra (modo beta/mock).
 */
export class ConsumptionService {
  // Pacote extra por plano (ADR-091 §4). Enterprise = negociado (sem pacote fixo).
  static EXTRA_PACKAGES: Record<string, { actions: number; price: number }> = {
    autonomo: { actions: 2000, price: 200 },
    start: { actions: 5000, price: 400 },
    growth: { actions: 15000, price: 1000 },
    scale: { actions: 50000, price: 2500 },
  };

  private static currentMonth(): string {
    const d = new Date();
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  }

  private static org(orgId: string): any {
    return db.prepare(`SELECT plan_id, ai_auto_topup_enabled FROM organization_settings WHERE organization_id = ?`).get(orgId) as any || {};
  }

  /** Limite base de ações do plano (0 = ilimitado). */
  private static baseLimit(planId?: string): number {
    if (!planId) return 0;
    const p = db.prepare(`SELECT features FROM plans WHERE id = ?`).get(planId) as any;
    if (!p) return 0;
    try { return Number(JSON.parse(p.features || "{}").ai_monthly_limit || 0); } catch { return 0; }
  }

  /** Ações de IA usadas no mês (mesma contagem do PlanService.getUsage). */
  private static usedThisMonth(orgId: string): number {
    const r = db.prepare(`SELECT COUNT(*) AS c FROM ai_interactions_log WHERE organization_id = ? AND created_at >= datetime('now','start of month')`).get(orgId) as any;
    return Number(r?.c || 0);
  }

  /** Ações extras compradas no mês corrente. */
  private static topupActionsThisMonth(orgId: string): number {
    const r = db.prepare(`SELECT COALESCE(SUM(actions),0) AS s FROM ai_topup_credits WHERE organization_id = ? AND month = ?`).get(orgId, this.currentMonth()) as any;
    return Number(r?.s || 0);
  }

  /** Folga total do mês = limite do plano + pacotes extras (0 = ilimitado). */
  static getAllowance(orgId: string): number {
    const base = this.baseLimit(this.org(orgId).plan_id);
    if (base <= 0) return 0; // ilimitado — pacote não se aplica
    return base + this.topupActionsThisMonth(orgId);
  }

  /** Pacote extra disponível para o plano da org (null se não há). */
  static packageFor(orgId: string): { actions: number; price: number } | null {
    return this.EXTRA_PACKAGES[this.org(orgId).plan_id] || null;
  }

  /** Compra 1 pacote extra (credita no ledger do mês). Retorna null se sem pacote. */
  static buyTopup(orgId: string, source: "manual" | "auto" = "manual"): { actions: number; amount: number } | null {
    const pkg = this.packageFor(orgId);
    if (!pkg) return null;
    db.prepare(`INSERT INTO ai_topup_credits (id, organization_id, month, actions, amount, source) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(uuidv4(), orgId, this.currentMonth(), pkg.actions, pkg.price, source);
    return { actions: pkg.actions, amount: pkg.price };
  }

  static setAutoTopup(orgId: string, enabled: boolean): { enabled: boolean } {
    db.prepare(`UPDATE organization_settings SET ai_auto_topup_enabled = ? WHERE organization_id = ?`).run(enabled ? 1 : 0, orgId);
    return { enabled };
  }

  /**
   * Recompra automática (opt-in): ao cruzar 90% da folga atual, compra 1 pacote.
   * Auto-limitante — depois da compra a folga sobe e o uso cai abaixo de 90%,
   * então não recompra em loop. Retorna o pacote comprado (ou null).
   */
  static maybeAutoTopup(orgId: string): { actions: number; amount: number } | null {
    const o = this.org(orgId);
    if (!o.ai_auto_topup_enabled) return null;
    const allowance = this.getAllowance(orgId);
    if (allowance <= 0) return null;
    const used = this.usedThisMonth(orgId);
    if (used >= allowance) return null;              // já estourou — recompra manual/limite trata
    if (used < Math.floor(allowance * 0.9)) return null; // ainda não chegou a 90%
    return this.buyTopup(orgId, "auto");
  }

  /**
   * Chamado pelo enforcement (aiAllowed): roda a recompra automática e devolve a
   * situação atual (uso vs folga) para a decisão de bloqueio.
   */
  static enforce(orgId: string): { used: number; allowance: number } {
    this.maybeAutoTopup(orgId);
    return { used: this.usedThisMonth(orgId), allowance: this.getAllowance(orgId) };
  }

  /** Situação de consumo para a UI. */
  static status(orgId: string) {
    const o = this.org(orgId);
    const base = this.baseLimit(o.plan_id);
    const topup = this.topupActionsThisMonth(orgId);
    const allowance = base > 0 ? base + topup : 0;
    const used = this.usedThisMonth(orgId);
    return {
      used,
      baseLimit: base,
      topupActions: topup,
      allowance,                         // 0 = ilimitado
      pct: allowance > 0 ? Math.min(999, Math.round((used / allowance) * 100)) : 0,
      autoTopupEnabled: !!o.ai_auto_topup_enabled,
      package: this.packageFor(orgId),   // null se o plano não tem pacote
    };
  }
}
