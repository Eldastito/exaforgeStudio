/**
 * Retail Ops — Scan por código de barras (ADR-086, versão só-catálogo-próprio).
 *
 * Bipar o código de barras é DECODIFICADO no aparelho (zero token de IA). Aqui
 * fazemos o LOOKUP no catálogo da própria loja (products_services.ean) e a
 * ENTRADA de estoque por bipagem — RESPEITANDO a invariante do modo de estoque
 * (ADR-084 D4): `native` escreve no núcleo (inventory_items), `supervised`
 * escreve na sombra por loja (retail_store_inventory). Sem provedor de EAN
 * externo (fica como enriquecimento opcional futuro). Isolado por organização.
 */
import db from "./db.js";
import { InventoryService } from "./InventoryService.js";
import { RetailInventoryService } from "./RetailInventoryService.js";
import { RetailStockModeService } from "./RetailStockModeService.js";
import { logAuthEvent } from "./auditLog.js";

export class RetailScanService {
  /**
   * Lookup do produto/variante pelo código de barras no catálogo próprio.
   *
   * Aceita o código como vem do LEITOR/digitação (só dígitos, mín. 6). NÃO exige
   * dígito verificador GS1 — os códigos internos da ModaUp (etiqueta de prefixo
   * 2, código do ERP gravado em product_variants.external_ref) não fecham o
   * checksum e mesmo assim são os códigos REAIS das peças. Casa por external_ref/
   * sku na variante, por ean/external_ref no produto, e por prefixo (EAN13 do
   * caixa × external_ref de 12 do catálogo — ADR-105) quando não-ambíguo.
   */
  static lookupByEan(orgId: string, rawEan: string): any {
    const ean = String(rawEan ?? "").replace(/\D/g, "");
    if (ean.length < 6) return { found: false, invalid: true, ean: String(rawEan || "") };

    // 1. variante (grade) por external_ref OU sku → resolve o produto pai.
    const v = db.prepare(
      `SELECT v.id AS variant_id, v.name AS variant_name, p.id, p.name, p.ean, COALESCE(v.price, p.price) AS price
         FROM product_variants v JOIN products_services p ON p.id = v.product_service_id AND p.organization_id = v.organization_id
        WHERE v.organization_id = ? AND (v.external_ref = ? OR v.sku = ?) AND v.active = 1 LIMIT 1`
    ).get(orgId, ean, ean) as any;
    if (v) {
      return { found: true, ean, product: { id: v.id, name: v.name, ean: v.ean, price: Number(v.price || 0) }, variant: { id: v.variant_id, name: v.variant_name }, coreStock: InventoryService.sellable(orgId, v.id, null) };
    }

    // 2. produto por ean OU external_ref (exato); 3. por PREFIXO, não-ambíguo.
    let product = db.prepare(
      `SELECT id, name, ean, price FROM products_services WHERE organization_id = ? AND (ean = ? OR external_ref = ?) LIMIT 1`
    ).get(orgId, ean, ean) as any;
    if (!product) {
      const pref = db.prepare(
        `SELECT id, name, ean, price FROM products_services WHERE organization_id = ? AND external_ref IS NOT NULL AND length(external_ref) >= 4 AND ? LIKE external_ref || '%' ORDER BY length(external_ref) DESC LIMIT 2`
      ).all(orgId, ean) as any[];
      if (pref.length === 1) product = pref[0]; // só associa quando não é ambíguo
    }
    if (!product) return { found: false, ean };
    return { found: true, ean, product: { id: product.id, name: product.name, ean: product.ean, price: Number(product.price || 0) }, coreStock: InventoryService.sellable(orgId, product.id, null) };
  }

  /**
   * Entrada de estoque por bipagem: acha o produto pelo EAN e credita a
   * quantidade no ledger AUTORITATIVO da loja/org (native→core, supervised→
   * sombra). Retorna o produto e o ledger usado. `store_required` quando o modo
   * é supervisionado e nenhuma loja foi informada.
   */
  static scanReceive(orgId: string, rawEan: string, qty: number, opts: { storeId?: string | null } = {}, actorId?: string): any {
    const q = Math.trunc(Number(qty) || 0);
    if (q <= 0) throw new Error("Quantidade inválida.");
    const hit = this.lookupByEan(orgId, rawEan);
    if (!hit.found) return hit; // invalid ou não encontrado → cliente decide o fallback

    const storeId = opts.storeId || null;
    const ledger = RetailStockModeService.authoritativeLedger(orgId, storeId);

    if (ledger === "shadow") {
      if (!storeId) throw new Error("store_required"); // sombra é por loja
      // Credita na variante quando o código bipado resolveu uma (grade); senão no produto.
      RetailInventoryService.applyMovement(orgId, storeId, hit.product.id, hit.variant?.id || null, q, actorId);
    } else {
      InventoryService.recordMovement(orgId, { productId: hit.product.id, type: "entrada", quantity: q, origin: "scan", createdBy: actorId });
    }

    try { logAuthEvent(orgId, actorId || "system", hit.product.id, "RETAIL_SCAN_RECEIVE", { ean: hit.ean, qty: q, ledger, storeId }); } catch { /* noop */ }
    return { found: true, ledger, storeId, product: hit.product, quantity: q };
  }
}
