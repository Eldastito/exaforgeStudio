import db from "./db.js";

/**
 * Saldo VENDÁVEL de um produto para a vitrine.
 *
 * Considera as duas origens de estoque que a loja pode ter:
 *  - estoque próprio `inventory_items` (base sem variação OU soma das variações);
 *  - estoque por loja `retail_store_inventory` (rede/ERP/Alterdata, ADR-083).
 *
 * Por que existe: o auto-hide via `InventoryService.syncStorefrontVisibility`
 * só enxerga `inventory_items` e só dispara em movimentações que passam pelo
 * InventoryService — a loja da rede (estoque em `retail_store_inventory`) e a
 * venda pela vitrine (baixa via `RetailOnlineReserveService`) NÃO passam por lá,
 * então o produto esgotado nunca era escondido. A listagem pública usa este
 * cálculo (e o mesmo espelhado em SQL) como rede de segurança que vale pra
 * qualquer origem de estoque. Serviço/produto sem controle de estoque não tem
 * "esgotado" — o chamador decide (só filtra quem tem stock_control_enabled).
 */
export class StorefrontStockService {
  /** Disponível − reservado, combinando estoque próprio e por loja. */
  static sellable(productId: string): number {
    const r = db.prepare(`SELECT (
      COALESCE((SELECT ii.quantity_available FROM inventory_items ii WHERE ii.product_service_id = ? AND ii.variant_id IS NULL),
               (SELECT SUM(ii.quantity_available) FROM inventory_items ii WHERE ii.product_service_id = ? AND ii.variant_id IS NOT NULL),
               (SELECT SUM(rsi.quantity_available) FROM retail_store_inventory rsi WHERE rsi.product_service_id = ?), 0)
    - COALESCE((SELECT ii.quantity_reserved FROM inventory_items ii WHERE ii.product_service_id = ? AND ii.variant_id IS NULL),
               (SELECT SUM(ii.quantity_reserved) FROM inventory_items ii WHERE ii.product_service_id = ? AND ii.variant_id IS NOT NULL),
               (SELECT SUM(rsi.quantity_reserved) FROM retail_store_inventory rsi WHERE rsi.product_service_id = ?), 0)
    ) AS sellable`).get(productId, productId, productId, productId, productId, productId) as any;
    return Number(r?.sellable || 0);
  }

  /**
   * Saldo vendável de VÁRIOS produtos numa única consulta (evita N+1 na
   * listagem pública: antes cada produto disparava 6 subconsultas — 60 produtos
   * = 360 idas ao banco por página). Mesma expressão do `sellable()`, agora
   * correlacionada por `ps.id` e resolvida em UMA prepared statement.
   */
  static sellableMany(ids: string[]): Map<string, number> {
    const m = new Map<string, number>();
    if (!ids.length) return m;
    const ph = ids.map(() => "?").join(",");
    const rows = db.prepare(`SELECT ps.id AS id, (
      COALESCE((SELECT ii.quantity_available FROM inventory_items ii WHERE ii.product_service_id = ps.id AND ii.variant_id IS NULL),
               (SELECT SUM(ii.quantity_available) FROM inventory_items ii WHERE ii.product_service_id = ps.id AND ii.variant_id IS NOT NULL),
               (SELECT SUM(rsi.quantity_available) FROM retail_store_inventory rsi WHERE rsi.product_service_id = ps.id), 0)
    - COALESCE((SELECT ii.quantity_reserved FROM inventory_items ii WHERE ii.product_service_id = ps.id AND ii.variant_id IS NULL),
               (SELECT SUM(ii.quantity_reserved) FROM inventory_items ii WHERE ii.product_service_id = ps.id AND ii.variant_id IS NOT NULL),
               (SELECT SUM(rsi.quantity_reserved) FROM retail_store_inventory rsi WHERE rsi.product_service_id = ps.id), 0)
    ) AS sellable FROM products_services ps WHERE ps.id IN (${ph})`).all(...ids) as any[];
    for (const r of rows) m.set(r.id, Number(r.sellable || 0));
    return m;
  }

  /**
   * Cláusula SQL (sem parâmetros) que EXCLUI produtos esgotados da listagem
   * pública quando `auto_hide_out_of_stock` está ligado. Espelha `sellable()`,
   * mas correlacionada por `products_services.id` para rodar dentro do WHERE
   * (mantém contagem/paginação corretas). Serviço/item sem controle de estoque
   * nunca é excluído.
   */
  static readonly OUT_OF_STOCK_EXCLUDE_SQL = `NOT (products_services.stock_control_enabled = 1 AND (
    COALESCE((SELECT ii.quantity_available FROM inventory_items ii WHERE ii.product_service_id = products_services.id AND ii.variant_id IS NULL),
             (SELECT SUM(ii.quantity_available) FROM inventory_items ii WHERE ii.product_service_id = products_services.id AND ii.variant_id IS NOT NULL),
             (SELECT SUM(rsi.quantity_available) FROM retail_store_inventory rsi WHERE rsi.product_service_id = products_services.id), 0)
  - COALESCE((SELECT ii.quantity_reserved FROM inventory_items ii WHERE ii.product_service_id = products_services.id AND ii.variant_id IS NULL),
             (SELECT SUM(ii.quantity_reserved) FROM inventory_items ii WHERE ii.product_service_id = products_services.id AND ii.variant_id IS NOT NULL),
             (SELECT SUM(rsi.quantity_reserved) FROM retail_store_inventory rsi WHERE rsi.product_service_id = products_services.id), 0)
  ) <= 0)`;
}

export default StorefrontStockService;
