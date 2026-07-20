import db from "./db.js";
import { RevenueIntelligenceService } from "./RevenueIntelligenceService.js";
import { AnalyticsService } from "./AnalyticsService.js";
import { RetailImpactService } from "./RetailImpactService.js";

/**
 * Performance fee (ADR-091 §6, Bloco C) — modo BETA: MOSTRA o valor, NÃO cobra.
 *
 * Decisão de campo (Emerson, jul/26): o "ganho incremental" é medido por
 * ATRIBUIÇÃO POR DRIVER — só a MARGEM recuperada diretamente atribuída aos
 * mecanismos do ZappFlow (carrinho abandonado, lembrete de PIX, cadência/
 * follow-up), reusando o motor de atribuição única do RevenueIntelligence.
 * NÃO usa delta vs linha de base (poluído por sazonalidade — ADR §170).
 *
 * A economia por reposição inteligente (Compras) hoje só é ESTIMÁVEL: entra no
 * painel como valor estimado SEPARADO e NUNCA na conta dos 2% (regra
 * provado≠estimado do ADR-085).
 *
 * Taxa = 2% do ganho incremental provado. Beta obrigatório nos 6 primeiros
 * meses + consentimento explícito e revogável para (um dia) cobrar.
 */
export class PerformanceFeeService {
  static FEE_PERCENT = 2;
  static BETA_MONTHS = 6;
  static DEFAULT_MARGIN_PCT = 30; // fallback quando a org não registra custo (ADR-085)

  private static round2(n: number) { return Math.round((Number(n) || 0) * 100) / 100; }
  private static round1(n: number) { return Math.round((Number(n) || 0) * 10) / 10; }

  private static currentMonth(): string {
    const d = new Date();
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  }

  /** Consentimento de cobrança (opt-in explícito, revogável). */
  static getConsent(orgId: string): { enabled: boolean; consentedAt: string | null; revokedAt: string | null } {
    const o = db.prepare(`SELECT performance_fee_billing_enabled AS e, performance_fee_consented_at AS c, performance_fee_revoked_at AS r FROM organization_settings WHERE organization_id = ?`).get(orgId) as any || {};
    return { enabled: !!o.e, consentedAt: o.c || null, revokedAt: o.r || null };
  }

  static setConsent(orgId: string, enabled: boolean): { enabled: boolean } {
    if (enabled) db.prepare(`UPDATE organization_settings SET performance_fee_billing_enabled = 1, performance_fee_consented_at = CURRENT_TIMESTAMP, performance_fee_revoked_at = NULL WHERE organization_id = ?`).run(orgId);
    else db.prepare(`UPDATE organization_settings SET performance_fee_billing_enabled = 0, performance_fee_revoked_at = CURRENT_TIMESTAMP WHERE organization_id = ?`).run(orgId);
    return { enabled };
  }

  /** Nos 6 primeiros meses da conta, é beta obrigatório (mostra, não cobra). */
  private static inBetaWindow(orgId: string): boolean {
    const o = db.prepare(`SELECT created_at FROM organization_settings WHERE organization_id = ?`).get(orgId) as any;
    if (!o?.created_at) return true;
    const months = (Date.now() - new Date(o.created_at).getTime()) / (30 * 86400000);
    return months < this.BETA_MONTHS;
  }

  /**
   * Calcula o valor gerado + fee (mostrado) para um período ('month' = mês
   * corrente; 'all' = desde o início). Nunca cobra aqui — só computa e informa.
   */
  static compute(orgId: string, period: "month" | "all" = "month") {
    const rec = RevenueIntelligenceService.recoveredBreakdown(orgId, period) as any; // {total, sources, attributionWindowDays}
    const profit = AnalyticsService.getProfit(orgId, { period } as any) as any;
    const marginProven = !!profit?.hasCostData;
    const marginPct = marginProven ? Number(profit.margin) : this.DEFAULT_MARGIN_PCT;
    const marginFrac = Math.max(0, Math.min(100, marginPct)) / 100;

    const drivers = (rec?.sources || [])
      .filter((s: any) => Number(s.amount) > 0)
      .map((s: any) => ({
        key: s.key,
        label: s.label,
        orders: s.orders,
        recoveredRevenue: this.round2(s.amount),
        recoveredMargin: this.round2(Number(s.amount) * marginFrac),
      }));
    const incrementalGain = this.round2(drivers.reduce((a: number, d: any) => a + d.recoveredMargin, 0));
    const fee = this.round2(incrementalGain * this.FEE_PERCENT / 100);

    // Economia de reposição — ESTIMADA e SEPARADA (nunca entra no ganho/fee).
    let estimatedReposicao = 0;
    try { const est = RetailImpactService.estimated(orgId, this.currentMonth()); estimatedReposicao = this.round2(est?.rupturaEvitada?.amount || 0); } catch (e) { /* sem dados de varejo */ }

    const consent = this.getConsent(orgId);
    const beta = this.inBetaWindow(orgId) || !consent.enabled; // beta = MOSTRA, não cobra

    return {
      period,
      marginPercent: this.round1(marginPct),
      marginProven,
      attributionWindowDays: rec?.attributionWindowDays ?? null,
      drivers,
      recoveredRevenue: this.round2(rec?.total || 0),
      incrementalGain,          // margem recuperada PROVADA (base dos 2%)
      feePercent: this.FEE_PERCENT,
      fee,                      // 2% do ganho — SEMPRE mostrado; cobrado só fora do beta
      beta,                     // true = não cobra (beta ou sem consentimento)
      consented: !!consent.enabled,
      estimated: { reposicao: estimatedReposicao }, // separado, fora do fee
    };
  }
}
