/**
 * Retail Ops — Recebimento de mercadoria / pré-estoque (ADR-086).
 *
 * Máquina de estados do recebimento: um documento nasce ABERTO (opcionalmente
 * com o esperado de um pedido de compra), a equipe BIPA o que chega, o sistema
 * confere contra o esperado e, ao CONFIRMAR, libera para o estoque — no ledger
 * AUTORITATIVO do modo (ADR-084 D4): native→núcleo, supervised→sombra da loja.
 * Divergências (faltou/sobrou/veio sem pedido) ficam explícitas. Isolado por org.
 */
import { randomUUID } from "node:crypto";
import db from "./db.js";
import { RetailScanService } from "./RetailScanService.js";
import { InventoryService } from "./InventoryService.js";
import { RetailInventoryService } from "./RetailInventoryService.js";
import { RetailStockModeService } from "./RetailStockModeService.js";
import { logAuthEvent } from "./auditLog.js";

function num(v: any): number { return Number(v || 0); }

function divergenceStatus(expected: number, received: number): string {
  if (expected > 0 && received === expected) return "ok";
  if (expected > 0 && received === 0) return "missing";     // não veio
  if (expected > 0 && received < expected) return "short";  // faltou
  if (expected > 0 && received > expected) return "over";   // veio a mais
  if (expected === 0 && received > 0) return "unexpected";  // veio sem estar no pedido
  return "pending";
}

export class RetailReceivingService {
  private static resolveProduct(orgId: string, item: { productId?: string; ean?: string }): { id: string; ean: string | null } | null {
    if (item.productId) {
      const p = db.prepare(`SELECT id, ean FROM products_services WHERE organization_id = ? AND id = ?`).get(orgId, item.productId) as any;
      return p ? { id: p.id, ean: p.ean || null } : null;
    }
    if (item.ean) {
      const hit = RetailScanService.lookupByEan(orgId, item.ean);
      return hit.found ? { id: hit.product.id, ean: hit.product.ean } : null;
    }
    return null;
  }

  /** Abre um recebimento (opcionalmente já com o esperado do pedido de compra). */
  static createReceipt(orgId: string, input: { storeId?: string | null; note?: string; expected?: Array<{ productId?: string; ean?: string; qty: number }> }, actorId?: string): any {
    const id = randomUUID();
    db.prepare(`INSERT INTO retail_goods_receipts (id, organization_id, store_id, status, note, created_by) VALUES (?, ?, ?, 'open', ?, ?)`)
      .run(id, orgId, input.storeId || null, input.note || null, actorId || null);
    for (const e of Array.isArray(input.expected) ? input.expected : []) {
      const prod = this.resolveProduct(orgId, e);
      if (!prod) continue; // item esperado sem produto resolvível é ignorado
      db.prepare(`INSERT OR IGNORE INTO retail_goods_receipt_items (id, organization_id, receipt_id, product_service_id, ean, expected_qty, received_qty) VALUES (?, ?, ?, ?, ?, ?, 0)`)
        .run(randomUUID(), orgId, id, prod.id, prod.ean, Math.trunc(num(e.qty)));
    }
    try { logAuthEvent(orgId, actorId || "system", id, "RETAIL_RECEIPT_OPENED", { storeId: input.storeId || null }); } catch { /* noop */ }
    return this.getReceipt(orgId, id);
  }

  /** Bipa um item no recebimento aberto (soma à quantidade recebida). */
  static scanItem(orgId: string, receiptId: string, ean: string, qty: number, actorId?: string): any {
    const receipt = db.prepare(`SELECT * FROM retail_goods_receipts WHERE organization_id = ? AND id = ?`).get(orgId, receiptId) as any;
    if (!receipt) throw new Error("receipt_not_found");
    if (receipt.status !== "open") throw new Error("receipt_not_open");
    const q = Math.trunc(num(qty)) || 1;
    const hit = RetailScanService.lookupByEan(orgId, ean);
    if (!hit.found) return { found: false, ...hit };
    const existing = db.prepare(`SELECT id, received_qty FROM retail_goods_receipt_items WHERE receipt_id = ? AND product_service_id = ?`).get(receiptId, hit.product.id) as any;
    if (existing) {
      db.prepare(`UPDATE retail_goods_receipt_items SET received_qty = received_qty + ? WHERE id = ?`).run(q, existing.id);
    } else {
      db.prepare(`INSERT INTO retail_goods_receipt_items (id, organization_id, receipt_id, product_service_id, ean, expected_qty, received_qty) VALUES (?, ?, ?, ?, ?, 0, ?)`)
        .run(randomUUID(), orgId, receiptId, hit.product.id, hit.product.ean, q);
    }
    return { found: true, receipt: this.getReceipt(orgId, receiptId) };
  }

  /**
   * Confirma o recebimento: credita o recebido no ledger autoritativo e fecha o
   * documento. Divergências ficam registradas no próprio doc. Idempotente por
   * status (só confirma o que está 'open').
   */
  static confirm(orgId: string, receiptId: string, actorId?: string): any {
    const receipt = db.prepare(`SELECT * FROM retail_goods_receipts WHERE organization_id = ? AND id = ?`).get(orgId, receiptId) as any;
    if (!receipt) throw new Error("receipt_not_found");
    if (receipt.status !== "open") throw new Error("receipt_not_open");
    const ledger = RetailStockModeService.authoritativeLedger(orgId, receipt.store_id);
    if (ledger === "shadow" && !receipt.store_id) throw new Error("store_required");

    const items = db.prepare(`SELECT product_service_id, received_qty FROM retail_goods_receipt_items WHERE receipt_id = ?`).all(receiptId) as any[];
    for (const it of items) {
      const q = Math.trunc(num(it.received_qty));
      if (q <= 0) continue;
      if (ledger === "shadow") {
        RetailInventoryService.applyMovement(orgId, receipt.store_id, it.product_service_id, null, q, actorId);
      } else {
        InventoryService.recordMovement(orgId, { productId: it.product_service_id, type: "entrada", quantity: q, origin: "recebimento", createdBy: actorId });
      }
    }
    db.prepare(`UPDATE retail_goods_receipts SET status = 'confirmed', confirmed_at = CURRENT_TIMESTAMP WHERE organization_id = ? AND id = ?`).run(orgId, receiptId);
    try { logAuthEvent(orgId, actorId || "system", receiptId, "RETAIL_RECEIPT_CONFIRMED", { ledger, items: items.length }); } catch { /* noop */ }
    return this.getReceipt(orgId, receiptId);
  }

  static getReceipt(orgId: string, receiptId: string): any {
    const receipt = db.prepare(`SELECT * FROM retail_goods_receipts WHERE organization_id = ? AND id = ?`).get(orgId, receiptId) as any;
    if (!receipt) return null;
    const rows = db.prepare(
      `SELECT i.product_service_id, i.ean, i.expected_qty, i.received_qty, p.name AS product_name
         FROM retail_goods_receipt_items i LEFT JOIN products_services p ON p.id = i.product_service_id
        WHERE i.receipt_id = ? ORDER BY p.name`
    ).all(receiptId) as any[];
    let divergences = 0;
    receipt.items = rows.map((r) => {
      const status = divergenceStatus(num(r.expected_qty), num(r.received_qty));
      if (status !== "ok" && status !== "pending") divergences++;
      return { productId: r.product_service_id, name: r.product_name, ean: r.ean, expected: num(r.expected_qty), received: num(r.received_qty), status };
    });
    receipt.divergences = divergences;
    return receipt;
  }

  static listReceipts(orgId: string, status?: string): any[] {
    const q = status
      ? db.prepare(`SELECT * FROM retail_goods_receipts WHERE organization_id = ? AND status = ? ORDER BY created_at DESC`).all(orgId, status)
      : db.prepare(`SELECT * FROM retail_goods_receipts WHERE organization_id = ? ORDER BY created_at DESC`).all(orgId);
    return q as any[];
  }
}
