import db from "./db.js";

/**
 * ZappFlow Comigo — Sugestão de venda zero-token (ADR-117 / ADR-088 D5).
 *
 * "Mais pedidos" e "quem levou isso também levou" são RANKING/CO-OCORRÊNCIA
 * sobre o histórico do Balcão (comigo_order_items) — consulta, não IA. Motor de
 * upsell grátis. Isolado por organization_id. Só sugere itens da própria loja.
 */

export type Suggestion = { product_id: string; name: string; count: number };

export class ComigoSuggestionService {
  /**
   * Itens que mais co-ocorrem com `productId` no mesmo pedido (market-basket).
   * Ranqueia por nº de pedidos distintos em que aparecem junto.
   */
  static alsoBought(orgId: string, productId: string, limit = 4): Suggestion[] {
    const rows = db.prepare(`
      SELECT oi2.product_id AS product_id, oi2.name AS name, COUNT(DISTINCT oi2.order_id) AS count
      FROM comigo_order_items oi1
      JOIN comigo_order_items oi2 ON oi2.order_id = oi1.order_id AND oi2.product_id IS NOT NULL AND oi2.product_id <> oi1.product_id
      JOIN comigo_orders o ON o.id = oi1.order_id
      WHERE o.organization_id = ? AND oi1.product_id = ?
      GROUP BY oi2.product_id
      ORDER BY count DESC, name ASC
      LIMIT ?
    `).all(orgId, productId, limit) as any[];
    return rows.map((r) => ({ product_id: r.product_id, name: r.name, count: Number(r.count) || 0 }));
  }

  /** Mais vendidos (Σ qty em vendas paid/done) — a "sugestão da casa". */
  static topSellers(orgId: string, limit = 6): Suggestion[] {
    const rows = db.prepare(`
      SELECT oi.product_id AS product_id, oi.name AS name, SUM(oi.qty) AS count
      FROM comigo_order_items oi JOIN comigo_orders o ON o.id = oi.order_id
      WHERE o.organization_id = ? AND o.status IN ('paid','done') AND oi.product_id IS NOT NULL
      GROUP BY oi.product_id
      ORDER BY count DESC, name ASC
      LIMIT ?
    `).all(orgId, limit) as any[];
    return rows.map((r) => ({ product_id: r.product_id, name: r.name, count: Number(r.count) || 0 }));
  }

  /** Payload pro Balcão: co-ocorrência do item atual + mais pedidos (fallback). */
  static forBalcao(orgId: string, productId?: string) {
    return {
      alsoBought: productId ? this.alsoBought(orgId, productId) : [],
      top: this.topSellers(orgId),
    };
  }
}

export default ComigoSuggestionService;
