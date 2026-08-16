/**
 * Retail Ops — Estoque por loja + alertas de negativo (ADR-083, Fase F).
 *
 * Camada de estoque POR LOJA que PERMITE quantidade < 0 (sem o MAX(0,…) do
 * core), para EXPOR a divergência: quando um item fica negativo, abre-se um
 * `retail_stock_alert` com uma causa provável para o operador investigar. O
 * estoque core (inventory_items) segue clampado e intocado (ADR-083 D6). Camada
 * aditiva, isolada por organização, auditada.
 */
import { randomUUID } from "node:crypto";
import db from "./db.js";
import { logAuthEvent } from "./auditLog.js";
import { RetailStockPolicyService } from "./RetailStockPolicyService.js";

// Causas prováveis de estoque negativo (heurística; a explicação com dados de
// venda vem quando a conciliação externa — Fase E — estiver ligada).
export const NEGATIVE_STOCK_CAUSES = [
  "venda sem baixa correta no estoque",
  "transferência entre lojas não registrada",
  "entrada de mercadoria não lançada",
  "divergência de inventário/contagem",
];

const vk = (variantId?: string | null) => (variantId ? String(variantId) : "");

export class RetailInventoryService {
  static get(orgId: string, storeId: string, productId: string, variantId?: string | null): any | null {
    return (db.prepare(
      `SELECT * FROM retail_store_inventory WHERE organization_id = ? AND store_id = ? AND product_service_id = ? AND variant_id = ?`
    ).get(orgId, storeId, productId, vk(variantId)) as any) || null;
  }

  /** Define o saldo absoluto (permite negativo) e (re)avalia o alerta. */
  static setQuantity(orgId: string, storeId: string, productId: string, variantId: string | null | undefined, quantityAvailable: number, quantityReserved = 0, actorId?: string): any {
    const qty = Math.trunc(Number(quantityAvailable || 0));
    db.prepare(
      `INSERT INTO retail_store_inventory (id, organization_id, store_id, product_service_id, variant_id, quantity_available, quantity_reserved, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(organization_id, store_id, product_service_id, variant_id) DO UPDATE SET
         quantity_available = excluded.quantity_available, quantity_reserved = excluded.quantity_reserved, updated_at = CURRENT_TIMESTAMP`
    ).run(randomUUID(), orgId, storeId, productId, vk(variantId), qty, Math.trunc(Number(quantityReserved || 0)));
    this.evaluateAlert(orgId, storeId, productId, variantId, qty);
    try { logAuthEvent(orgId, actorId || "system", storeId, "RETAIL_STOCK_SET", { productId, qty }); } catch { /* noop */ }
    return this.get(orgId, storeId, productId, variantId);
  }

  /** Aplica um delta (venda = negativo, entrada = positivo). PODE ficar negativo. */
  static applyMovement(orgId: string, storeId: string, productId: string, variantId: string | null | undefined, delta: number, actorId?: string): any {
    const cur = this.get(orgId, storeId, productId, variantId);
    const next = Math.trunc(Number(cur?.quantity_available || 0)) + Math.trunc(Number(delta || 0));
    return this.setQuantity(orgId, storeId, productId, variantId, next, Number(cur?.quantity_reserved || 0), actorId);
  }

  /** Abre um alerta quando fica negativo; resolve quando volta a >= 0. */
  private static evaluateAlert(orgId: string, storeId: string, productId: string, variantId: string | null | undefined, qty: number): void {
    if (qty < 0) {
      db.prepare(
        `INSERT INTO retail_stock_alerts (id, organization_id, store_id, product_service_id, variant_id, alert_type, quantity, status)
         VALUES (?, ?, ?, ?, ?, 'negative_stock', ?, 'open')
         ON CONFLICT(organization_id, store_id, product_service_id, variant_id, alert_type) DO UPDATE SET
           quantity = excluded.quantity, status = 'open', detected_at = CURRENT_TIMESTAMP, resolved_at = NULL, resolution_note = NULL`
      ).run(randomUUID(), orgId, storeId, productId, vk(variantId), qty);
    } else {
      db.prepare(
        `UPDATE retail_stock_alerts SET status = 'resolved', resolved_at = CURRENT_TIMESTAMP, resolution_note = COALESCE(resolution_note, 'estoque normalizado')
          WHERE organization_id = ? AND store_id = ? AND product_service_id = ? AND variant_id = ? AND alert_type = 'negative_stock' AND status = 'open'`
      ).run(orgId, storeId, productId, vk(variantId));
    }
  }

  /** Negativos por loja, com filtro (loja/produto) e paginação server-side —
   *  a lista pode ser grande numa rede com muitos SKUs. Retorna total + página.
   *
   *  PRD Moda/TOULON (INV-001/002): enriquece cada negativo com a IDENTIFICAÇÃO
   *  completa da peça — referência, unidade, cor, tamanho, SKU e EAN — para o
   *  vendedor saber EXATAMENTE qual produto está negativo. Mapeamento do dado
   *  Alterdata (ver AlterdataSupplyMapper): o EAN/código de barras é gravado em
   *  `product_variants.sku`; `external_ref` é a referência do ERP; a unidade vem
   *  de `products_services.default_uom`. Tudo aditivo — os campos flat antigos
   *  (store_name, product_name, i.*) continuam iguais para não quebrar a tela. */
  static listNegative(orgId: string, opts: { storeId?: string; q?: string; limit?: number; offset?: number; restrictStoreIds?: string[] } = {}): { total: number; items: any[] } {
    const where: string[] = ["i.organization_id = ?", "i.quantity_available < 0"];
    const args: any[] = [orgId];
    if (opts.storeId) { where.push("i.store_id = ?"); args.push(String(opts.storeId)); }
    // CRM-002: trava de loja por usuário (servidor).
    if (opts.restrictStoreIds) {
      if (!opts.restrictStoreIds.length) where.push("1 = 0");
      else { where.push(`i.store_id IN (${opts.restrictStoreIds.map(() => "?").join(",")})`); args.push(...opts.restrictStoreIds); }
    }
    const q = String(opts.q || "").trim();
    // Busca por nome, referência do produto, EAN (sku da variante) ou ref da variante.
    if (q) {
      const like = `%${q}%`;
      where.push("(p.name LIKE ? OR p.external_ref LIKE ? OR pv.sku LIKE ? OR pv.external_ref LIKE ?)");
      args.push(like, like, like, like);
    }
    const base = `FROM retail_store_inventory i
                    JOIN retail_stores s ON s.id = i.store_id
               LEFT JOIN products_services p ON p.id = i.product_service_id
               LEFT JOIN product_variants pv ON pv.id = i.variant_id AND pv.organization_id = i.organization_id
                   WHERE ${where.join(" AND ")}`;
    const total = Number((db.prepare(`SELECT COUNT(*) c ${base}`).get(...args) as any)?.c || 0);
    const limit = Math.min(500, Math.max(1, Math.trunc(Number(opts.limit) || 100)));
    const offset = Math.max(0, Math.trunc(Number(opts.offset) || 0));
    const items = db.prepare(
      `SELECT i.*,
              s.name AS store_name, s.code AS store_code,
              p.name AS product_name, p.external_ref AS product_external_ref, p.default_uom AS product_uom,
              pv.name AS variant_name, pv.color AS variant_color, pv.size AS variant_size,
              pv.external_ref AS variant_sku,
              COALESCE(pv.sku, p.ean) AS variant_ean,
              i.updated_at AS source_synced_at
         ${base} ORDER BY i.quantity_available ASC LIMIT ? OFFSET ?`
    ).all(...args, limit, offset) as any[];

    // INV-003/004: números de FALTA por item. `qty_to_zero` (sair do negativo)
    // sempre existe; `shortage_qty`/min/target SÓ com política (senão null —
    // "Meta não configurada", nunca falta inventada). Resolve por precedência;
    // curto-circuita se a org não tem NENHUMA política.
    const orgHasPolicies = RetailStockPolicyService.hasAny(orgId);
    for (const it of items) {
      const pol = orgHasPolicies
        ? RetailStockPolicyService.resolve(orgId, it.store_id, it.product_service_id, it.variant_id)
        : null;
      Object.assign(it, RetailStockPolicyService.computeQuantities(Number(it.quantity_available || 0), pol));
    }
    return { total, items };
  }

  static byStore(orgId: string, storeId: string): any[] {
    return db.prepare(
      `SELECT i.*, p.name AS product_name FROM retail_store_inventory i
    LEFT JOIN products_services p ON p.id = i.product_service_id
        WHERE i.organization_id = ? AND i.store_id = ? ORDER BY i.quantity_available ASC`
    ).all(orgId, storeId) as any[];
  }

  static listAlerts(orgId: string, status = "open"): any[] {
    return db.prepare(
      `SELECT a.*, s.name AS store_name, p.name AS product_name
         FROM retail_stock_alerts a
    LEFT JOIN retail_stores s ON s.id = a.store_id
    LEFT JOIN products_services p ON p.id = a.product_service_id
        WHERE a.organization_id = ? AND a.status = ? ORDER BY a.detected_at DESC`
    ).all(orgId, status).map((a: any) => ({ ...a, possibleCauses: NEGATIVE_STOCK_CAUSES })) as any[];
  }

  static resolveAlert(orgId: string, id: string, note: string | undefined, actorId?: string): any | null {
    const a = db.prepare(`SELECT * FROM retail_stock_alerts WHERE organization_id = ? AND id = ?`).get(orgId, id) as any;
    if (!a) return null;
    db.prepare(`UPDATE retail_stock_alerts SET status = 'resolved', resolved_at = CURRENT_TIMESTAMP, resolution_note = ? WHERE organization_id = ? AND id = ?`)
      .run(note || "resolvido manualmente", orgId, id);
    try { logAuthEvent(orgId, actorId || "system", id, "RETAIL_STOCK_ALERT_RESOLVED", { note }); } catch { /* noop */ }
    return db.prepare(`SELECT * FROM retail_stock_alerts WHERE id = ?`).get(id);
  }
}
