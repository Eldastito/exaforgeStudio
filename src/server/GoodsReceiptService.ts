import db from "./db.js";
import { randomUUID } from "crypto";
import { InventoryService } from "./InventoryService.js";
import { BusinessSignalService } from "./BusinessSignalService.js";
import { TaskService } from "./TaskService.js";

/**
 * GoodsReceiptService (Epic 5 — Comprador IA, fatia E5.2).
 *
 * Recebimento de uma ordem de compra: completo, parcial, item divergente,
 * quantidade divergente, avaria, nota ausente (PRD §16, item 6). Guardas:
 *   - o estoque entra SÓ pela quantidade CONFIRMADA boa (item 7) — avaria/item
 *     errado NÃO entram;
 *   - recebimento parcial NÃO encerra o saldo pendente (aceite §16);
 *   - toda divergência gera SINAL + TAREFA — nunca baixa silenciosa (aceite §16).
 * Determinístico (o sinal é determinístico; a IA não decide nada aqui), isolado
 * por organization_id.
 */

const CONDITIONS = ["ok", "damaged", "wrong_item", "missing"] as const;
type Condition = (typeof CONDITIONS)[number];

export interface ReceiveItemInput { purchaseOrderItemId: string; receivedQty: number; condition?: string; note?: string }
export interface ReceiveInput { invoicePresent?: boolean; notes?: string; items: ReceiveItemInput[] }

export class GoodsReceiptService {
  /**
   * Registra um recebimento contra a ordem. Atualiza `received_qty` dos itens,
   * dá entrada no estoque só do que foi confirmado bom, e emite sinal+tarefa
   * para cada divergência. Recalcula o status da ordem (receiving/received).
   */
  static receive(orgId: string, poId: string, input: ReceiveInput, actorId?: string): any {
    const po = db.prepare("SELECT * FROM purchase_orders WHERE id = ? AND organization_id = ?").get(poId, orgId) as any;
    if (!po) throw new Error("Ordem de compra não encontrada.");
    if (["received", "cancelled"].includes(po.status)) throw new Error(`Ordem já finalizada (${po.status}).`);
    if (!Array.isArray(input?.items) || input.items.length === 0) throw new Error("Informe ao menos um item recebido.");

    const invoicePresent = input.invoicePresent === false ? 0 : 1;
    const receiptId = randomUUID();
    const divergences: any[] = [];
    const stockEntered: { productServiceId: string; qty: number }[] = [];

    const tx = db.transaction(() => {
      db.prepare("INSERT INTO goods_receipts (id, organization_id, purchase_order_id, kind, invoice_present, has_divergence, notes, received_by) VALUES (?, ?, ?, 'partial', ?, 0, ?, ?)")
        .run(receiptId, orgId, poId, invoicePresent, input.notes || null, actorId || null);

      const insItem = db.prepare(`INSERT INTO goods_receipt_items (id, goods_receipt_id, organization_id, purchase_order_item_id, product_service_id, product_name, expected_qty, received_qty, good_qty, condition, divergence, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

      for (const it of input.items) {
        const poi = db.prepare("SELECT * FROM purchase_order_items WHERE id = ? AND purchase_order_id = ? AND organization_id = ?").get(it.purchaseOrderItemId, poId, orgId) as any;
        if (!poi) continue;
        const pendingBefore = Math.max(0, Number(poi.ordered_qty) - Number(poi.received_qty));
        const received = Math.max(0, Math.trunc(Number(it.receivedQty) || 0));
        const condition: Condition = (CONDITIONS as readonly string[]).includes(it.condition as any) ? (it.condition as Condition) : "ok";
        // Só quantidade em boas condições vira estoque (item 7).
        const good = condition === "ok" ? received : 0;

        // Classifica a divergência. Sub-entrega em boas condições é recebimento
        // PARCIAL normal (saldo fica pendente), NÃO divergência. Divergência =
        // avaria/item errado/faltante ou entrega A MAIS.
        let divergence: string | null = null;
        if (condition === "damaged") divergence = "damaged";
        else if (condition === "wrong_item") divergence = "wrong_item";
        else if (condition === "missing") divergence = "missing";
        else if (received > pendingBefore) divergence = "over";

        insItem.run(randomUUID(), receiptId, orgId, poi.id, poi.product_service_id, poi.product_name || null, pendingBefore, received, good, condition, divergence, it.note || null);

        // Entrada no estoque só do confirmado bom.
        if (good > 0) {
          try {
            InventoryService.recordMovement(orgId, { productId: poi.product_service_id, type: "entrada", quantity: good, unitCost: poi.unit_price != null ? Number(poi.unit_price) : undefined, origin: "recebimento_compra", note: `OC ${poId.slice(0, 8)}`, createdBy: actorId || null, supplierContactId: po.supplier_contact_id || null });
            db.prepare("UPDATE purchase_order_items SET received_qty = received_qty + ? WHERE id = ?").run(good, poi.id);
            stockEntered.push({ productServiceId: poi.product_service_id, qty: good });
          } catch (e) { /* estoque é aditivo; a divergência abaixo cobre a exceção */ divergence = divergence || "shortfall"; }
        }

        if (divergence) divergences.push({ poItemId: poi.id, productName: poi.product_name, productServiceId: poi.product_service_id, expected: pendingBefore, received, good, condition, divergence });
      }

      // Status da ordem: 'received' só quando TODOS os itens foram plenamente
      // recebidos; senão 'receiving' (parcial não encerra saldo pendente).
      const items = db.prepare("SELECT ordered_qty, received_qty FROM purchase_order_items WHERE purchase_order_id = ? AND organization_id = ?").all(poId, orgId) as any[];
      const allDone = items.length > 0 && items.every((i) => Number(i.received_qty) >= Number(i.ordered_qty));
      if (allDone) db.prepare("UPDATE purchase_orders SET status = 'received', received_at = CURRENT_TIMESTAMP WHERE id = ? AND organization_id = ?").run(poId, orgId);
      else db.prepare("UPDATE purchase_orders SET status = 'receiving' WHERE id = ? AND organization_id = ?").run(poId, orgId);

      const hasDiv = divergences.length > 0 || invoicePresent === 0;
      db.prepare("UPDATE goods_receipts SET kind = ?, has_divergence = ? WHERE id = ?").run(allDone ? "complete" : "partial", hasDiv ? 1 : 0, receiptId);
    });
    tx();

    // Fora da transação de recebimento: sinais + tarefas de divergência (não
    // baixa silenciosa). Determinístico; não bloqueia o recebimento se falhar.
    this.raiseDivergences(orgId, poId, receiptId, divergences, invoicePresent === 0, actorId);

    const poAfter = db.prepare("SELECT status FROM purchase_orders WHERE id = ? AND organization_id = ?").get(poId, orgId) as any;
    return { ok: true, receiptId, poStatus: poAfter?.status, divergences, stockEntered };
  }

  private static raiseDivergences(orgId: string, poId: string, receiptId: string, divergences: any[], noInvoice: boolean, actorId?: string) {
    const label: Record<string, string> = { shortfall: "quantidade a menos", over: "quantidade a mais", damaged: "avaria", wrong_item: "item errado", missing: "item não recebido" };
    for (const d of divergences) {
      try {
        BusinessSignalService.publish(orgId, {
          domain: "procurement", signalType: "goods_receipt_divergence", severity: d.divergence === "damaged" || d.divergence === "missing" ? "risk" : "attention",
          basis: "fact", confidence: 1, sourceService: "GoodsReceiptService", sourceEntityType: "purchase_order", sourceEntityId: poId,
          evidence: { receiptId, product: d.productName, expected: d.expected, received: d.received, good: d.good, condition: d.condition, divergence: d.divergence },
          dedupeKey: `procurement:receipt_divergence:${receiptId}:${d.poItemId}`,
        });
      } catch (e) { /* sinal é aditivo */ }
      try {
        TaskService.create(orgId, { title: `Divergência no recebimento: ${d.productName || "item"} (${label[d.divergence] || d.divergence})`, description: `Esperado ${d.expected}, recebido ${d.received} (bom: ${d.good}). Providencie a tratativa com o fornecedor.`, priority: d.divergence === "damaged" || d.divergence === "missing" ? "alta" : "media", source: "ia", refLabel: `OC ${poId.slice(0, 8)}` }, actorId);
      } catch (e) { /* tarefa é aditiva */ }
    }
    if (noInvoice) {
      try {
        BusinessSignalService.publish(orgId, { domain: "procurement", signalType: "goods_receipt_no_invoice", severity: "attention", basis: "fact", confidence: 1, sourceService: "GoodsReceiptService", sourceEntityType: "purchase_order", sourceEntityId: poId, evidence: { receiptId }, dedupeKey: `procurement:receipt_no_invoice:${receiptId}` });
      } catch (e) { /* aditivo */ }
      try { TaskService.create(orgId, { title: "Recebimento sem nota fiscal", description: "Cobrar a nota fiscal do fornecedor referente a este recebimento.", priority: "media", source: "ia", refLabel: `OC ${poId.slice(0, 8)}` }, actorId); } catch (e) { /* aditivo */ }
    }
  }

  static get(orgId: string, receiptId: string): any | null {
    const r = db.prepare("SELECT * FROM goods_receipts WHERE id = ? AND organization_id = ?").get(receiptId, orgId) as any;
    if (!r) return null;
    r.items = db.prepare("SELECT * FROM goods_receipt_items WHERE goods_receipt_id = ? ORDER BY product_name").all(receiptId);
    return r;
  }

  /** Recebimentos de uma ordem (mais recente primeiro). */
  static listByOrder(orgId: string, poId: string): any[] {
    return db.prepare("SELECT * FROM goods_receipts WHERE organization_id = ? AND purchase_order_id = ? ORDER BY created_at DESC").all(orgId, poId) as any[];
  }
}

export default GoodsReceiptService;
