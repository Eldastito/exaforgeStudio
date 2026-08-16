/**
 * Retail Ops — Política de estoque (mínimo/alvo) por loja/produto/variante.
 *
 * PRD Moda/TOULON, frente INV (INV-003/004). É a peça que dá sentido a "quanto
 * falta": sem uma META definida pelo negócio, a falta NÃO é inventada — a UI
 * mostra "Meta não configurada" (RN nº 6 do PRD; AC-06).
 *
 * Precedência de resolução (mais específica primeiro) — INV-004:
 *   1. loja + variante
 *   2. loja + produto
 *   3. organização + variante
 *   4. organização + produto
 *   5. sem política  → null
 *
 * store_id/variant_id usam '' (sentinel) para "toda a org / todo o produto",
 * consistente com retail_store_inventory (variant_id = '' quando não há variante).
 * Isolado por organização (RN nº 1).
 */
import { randomUUID } from "node:crypto";
import db from "./db.js";
import { logAuthEvent } from "./auditLog.js";

const sk = (v?: string | null): string => (v ? String(v) : "");
const numOrZero = (v: any): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

export type StockPolicyInput = {
  storeId?: string | null;      // '' / null = organização (todas as lojas)
  productId: string;
  variantId?: string | null;    // '' / null = todas as variantes do produto
  minQty: number;
  targetQty: number;
  source?: "manual" | "erp" | "recommendation";
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
};

export type ResolvedPolicy = {
  id: string;
  store_id: string;
  product_id: string;
  variant_id: string;
  min_qty: number;
  target_qty: number;
  source: string;
  scope: "store_variant" | "store_product" | "org_variant" | "org_product";
};

export class RetailStockPolicyService {
  /** Há ALGUMA política ativa nesta org? (curto-circuito p/ não resolver à toa) */
  static hasAny(orgId: string): boolean {
    return !!db.prepare(`SELECT 1 FROM retail_stock_policies WHERE organization_id = ? AND active = 1 LIMIT 1`).get(orgId);
  }

  /** Cria ou ATUALIZA a política ativa do escopo (uma ativa por escopo). */
  static set(orgId: string, input: StockPolicyInput, actorId?: string): any {
    const productId = String(input.productId || "").trim();
    if (!productId) throw new Error("productId é obrigatório");
    const storeId = sk(input.storeId);
    const variantId = sk(input.variantId);
    const minQty = numOrZero(input.minQty);
    const targetQty = numOrZero(input.targetQty);
    if (minQty < 0 || targetQty < 0) throw new Error("mínimo e alvo não podem ser negativos");
    if (targetQty < minQty) throw new Error("o alvo (target_qty) deve ser >= o mínimo (min_qty)");
    const source = input.source === "erp" || input.source === "recommendation" ? input.source : "manual";

    const existing = db.prepare(
      `SELECT id FROM retail_stock_policies WHERE organization_id = ? AND store_id = ? AND product_id = ? AND variant_id = ? AND active = 1`
    ).get(orgId, storeId, productId, variantId) as any;

    if (existing) {
      db.prepare(
        `UPDATE retail_stock_policies SET min_qty = ?, target_qty = ?, source = ?, effective_from = ?, effective_to = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
      ).run(minQty, targetQty, source, input.effectiveFrom || null, input.effectiveTo || null, actorId || null, existing.id);
      try { logAuthEvent(orgId, actorId || "system", existing.id, "RETAIL_STOCK_POLICY_UPDATED", { productId, storeId, variantId, minQty, targetQty }); } catch { /* noop */ }
      return this.get(orgId, existing.id);
    }
    const id = randomUUID();
    db.prepare(
      `INSERT INTO retail_stock_policies (id, organization_id, store_id, product_id, variant_id, min_qty, target_qty, source, effective_from, effective_to, active, created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
    ).run(id, orgId, storeId, productId, variantId, minQty, targetQty, source, input.effectiveFrom || null, input.effectiveTo || null, actorId || null, actorId || null);
    try { logAuthEvent(orgId, actorId || "system", id, "RETAIL_STOCK_POLICY_CREATED", { productId, storeId, variantId, minQty, targetQty }); } catch { /* noop */ }
    return this.get(orgId, id);
  }

  static get(orgId: string, id: string): any | null {
    return (db.prepare(`SELECT * FROM retail_stock_policies WHERE organization_id = ? AND id = ?`).get(orgId, id) as any) || null;
  }

  static list(orgId: string, opts: { storeId?: string; productId?: string } = {}): any[] {
    const where: string[] = ["organization_id = ?", "active = 1"];
    const args: any[] = [orgId];
    if (opts.storeId !== undefined) { where.push("store_id = ?"); args.push(sk(opts.storeId)); }
    if (opts.productId) { where.push("product_id = ?"); args.push(String(opts.productId)); }
    return db.prepare(`SELECT * FROM retail_stock_policies WHERE ${where.join(" AND ")} ORDER BY updated_at DESC, created_at DESC`).all(...args) as any[];
  }

  /** Desativa (não apaga — preserva histórico) a política. */
  static remove(orgId: string, id: string, actorId?: string): boolean {
    const cur = this.get(orgId, id);
    if (!cur) return false;
    db.prepare(`UPDATE retail_stock_policies SET active = 0, updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE organization_id = ? AND id = ?`).run(actorId || null, orgId, id);
    try { logAuthEvent(orgId, actorId || "system", id, "RETAIL_STOCK_POLICY_REMOVED", {}); } catch { /* noop */ }
    return true;
  }

  /** Resolve a política EFETIVA por precedência (INV-004). null = sem política. */
  static resolve(orgId: string, storeId: string | null | undefined, productId: string, variantId?: string | null): ResolvedPolicy | null {
    const store = sk(storeId);
    const variant = sk(variantId);
    const candidates: { store_id: string; variant_id: string; scope: ResolvedPolicy["scope"] }[] = [];
    if (store && variant) candidates.push({ store_id: store, variant_id: variant, scope: "store_variant" });
    if (store) candidates.push({ store_id: store, variant_id: "", scope: "store_product" });
    if (variant) candidates.push({ store_id: "", variant_id: variant, scope: "org_variant" });
    candidates.push({ store_id: "", variant_id: "", scope: "org_product" });

    for (const c of candidates) {
      const row = db.prepare(
        `SELECT * FROM retail_stock_policies WHERE organization_id = ? AND store_id = ? AND product_id = ? AND variant_id = ? AND active = 1 LIMIT 1`
      ).get(orgId, c.store_id, productId, c.variant_id) as any;
      if (row) {
        return { id: row.id, store_id: row.store_id, product_id: row.product_id, variant_id: row.variant_id, min_qty: row.min_qty, target_qty: row.target_qty, source: row.source, scope: c.scope };
      }
    }
    return null;
  }

  /**
   * Números SEM ambiguidade (INV-003) para um saldo atual:
   *  - qty_to_zero: quanto falta só para SAIR do negativo (não depende de meta);
   *  - shortage_qty: max(target - atual, 0) — SÓ com política; senão null.
   * Não confundir os dois (RN nº 3 do PRD).
   */
  static computeQuantities(currentQty: number, policy: ResolvedPolicy | null) {
    const current = numOrZero(currentQty);
    return {
      qty_to_zero: current < 0 ? -current : 0,
      min_qty: policy ? policy.min_qty : null,
      target_qty: policy ? policy.target_qty : null,
      shortage_qty: policy ? Math.max(policy.target_qty - current, 0) : null,
      policy_scope: policy ? policy.scope : null,
      policy_source: policy ? policy.source : null,
    };
  }
}
