/**
 * Retail Ops — Modo de estoque / fonte da verdade (ADR-084 D4, fatia fundacional).
 *
 * Decide, por organização (e opcionalmente por loja), QUEM é a fonte autoritativa
 * do saldo de estoque:
 *   - native      → o ZappFlow é o sistema principal; o saldo vive no núcleo;
 *   - supervised  → o ERP/PDV externo manda; o ZappFlow supervisiona/concilia
 *                   (o `retail_store_inventory` é a sombra que pode ir a negativo);
 *   - hybrid      → escolha POR LOJA (cada loja declara o seu modo; sem override,
 *                   a loja resolve para 'native').
 *
 * Esta fatia entrega a CONFIGURAÇÃO e o RESOLVEDOR que carregam a invariante do
 * D4 — "um único ledger autoritativo por (loja, produto)". Ainda NÃO altera onde
 * o saldo é escrito (isso é o `store_id` no estoque nativo e a graduação D5,
 * fatias futuras); aqui declaramos a verdade que essas fatias vão consultar.
 * Isolado por organização e auditado.
 */
import db from "./db.js";
import { logAuthEvent } from "./auditLog.js";

export type StockMode = "native" | "supervised" | "hybrid";
const VALID: StockMode[] = ["native", "supervised", "hybrid"];
const DEFAULT_MODE: StockMode = "native";

function isValid(m: any): m is StockMode { return VALID.includes(m); }

export class RetailStockModeService {
  /** Modo declarado no nível da ORGANIZAÇÃO (default 'native'). */
  static getOrgMode(orgId: string): StockMode {
    const row = db.prepare(`SELECT retail_stock_source AS m FROM organization_settings WHERE organization_id = ?`).get(orgId) as any;
    return isValid(row?.m) ? row.m : DEFAULT_MODE;
  }

  static setOrgMode(orgId: string, mode: string, actorId?: string): StockMode {
    if (!isValid(mode)) throw new Error(`Modo de estoque inválido: use ${VALID.join(" | ")}.`);
    db.prepare(`UPDATE organization_settings SET retail_stock_source = ? WHERE organization_id = ?`).run(mode, orgId);
    try { logAuthEvent(orgId, actorId || "system", null, "RETAIL_STOCK_MODE_SET", { scope: "org", mode }); } catch { /* noop */ }
    return mode;
  }

  /** Override da LOJA (null = herda da org). */
  static getStoreOverride(orgId: string, storeId: string): StockMode | null {
    const row = db.prepare(`SELECT stock_source AS m FROM retail_stores WHERE organization_id = ? AND id = ?`).get(orgId, storeId) as any;
    return isValid(row?.m) ? row.m : null;
  }

  static setStoreOverride(orgId: string, storeId: string, mode: string | null, actorId?: string): StockMode | null {
    const store = db.prepare(`SELECT id FROM retail_stores WHERE organization_id = ? AND id = ?`).get(orgId, storeId);
    if (!store) throw new Error("store_not_found");
    if (mode !== null && !isValid(mode)) throw new Error(`Modo de estoque inválido: use ${VALID.join(" | ")} ou null.`);
    db.prepare(`UPDATE retail_stores SET stock_source = ?, updated_at = CURRENT_TIMESTAMP WHERE organization_id = ? AND id = ?`).run(mode, orgId, storeId);
    try { logAuthEvent(orgId, actorId || "system", storeId, "RETAIL_STOCK_MODE_SET", { scope: "store", mode }); } catch { /* noop */ }
    return (mode as StockMode | null);
  }

  /**
   * Modo EFETIVO de uma loja (ou da org, quando storeId é omitido):
   *   override da loja  →  se ausente, modo da org  →  se 'hybrid', 'native'.
   * (Sob 'hybrid', uma loja sem override declarado resolve para 'native'.)
   */
  static resolve(orgId: string, storeId?: string | null): StockMode {
    if (storeId) {
      const ov = this.getStoreOverride(orgId, storeId);
      if (ov) return ov;
    }
    const org = this.getOrgMode(orgId);
    return org === "hybrid" ? "native" : org;
  }

  /**
   * Ledger AUTORITATIVO resultante da invariante D4: 'core' (estoque do núcleo)
   * quando native; 'shadow' (retail_store_inventory) quando supervised. É o que
   * as fatias futuras de escrita de estoque devem consultar para nunca deixar
   * dois ledgers escreverem o mesmo (loja, produto).
   */
  static authoritativeLedger(orgId: string, storeId?: string | null): "core" | "shadow" {
    return this.resolve(orgId, storeId) === "supervised" ? "shadow" : "core";
  }

  /** Situação completa: modo da org + override/efetivo por loja. */
  static status(orgId: string): { orgMode: StockMode; stores: Array<{ storeId: string; name: string; override: StockMode | null; resolved: StockMode }> } {
    const orgMode = this.getOrgMode(orgId);
    const stores = (db.prepare(`SELECT id, name, stock_source FROM retail_stores WHERE organization_id = ? ORDER BY name`).all(orgId) as any[]).map((s) => ({
      storeId: s.id,
      name: s.name,
      override: isValid(s.stock_source) ? (s.stock_source as StockMode) : null,
      resolved: this.resolve(orgId, s.id),
    }));
    return { orgMode, stores };
  }
}
