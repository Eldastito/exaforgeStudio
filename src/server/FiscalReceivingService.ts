/**
 * FiscalReceivingService — recebimento ESPERADO a partir da NF-e (ADR-200,
 * Fase 2 PR C1).
 *
 * A NF-e autorizada cria um recebimento (estoque ESPERADO), nunca vendável:
 *   - cabeçalho em retail_goods_receipts (status 'open') ligado ao documento e
 *     à loja resolvida (loja é obrigatória — sem ela não cria);
 *   - um item esperado por LINHA fiscal, inclusive quando o produto ainda NÃO
 *     foi resolvido (não é descartado — fica mapping_status unresolved);
 *   - quantidade esperada DECIMAL (qCom), fiel ao XML;
 *   - NÃO movimenta estoque. A confirmação (PR C2) credita só o recebido no
 *     ledger de RetailStockModeService.
 *
 * Idempotente por documento: se o documento já tem recebimento, devolve o
 * existente. Isolado por organização.
 */
import { randomUUID } from "node:crypto";
import db from "./db.js";
import { FiscalProductMappingService } from "./FiscalProductMappingService.js";
import { logAuthEvent } from "./auditLog.js";

export interface CreateExpectedResult {
  status: "created" | "exists" | "blocked";
  receiptId: string | null;
  reason?: string;
}

export class FiscalReceivingService {
  /**
   * Cria o recebimento esperado a partir de um fiscal_document autorizado com
   * loja resolvida. Não movimenta estoque. Idempotente por documento.
   */
  static createExpectedFromDocument(orgId: string, fiscalDocumentId: string, actorId?: string): CreateExpectedResult {
    const doc = db.prepare(`SELECT * FROM fiscal_documents WHERE organization_id = ? AND id = ?`).get(orgId, fiscalDocumentId) as any;
    if (!doc) return { status: "blocked", receiptId: null, reason: "documento inexistente" };
    if (doc.content_level !== "authorized_process") return { status: "blocked", receiptId: null, reason: "documento não é XML autorizado" };
    if (doc.fiscal_status === "cancelled") return { status: "blocked", receiptId: null, reason: "documento cancelado" };
    if (!doc.store_id) return { status: "blocked", receiptId: null, reason: "store_assignment_required" };

    // Idempotência por documento: já existe recebimento vinculado → devolve.
    if (doc.goods_receipt_id) {
      const existing = db.prepare(`SELECT id FROM retail_goods_receipts WHERE organization_id = ? AND id = ?`).get(orgId, doc.goods_receipt_id) as any;
      if (existing) return { status: "exists", receiptId: existing.id };
    }
    const dupe = db.prepare(`SELECT id FROM retail_goods_receipts WHERE organization_id = ? AND fiscal_document_id = ?`).get(orgId, fiscalDocumentId) as any;
    if (dupe) return { status: "exists", receiptId: dupe.id };

    const items = db.prepare(`SELECT * FROM fiscal_document_items WHERE fiscal_document_id = ? ORDER BY item_number`).all(fiscalDocumentId) as any[];

    const receiptId = randomUUID();
    const tx = db.transaction(() => {
      db.prepare(
        `INSERT INTO retail_goods_receipts (id, organization_id, store_id, status, note, created_by, fiscal_document_id)
         VALUES (?, ?, ?, 'open', ?, ?, ?)`
      ).run(receiptId, orgId, doc.store_id, `NF-e ${doc.number || ""}/${doc.series || ""} — ${doc.issuer_name || ""}`.trim(), actorId || null, fiscalDocumentId);

      const stmt = db.prepare(
        `INSERT INTO fiscal_goods_receipt_items (
           id, organization_id, receipt_id, fiscal_document_id, fiscal_document_item_id,
           product_service_id, variant_id, fiscal_description, ean, expected_qty, received_qty, damage_qty,
           mapping_status, mapping_source
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)`
      );
      for (const it of items) {
        const res = FiscalProductMappingService.resolveItem(orgId, {
          supplierCnpj: doc.issuer_cnpj, supplierProductCode: it.supplier_product_code, ean: it.ean, eanTax: it.ean_tax,
        });
        stmt.run(
          randomUUID(), orgId, receiptId, fiscalDocumentId, it.id,
          res.productServiceId, res.variantId, it.fiscal_description, it.ean, Number(it.commercial_qty || 0),
          res.status, res.source,
        );
      }

      db.prepare(`UPDATE fiscal_documents SET goods_receipt_id = ?, processing_state = 'receipt_open', updated_at = CURRENT_TIMESTAMP WHERE organization_id = ? AND id = ?`)
        .run(receiptId, orgId, fiscalDocumentId);
    });
    tx();

    try { logAuthEvent(orgId, actorId || "system", receiptId, "FISCAL_RECEIPT_CREATED", { fiscalDocumentId, storeId: doc.store_id, items: items.length }); } catch { /* noop */ }
    return { status: "created", receiptId };
  }

  /** Recebimento fiscal (cabeçalho + itens + divergência calculada), ou null. */
  static getReceipt(orgId: string, receiptId: string): any | null {
    const receipt = db.prepare(`SELECT * FROM retail_goods_receipts WHERE organization_id = ? AND id = ?`).get(orgId, receiptId) as any;
    if (!receipt) return null;
    const rows = db.prepare(`SELECT * FROM fiscal_goods_receipt_items WHERE receipt_id = ? ORDER BY created_at`).all(receiptId) as any[];
    let unmapped = 0, divergences = 0;
    receipt.items = rows.map((r) => {
      const expected = Number(r.expected_qty || 0);
      const received = Number(r.received_qty || 0);
      const status = this.divergenceStatus(expected, received);
      if (r.mapping_status === "unresolved") unmapped++;
      if (status !== "ok" && status !== "pending") divergences++;
      return { ...r, divergence_status: status };
    });
    receipt.unmapped = unmapped;
    receipt.divergences = divergences;
    return receipt;
  }

  /** Divergência esperado × recebido (decimal). */
  private static divergenceStatus(expected: number, received: number): string {
    if (expected > 0 && received === expected) return "ok";
    if (expected > 0 && received === 0) return "missing";
    if (expected > 0 && received < expected) return "short";
    if (expected > 0 && received > expected) return "over";
    if (expected === 0 && received > 0) return "unexpected";
    return "pending";
  }
}

export default FiscalReceivingService;
