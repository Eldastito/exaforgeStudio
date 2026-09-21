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
import { RetailStockModeService } from "./RetailStockModeService.js";
import { InventoryService } from "./InventoryService.js";
import { RetailInventoryService } from "./RetailInventoryService.js";
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

  /**
   * Registra a quantidade CONFERIDA (decimal) de um item, num recebimento aberto.
   * Aceita quantidade recebida e, opcionalmente, avaria. Não movimenta estoque.
   */
  static setReceived(orgId: string, receiptId: string, itemId: string, receivedQty: number, opts: { damageQty?: number; divergenceReason?: string } = {}): { ok: boolean; reason?: string } {
    const receipt = db.prepare(`SELECT status FROM retail_goods_receipts WHERE organization_id = ? AND id = ?`).get(orgId, receiptId) as any;
    if (!receipt) return { ok: false, reason: "receipt_not_found" };
    if (receipt.status !== "open") return { ok: false, reason: "receipt_not_open" };
    const item = db.prepare(`SELECT id FROM fiscal_goods_receipt_items WHERE organization_id = ? AND receipt_id = ? AND id = ?`).get(orgId, receiptId, itemId) as any;
    if (!item) return { ok: false, reason: "item_not_found" };
    const received = Math.max(0, Number(receivedQty) || 0);        // decimal preservado
    const damage = Math.max(0, Number(opts.damageQty) || 0);
    db.prepare(`UPDATE fiscal_goods_receipt_items SET received_qty = ?, damage_qty = ?, divergence_reason = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(received, damage, opts.divergenceReason || null, itemId);
    return { ok: true };
  }

  /**
   * Confirma o recebimento: credita SÓ o recebido no ledger AUTORITATIVO
   * (RetailStockModeService: core em native, shadow em supervised), em transação
   * e idempotente por chave de movimento (receipt_id + item_id + kind).
   *
   * Decisão de produto (ledgers são inteiros): credita apenas quantidade INTEIRA.
   * Quantidade FRACIONADA não é creditada — vira exceção sinalizada
   * (ledger_status = 'fractional_pending'), nunca truncada em silêncio. Itens sem
   * produto (unmapped) e não-estocáveis são pulados e sinalizados.
   */
  static confirm(orgId: string, receiptId: string, actorId?: string): { status: "confirmed" | "already" | "blocked"; reason?: string; credited?: number; skipped?: number } {
    const receipt = db.prepare(`SELECT * FROM retail_goods_receipts WHERE organization_id = ? AND id = ?`).get(orgId, receiptId) as any;
    if (!receipt) return { status: "blocked", reason: "receipt_not_found" };
    if (receipt.status === "confirmed") return { status: "already" };          // idempotente
    if (receipt.status !== "open") return { status: "blocked", reason: "receipt_not_open" };

    const ledger = RetailStockModeService.authoritativeLedger(orgId, receipt.store_id);
    if (ledger === "shadow" && !receipt.store_id) return { status: "blocked", reason: "store_required" };

    const items = db.prepare(`SELECT * FROM fiscal_goods_receipt_items WHERE receipt_id = ?`).all(receiptId) as any[];
    let credited = 0, skipped = 0;

    const tx = db.transaction(() => {
      for (const it of items) {
        const received = Number(it.received_qty || 0);
        let status: string;
        if (!it.product_service_id) status = "unmapped";
        else if (!it.is_stockable) status = "not_stockable";
        else if (received <= 0) status = "zero";
        else if (!Number.isInteger(received)) status = "fractional_pending"; // não credita fração
        else {
          // Chave de movimento idempotente: se já existe, não credita de novo.
          const key = db.prepare(`SELECT id FROM fiscal_receipt_movements WHERE receipt_id = ? AND receipt_item_id = ? AND movement_kind = 'entrada'`).get(receiptId, it.id) as any;
          if (key) { status = "credited"; }
          else {
            const qty = received; // inteiro validado acima
            if (ledger === "shadow") {
              RetailInventoryService.applyMovement(orgId, receipt.store_id, it.product_service_id, it.variant_id || null, qty, actorId);
            } else {
              InventoryService.recordMovement(orgId, { productId: it.product_service_id, variantId: it.variant_id || null, type: "entrada", quantity: qty, origin: "nfe_receipt", createdBy: actorId });
            }
            db.prepare(`INSERT INTO fiscal_receipt_movements (id, organization_id, receipt_id, receipt_item_id, movement_kind, ledger, quantity) VALUES (?, ?, ?, ?, 'entrada', ?, ?)`)
              .run(randomUUID(), orgId, receiptId, it.id, ledger, qty);
            status = "credited";
          }
          credited++;
        }
        if (status !== "credited") skipped++;
        db.prepare(`UPDATE fiscal_goods_receipt_items SET ledger_status = ? WHERE id = ?`).run(status, it.id);
      }
      db.prepare(`UPDATE retail_goods_receipts SET status = 'confirmed', confirmed_at = CURRENT_TIMESTAMP WHERE organization_id = ? AND id = ?`).run(orgId, receiptId);
      if (receipt.fiscal_document_id) {
        db.prepare(`UPDATE fiscal_documents SET processing_state = 'completed', updated_at = CURRENT_TIMESTAMP WHERE organization_id = ? AND id = ?`).run(orgId, receipt.fiscal_document_id);
      }
    });
    tx();

    try { logAuthEvent(orgId, actorId || "system", receiptId, "FISCAL_RECEIPT_CONFIRMED", { ledger, credited, skipped }); } catch { /* noop */ }
    return { status: "confirmed", credited, skipped };
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
