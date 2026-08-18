/**
 * RetailFeatureFlagService — kill-switches de RUNTIME das mudanças de maior risco
 * do PDR TOULON (Fase 6B). Permitem reverter, POR ORGANIZAÇÃO e sem deploy, para
 * o comportamento legado durante o piloto, caso a correção nova regrida algo.
 *
 * Semântica: DEFAULT LIGADO (comportamento NOVO). Setar 0 volta pro legado.
 *   - `retail_business_date_v1`             → data comercial no fuso (Fatia 1A);
 *                                             0 = volta ao UTC (bug original).
 *   - `retail_analytics_resolved_products_v1` → analíticas consomem a coluna
 *                                             resolvida (Fatia 4A/4B); 0 = volta
 *                                             ao LIKE-prefix por consulta (lento).
 *
 * Coluna ausente (org sem migração) ou linha inexistente → LIGADO (não regride).
 * Isolado por organization_id.
 */
import db from "./db.js";

// Só estas colunas podem ser lidas/escritas (evita SQL dinâmico arbitrário).
const FLAG_COLUMNS = {
  business_date: "retail_business_date_v1",
  resolved_products: "retail_analytics_resolved_products_v1",
} as const;
export type RetailFlagKey = keyof typeof FLAG_COLUMNS;

export class RetailFeatureFlagService {
  /** Data comercial no fuso da org ligada? (default true). */
  static businessDateV1(orgId: string): boolean { return this.read(orgId, "business_date"); }
  /** Analíticas consumindo a coluna resolvida ligadas? (default true). */
  static resolvedProductsV1(orgId: string): boolean { return this.read(orgId, "resolved_products"); }

  static read(orgId: string, key: RetailFlagKey): boolean {
    const col = FLAG_COLUMNS[key];
    try {
      const row = db.prepare(`SELECT ${col} AS v FROM organization_settings WHERE organization_id = ?`).get(orgId) as any;
      if (!row || row.v === undefined || row.v === null) return true; // sem dado → novo
      return Number(row.v) !== 0;
    } catch {
      return true; // coluna ausente (pré-migração) → comportamento novo
    }
  }

  /** Estado dos dois flags pra UI/admin. */
  static status(orgId: string): Record<RetailFlagKey, boolean> {
    return { business_date: this.businessDateV1(orgId), resolved_products: this.resolvedProductsV1(orgId) };
  }

  /** Liga/desliga um flag (owner/admin decide na rota). */
  static set(orgId: string, key: RetailFlagKey, on: boolean): Record<RetailFlagKey, boolean> {
    const col = FLAG_COLUMNS[key];
    if (!col) throw new Error("flag desconhecida.");
    db.prepare(`UPDATE organization_settings SET ${col} = ? WHERE organization_id = ?`).run(on ? 1 : 0, orgId);
    return this.status(orgId);
  }
}

export default RetailFeatureFlagService;
