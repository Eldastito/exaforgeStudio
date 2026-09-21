/**
 * FiscalProductMappingService — associa o item fiscal (linha da NF-e) ao produto
 * ou variante do catálogo (ADR-200, Fase 2). Determinístico e auditado.
 *
 * Ordem de resolução (PRD 10.8):
 *   1. mapeamento CONFIRMADO para (supplier_cnpj + cProd) — memória de equivalência;
 *   2. EAN/EANTrib exato (reutiliza RetailScanService.lookupByEan: variante por
 *      external_ref/sku, produto por ean/external_ref, prefixo não-ambíguo);
 *   3. senão, NÃO resolvido — o item entra no recebimento como esperado, sem
 *      produto (Fase C não descarta), aguardando associação humana.
 *
 * IA só SUGERE (status 'suggested'); confirmação é humana. Nunca sobrescreve um
 * mapeamento confirmado por uma sugestão posterior. Isolado por organização.
 */
import { randomUUID } from "node:crypto";
import db from "./db.js";
import { RetailScanService } from "./RetailScanService.js";
import { normalizeCnpj } from "./FiscalStoreResolverService.js";
import { logAuthEvent } from "./auditLog.js";

export interface FiscalItemKey {
  supplierCnpj?: string | null;
  supplierProductCode?: string | null;   // cProd
  ean?: string | null;
  eanTax?: string | null;                 // cEANTrib
}

export type MappingSource = "mapping" | "ean" | "external_ref" | "user" | "ai_suggestion";

export interface MappingResolution {
  status: "confirmed" | "resolved" | "unresolved";
  productServiceId: string | null;
  variantId: string | null;
  source: MappingSource | null;
}

const UNRESOLVED: MappingResolution = { status: "unresolved", productServiceId: null, variantId: null, source: null };

export class FiscalProductMappingService {
  /** Resolve um item fiscal para produto/variante, sem efeitos colaterais. */
  static resolveItem(orgId: string, item: FiscalItemKey): MappingResolution {
    // 1. Mapeamento confirmado por fornecedor + cProd -------------------------
    const supplierCnpj = normalizeCnpj(item.supplierCnpj);
    const code = String(item.supplierProductCode ?? "").trim();
    if (supplierCnpj && code) {
      const m = db.prepare(
        `SELECT product_service_id, variant_id FROM supplier_product_mappings
          WHERE organization_id = ? AND supplier_cnpj = ? AND supplier_product_code = ? AND status = 'confirmed' LIMIT 1`
      ).get(orgId, supplierCnpj, code) as any;
      if (m && this.productExists(orgId, m.product_service_id)) {
        return { status: "confirmed", productServiceId: m.product_service_id, variantId: m.variant_id || null, source: "mapping" };
      }
    }

    // 2. EAN / EANTrib exato (via catálogo próprio) ---------------------------
    for (const ean of [item.ean, item.eanTax]) {
      const e = String(ean ?? "").trim();
      if (!e) continue;
      const hit = RetailScanService.lookupByEan(orgId, e);
      if (hit.found) {
        return { status: "resolved", productServiceId: hit.product.id, variantId: hit.variant?.id || null, source: "ean" };
      }
    }

    // 3. Não resolvido — associação humana na revisão -------------------------
    return UNRESOLVED;
  }

  /**
   * Confirma (grava/atualiza) a memória de equivalência fornecedor+cProd →
   * produto/variante. Upsert por (org, supplier_cnpj, supplier_product_code).
   */
  static confirmMapping(
    orgId: string,
    input: { supplierCnpj: string; supplierProductCode: string; productServiceId: string; variantId?: string | null; ean?: string | null; source?: MappingSource },
    actorId?: string
  ): { ok: boolean; reason?: string } {
    const supplierCnpj = normalizeCnpj(input.supplierCnpj);
    const code = String(input.supplierProductCode ?? "").trim();
    if (!supplierCnpj || !code) return { ok: false, reason: "fornecedor/cProd inválido" };
    if (!this.productExists(orgId, input.productServiceId)) return { ok: false, reason: "produto inexistente" };

    const existing = db.prepare(
      `SELECT id FROM supplier_product_mappings WHERE organization_id = ? AND supplier_cnpj = ? AND supplier_product_code = ?`
    ).get(orgId, supplierCnpj, code) as any;

    if (existing) {
      db.prepare(
        `UPDATE supplier_product_mappings SET product_service_id = ?, variant_id = ?, ean = ?, status = 'confirmed',
            source = ?, confirmed_by = ?, confirmed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?`
      ).run(input.productServiceId, input.variantId || null, input.ean || null, input.source || "user", actorId || null, existing.id);
    } else {
      db.prepare(
        `INSERT INTO supplier_product_mappings
           (id, organization_id, supplier_cnpj, supplier_product_code, ean, product_service_id, variant_id, status, source, confirmed_by, confirmed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'confirmed', ?, ?, CURRENT_TIMESTAMP)`
      ).run(randomUUID(), orgId, supplierCnpj, code, input.ean || null, input.productServiceId, input.variantId || null, input.source || "user", actorId || null);
    }
    try { logAuthEvent(orgId, actorId || "system", input.productServiceId, "FISCAL_MAPPING_CONFIRMED", { supplierCnpj, code }); } catch { /* noop */ }
    return { ok: true };
  }

  private static productExists(orgId: string, productServiceId: string): boolean {
    return !!db.prepare(`SELECT 1 FROM products_services WHERE organization_id = ? AND id = ?`).get(orgId, productServiceId);
  }
}

export default FiscalProductMappingService;
