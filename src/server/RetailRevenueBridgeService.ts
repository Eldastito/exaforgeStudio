import db from "./db.js";

/**
 * Ponte Fechamento → Faturamento (Operação da Rede → Motor de Caixa / Diretor).
 *
 * Problema: hoje a venda do fechamento diário de loja alimenta SÓ a aba Operação
 * da Rede (divergência/comissão/metas). Ela não vira caixa/receita, então o
 * Diretor IA / Pareto / DRE reportam faturamento R$ 0 para uma loja
 * supervisionada — o `FinancialLedgerService.syncFromSales` só posta `orders`
 * (pago) e `comigo_orders`, e `LossMarginService.monthlyRevenue` só soma esses.
 *
 * Esta ponte expõe os fechamentos "elegíveis" para que o Motor de Caixa os poste
 * como ENTRADA de caixa (idempotente por fechamento) e para que a receita mensal
 * os inclua. É OPT-IN por organização (coluna `retail_revenue_bridge`, default
 * off): nada muda até o gestor ligar.
 *
 * Fronteira: SÓ lê (db). Quem posta o `cash_events` é o `FinancialLedgerService`
 * (evita dependência circular). Determinístico, zero-token, isolado por org.
 *
 * Elegibilidade: fechamentos em status `approved` (aprovação humana), `reconciled`
 * ou `divergent` (conciliados com o PDV via import) — ou seja, ou um humano
 * aprovou, ou o sistema do PDV confirmou. Valor = `system_total` quando houver
 * (verdade do PDV), senão `informed_total`. Só conta valor > 0.
 */

const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

// Fechamentos cujo total de venda é confiável (humano aprovou OU PDV conciliou).
const ELIGIBLE_STATUSES = "('approved','reconciled','divergent')";
// Prefere o total do sistema (PDV) quando presente; senão o informado pela loja.
const VALUE_EXPR = "COALESCE(NULLIF(system_total, 0), informed_total)";

export interface BridgeClosing { id: string; store_id: string; closing_date: string; value: number; }

export class RetailRevenueBridgeService {
  /** Flag opt-in por organização (default off). */
  static isEnabled(orgId: string): boolean {
    try {
      const r = db.prepare("SELECT retail_revenue_bridge FROM organization_settings WHERE organization_id = ?").get(orgId) as any;
      return !!Number(r?.retail_revenue_bridge);
    } catch { return false; }
  }

  static setEnabled(orgId: string, on: boolean): boolean {
    db.prepare("UPDATE organization_settings SET retail_revenue_bridge = ? WHERE organization_id = ?").run(on ? 1 : 0, orgId);
    return this.isEnabled(orgId);
  }

  /**
   * Fechamentos elegíveis a virar entrada de caixa. Cada um = 1 loja/dia (a
   * própria PK do fechamento é a chave de idempotência no `cash_events`).
   */
  static eligibleClosings(orgId: string): BridgeClosing[] {
    try {
      const rows = db.prepare(
        `SELECT id, store_id, closing_date, ${VALUE_EXPR} AS value
           FROM retail_daily_closings
          WHERE organization_id = ? AND status IN ${ELIGIBLE_STATUSES} AND ${VALUE_EXPR} > 0`
      ).all(orgId) as any[];
      return rows.map((r) => ({ id: String(r.id), store_id: String(r.store_id), closing_date: String(r.closing_date).slice(0, 10), value: round2(r.value) }));
    } catch { return []; }
  }

  /** Faturamento do mês vindo dos fechamentos elegíveis (para a receita da DRE/margem). */
  static monthlyRevenue(orgId: string, period: string): number {
    try {
      const r = db.prepare(
        `SELECT COALESCE(SUM(${VALUE_EXPR}), 0) s
           FROM retail_daily_closings
          WHERE organization_id = ? AND status IN ${ELIGIBLE_STATUSES}
            AND strftime('%Y-%m', closing_date) = ?`
      ).get(orgId, period) as any;
      return round2(r.s);
    } catch { return 0; }
  }
}
