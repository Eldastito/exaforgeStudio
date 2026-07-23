import db from "./db.js";
import { randomUUID } from "crypto";

/**
 * PurchaseOrderService (Epic 5 — Comprador IA, fatia E5.1).
 *
 * Fecha a ponta "cotação aceita → ORDEM DE COMPRA". A ordem é um SNAPSHOT
 * IMUTÁVEL dos itens da cotação vencedora (nome, quantidade, preço no momento
 * do aceite) — não referencia a cotação para exibir valores, congela-os. Guarda
 * central do PRD §16: **uma cotação aceita gera exatamente uma ordem**
 * (idempotente por `UNIQUE(organization_id, quote_id)`). Determinístico,
 * isolado por organization_id. Não envia nada ao fornecedor (isso é fatia
 * posterior, após aprovação de envio).
 */

const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

export class PurchaseOrderService {
  /** Ordem já criada para esta cotação (idempotência). */
  static getByQuote(orgId: string, quoteId: string): any | null {
    return db.prepare("SELECT * FROM purchase_orders WHERE organization_id = ? AND quote_id = ?").get(orgId, quoteId) as any || null;
  }

  /**
   * Cria a ordem de compra a partir de uma cotação ACEITA. Idempotente: se já
   * existe ordem para a cotação, devolve a existente (não cria a segunda).
   * A quantidade pedida é o mínimo entre o solicitado na requisição e o
   * disponível informado pelo fornecedor (fallback: solicitado).
   */
  static createFromQuote(orgId: string, quoteId: string, opts: { createdBy?: string } = {}): { ok: boolean; id: string | null; deduped: boolean; error?: string } {
    const existing = this.getByQuote(orgId, quoteId);
    if (existing) return { ok: true, id: existing.id, deduped: true };

    const quote = db.prepare("SELECT * FROM purchase_quotes WHERE id = ? AND organization_id = ? AND status = 'accepted'").get(quoteId, orgId) as any;
    if (!quote) return { ok: false, id: null, deduped: false, error: "Cotação não encontrada ou não aceita." };

    const qItems = db.prepare("SELECT * FROM purchase_quote_items WHERE quote_id = ?").all(quoteId) as any[];
    const reqItems = db.prepare("SELECT product_service_id, suggested_qty FROM purchase_requisition_items WHERE requisition_id = ?").all(quote.requisition_id) as any[];
    const wantedByPid = new Map(reqItems.map((r) => [String(r.product_service_id), Number(r.suggested_qty) || 0]));

    const supplierName = quote.supplier_contact_id
      ? (db.prepare("SELECT name FROM contacts WHERE id = ?").get(quote.supplier_contact_id) as any)?.name || null
      : (db.prepare("SELECT business_name FROM organization_settings WHERE organization_id = ?").get(quote.network_org_id) as any)?.business_name || "Fornecedor da rede";

    const orderId = randomUUID();
    const tx = db.transaction(() => {
      const insItem = db.prepare(`INSERT INTO purchase_order_items (id, purchase_order_id, organization_id, product_service_id, product_name, ordered_qty, unit_price, line_total) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
      let total = 0;
      for (const qi of qItems) {
        const wanted = wantedByPid.has(String(qi.product_service_id)) ? (wantedByPid.get(String(qi.product_service_id)) as number) : null;
        const avail = qi.available_qty != null ? Number(qi.available_qty) : null;
        const qty = avail != null ? Math.min(wanted ?? avail, avail) : (wanted ?? 0);
        const unit = qi.unit_price != null ? Number(qi.unit_price) : null;
        const line = unit != null ? round2(unit * qty) : null;
        if (line != null) total += line;
        insItem.run(randomUUID(), orderId, orgId, qi.product_service_id, qi.product_name || null, qty, unit, line);
      }
      db.prepare(`INSERT INTO purchase_orders (id, organization_id, requisition_id, quote_id, supplier_contact_id, network_org_id, supplier_name, status, total_amount, delivery_days, notes, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)`)
        .run(orderId, orgId, quote.requisition_id, quoteId, quote.supplier_contact_id || null, quote.network_org_id || null, supplierName, round2(total), quote.delivery_days || null, quote.notes || null, opts.createdBy || null);
    });
    try { tx(); }
    catch (e: any) {
      // Corrida com a UNIQUE(org, quote_id): se outra chamada criou primeiro,
      // devolve a existente em vez de falhar (mantém a idempotência).
      const dup = this.getByQuote(orgId, quoteId);
      if (dup) return { ok: true, id: dup.id, deduped: true };
      return { ok: false, id: null, deduped: false, error: e?.message || "Falha ao criar a ordem." };
    }
    return { ok: true, id: orderId, deduped: false };
  }

  static get(orgId: string, id: string): any | null {
    const o = db.prepare("SELECT * FROM purchase_orders WHERE id = ? AND organization_id = ?").get(id, orgId) as any;
    if (!o) return null;
    o.items = db.prepare("SELECT * FROM purchase_order_items WHERE purchase_order_id = ? ORDER BY product_name").all(id);
    return o;
  }

  static listByRequisition(orgId: string, reqId: string): any[] {
    return db.prepare("SELECT * FROM purchase_orders WHERE organization_id = ? AND requisition_id = ? ORDER BY created_at DESC").all(orgId, reqId) as any[];
  }

  static list(orgId: string, opts: { status?: string } = {}): any[] {
    let sql = "SELECT * FROM purchase_orders WHERE organization_id = ?";
    const params: any[] = [orgId];
    if (opts.status) { sql += " AND status = ?"; params.push(opts.status); }
    sql += " ORDER BY created_at DESC LIMIT 200";
    return db.prepare(sql).all(...params) as any[];
  }
}

export default PurchaseOrderService;
