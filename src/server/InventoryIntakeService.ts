import db from "./db.js";
import { v4 as uuidv4 } from "uuid";
import { logAuthEvent } from "./auditLog.js";
import { InventoryService } from "./InventoryService.js";
import { uniqueProductSlug } from "./productSlug.js";
import { sanitizeGtin } from "./eanUtil.js";

/**
 * Cadastro de estoque/vitrine acionado FORA do painel web — hoje só pelo
 * cadastro conversacional por WhatsApp (ver WhatsAppInventoryIntake.ts).
 * Espelha deliberadamente a lógica já testada das rotas HTTP em
 * routes/products.ts (POST /smart-scan/:id/confirm e
 * POST /invoice-scan/:id/confirm) em vez de reaproveitá-las diretamente —
 * são poucas linhas e mexer nas rotas HTTP (caminho já validado em produção,
 * ADR-019/020/021/030) para extrair uma função compartilhada tem mais risco
 * de regressão do que a duplicação pontual.
 *
 * Publica na vitrine (storefront_visible=1) SEMPRE que há preço de venda
 * definido pelo humano — nunca antes disso (ADR-032): um produto sem preço
 * fica só no controle de estoque (`commitProductWithoutPrice`/
 * `commitInvoiceItemWithoutPrice`), com `pricing_declined_at` marcado, até
 * alguém completar o cadastro.
 */
export class InventoryIntakeService {
  /** Cria o produto a partir de uma foto avulsa (fluxo 1) já com preço definido pelo gestor. */
  static commitProductFromScan(orgId: string, params: {
    name: string; category?: string | null; description?: string | null; ean?: string | null;
    salePrice: number; marginPercent?: number | null; quantity: number; imageUrl: string;
  }): string {
    const id = uuidv4();
    db.prepare(
      `INSERT INTO products_services (id, organization_id, type, name, description, price, margin_percent, stock_control_enabled, category, slug, storefront_visible, ean)
       VALUES (?, ?, 'product', ?, ?, ?, ?, 1, ?, ?, 1, ?)`
    ).run(id, orgId, params.name.trim(), params.description || "", params.salePrice, params.marginPercent ?? null, params.category ? params.category.trim().slice(0, 80) : null, uniqueProductSlug(orgId, params.name), sanitizeGtin(params.ean));

    db.prepare(
      `INSERT INTO inventory_items (id, organization_id, product_service_id, quantity_available, low_stock_threshold)
       VALUES (?, ?, ?, ?, 0)`
    ).run(uuidv4(), orgId, id, Math.max(0, params.quantity));

    db.prepare("INSERT INTO product_images (id, organization_id, product_service_id, url, position) VALUES (?, ?, ?, ?, 0)")
      .run(uuidv4(), orgId, id, params.imageUrl);

    logAuthEvent(orgId, null, id, "PRODUCT_CREATED", { name: params.name, type: "product", source: "whatsapp_manager" });
    return id;
  }

  /**
   * Produto SEM preço (lojista recusou informar, ADR-032): entra no estoque
   * para controle de quantidade, mas NUNCA na vitrine — `pricing_declined_at`
   * marca o momento da recusa para a auditoria de produtos incompletos.
   */
  static commitProductWithoutPrice(orgId: string, params: {
    name: string; category?: string | null; description?: string | null; ean?: string | null; quantity: number; imageUrl: string;
  }): string {
    const id = uuidv4();
    db.prepare(
      `INSERT INTO products_services (id, organization_id, type, name, description, stock_control_enabled, category, slug, storefront_visible, pricing_declined_at, ean)
       VALUES (?, ?, 'product', ?, ?, 1, ?, ?, 0, CURRENT_TIMESTAMP, ?)`
    ).run(id, orgId, params.name.trim(), params.description || "", params.category ? params.category.trim().slice(0, 80) : null, uniqueProductSlug(orgId, params.name), sanitizeGtin(params.ean));

    db.prepare(
      `INSERT INTO inventory_items (id, organization_id, product_service_id, quantity_available, low_stock_threshold)
       VALUES (?, ?, ?, ?, 0)`
    ).run(uuidv4(), orgId, id, Math.max(0, params.quantity));

    db.prepare("INSERT INTO product_images (id, organization_id, product_service_id, url, position) VALUES (?, ?, ?, ?, 0)")
      .run(uuidv4(), orgId, id, params.imageUrl);

    logAuthEvent(orgId, null, id, "PRODUCT_CREATED", { name: params.name, type: "product", source: "whatsapp_manager", pricingDeclined: true });
    return id;
  }

  /** Cria um produto novo a partir de um item de nota fiscal (fluxo 2, item sem match no catálogo). */
  static commitInvoiceItemCreate(orgId: string, params: {
    name: string; category?: string | null; salePrice: number; marginPercent?: number | null; quantity: number; unitCost: number;
    supplierName?: string | null; supplierContactId?: string | null;
  }): string {
    const productId = uuidv4();
    db.prepare(
      `INSERT INTO products_services (id, organization_id, type, name, description, price, margin_percent, stock_control_enabled, category, slug, storefront_visible)
       VALUES (?, ?, 'product', ?, '', ?, ?, 1, ?, ?, 1)`
    ).run(productId, orgId, params.name.trim(), params.salePrice, params.marginPercent ?? null, params.category ? params.category.trim().slice(0, 80) : null, uniqueProductSlug(orgId, params.name));

    InventoryService.recordMovement(orgId, {
      productId, type: "entrada", quantity: params.quantity, unitCost: params.unitCost,
      origin: "invoice_scan", note: params.supplierName ? `Nota fiscal — ${params.supplierName}` : "Nota fiscal",
      supplierContactId: params.supplierContactId || null,
    });
    logAuthEvent(orgId, null, productId, "PRODUCT_CREATED", { name: params.name, type: "product", source: "whatsapp_manager_invoice" });
    return productId;
  }

  /**
   * Item de nota fiscal sem match E o lojista recusou informar o preço de
   * venda: quantidade/custo são dados reais da nota (entram no estoque
   * normalmente), só o preço fica pendente — produto criado SEM vitrine.
   */
  static commitInvoiceItemWithoutPrice(orgId: string, params: {
    name: string; quantity: number; unitCost: number; supplierName?: string | null; supplierContactId?: string | null;
  }): string {
    const productId = uuidv4();
    db.prepare(
      `INSERT INTO products_services (id, organization_id, type, name, description, stock_control_enabled, slug, storefront_visible, pricing_declined_at)
       VALUES (?, ?, 'product', ?, '', 1, ?, 0, CURRENT_TIMESTAMP)`
    ).run(productId, orgId, params.name.trim(), uniqueProductSlug(orgId, params.name));

    InventoryService.recordMovement(orgId, {
      productId, type: "entrada", quantity: params.quantity, unitCost: params.unitCost,
      origin: "invoice_scan", note: params.supplierName ? `Nota fiscal — ${params.supplierName}` : "Nota fiscal",
      supplierContactId: params.supplierContactId || null,
    });
    logAuthEvent(orgId, null, productId, "PRODUCT_CREATED", { name: params.name, type: "product", source: "whatsapp_manager_invoice", pricingDeclined: true });
    return productId;
  }

  /** Repõe estoque de um produto já existente (fluxo 2, item com match forte — sem perguntar preço). */
  static commitInvoiceItemRestock(orgId: string, params: {
    productId: string; quantity: number; unitCost: number;
    supplierName?: string | null; supplierContactId?: string | null;
  }): void {
    InventoryService.recordMovement(orgId, {
      productId: params.productId, type: "entrada", quantity: params.quantity, unitCost: params.unitCost,
      origin: "invoice_scan", note: params.supplierName ? `Nota fiscal — ${params.supplierName}` : "Nota fiscal",
      supplierContactId: params.supplierContactId || null,
    });
    db.prepare(`UPDATE products_services SET stock_control_enabled = 1 WHERE id = ? AND organization_id = ?`).run(params.productId, orgId);
  }

  /**
   * Repõe estoque de um produto já existente a partir de uma FOTO avulsa
   * (fluxo 1, match encontrado no catálogo) — sem custo de nota fiscal, então
   * não mexe no custo médio; reaproveita o preço/margem já cadastrados.
   */
  static restockProductFromScan(orgId: string, params: { productId: string; quantity: number }): void {
    InventoryService.recordMovement(orgId, {
      productId: params.productId, type: "entrada", quantity: params.quantity,
      origin: "whatsapp_manager", note: "Reposição via WhatsApp",
    });
    db.prepare(`UPDATE products_services SET stock_control_enabled = 1 WHERE id = ? AND organization_id = ?`).run(params.productId, orgId);
  }

  /** Registra o histórico de custo/margem/preço (base para sugestões futuras — não é ML, é dado estruturado). */
  static recordPriceHistory(orgId: string, params: {
    productId?: string | null; productName: string; category?: string | null;
    costPrice?: number | null; marginPercent?: number | null; salePrice: number; source: string;
  }): void {
    try {
      db.prepare(
        `INSERT INTO product_price_history (id, organization_id, product_id, product_name, category, cost_price, margin_percent, sale_price, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(uuidv4(), orgId, params.productId || null, params.productName.trim().slice(0, 120), params.category || null, params.costPrice ?? null, params.marginPercent ?? null, params.salePrice, params.source);
    } catch (e) { /* histórico é best-effort, nunca bloqueia o cadastro */ }
  }

  /** Produtos sem preço de venda (nunca publicados) — base da auditoria proativa (ADR-032). */
  static incompletePricingProducts(orgId: string): { id: string; name: string; pricingDeclinedAt: string | null }[] {
    const rows = db.prepare(
      `SELECT id, name, pricing_declined_at FROM products_services
       WHERE organization_id = ? AND active = 1 AND type = 'product' AND (price IS NULL OR price <= 0)`
    ).all(orgId) as any[];
    return rows.map((r) => ({ id: r.id, name: r.name, pricingDeclinedAt: r.pricing_declined_at || null }));
  }
}
