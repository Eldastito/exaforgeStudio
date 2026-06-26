import db from "./db.js";
import { v4 as uuidv4 } from "uuid";
import { chat } from "./llm.js";
import { MessageProviderService } from "./MessageProviderService.js";
import { NotificationService } from "./NotificationService.js";

/**
 * Cotação com fornecedores conhecidos (Fase 2 do Supply).
 *
 * Fluxo:
 *  1. Humano aprova uma purchase_requisition (Fase 1).
 *  2. SupplierQuoteService.sendQuotes: dispara a lista de itens para os
 *     fornecedores marcados (contacts.is_supplier=1), via WhatsApp, e cria
 *     uma purchase_quote por fornecedor (status='sent').
 *  3. Quando o fornecedor responde, o webhookProcessor pergunta a este serviço
 *     se há cotação pendente; se sim, manda parsear (LLM) e grava preços/prazo.
 *  4. UI mostra o comparativo; humano clica em "Confirmar com fornecedor X".
 */
export class SupplierQuoteService {
  /** Existe cotação aberta enviada a este fornecedor (contato) recentemente? */
  static pendingForSupplier(orgId: string, contactId: string, withinHours = 168): any | null {
    return db.prepare(`SELECT * FROM purchase_quotes WHERE organization_id = ? AND supplier_contact_id = ? AND status = 'sent' AND sent_at >= datetime('now', ?) ORDER BY sent_at DESC LIMIT 1`)
      .get(orgId, contactId, `-${withinHours} hours`) as any || null;
  }

  /** Lista os fornecedores aptos a cotar a requisição (por categoria, se houver). */
  static eligibleSuppliers(orgId: string, reqId: string): any[] {
    // Pega as categorias dos produtos da requisição (se cadastradas).
    const cats = db.prepare(`
      SELECT DISTINCT p.category AS cat
      FROM purchase_requisition_items ri
      JOIN products_services p ON p.id = ri.product_service_id
      WHERE ri.requisition_id = ? AND p.category IS NOT NULL AND TRIM(p.category) != ''
    `).all(reqId) as any[];
    const catList = cats.map(c => String(c.cat).toLowerCase().trim()).filter(Boolean);

    const suppliers = db.prepare(`
      SELECT id, name, identifier, channel_id, supplier_categories
      FROM contacts
      WHERE organization_id = ? AND COALESCE(is_supplier,0) = 1 AND identifier IS NOT NULL
    `).all(orgId) as any[];

    if (catList.length === 0) return suppliers; // sem categorias → manda pra todos
    return suppliers.filter(s => {
      const sc = String(s.supplier_categories || "").toLowerCase().split(",").map((x: string) => x.trim()).filter(Boolean);
      if (sc.length === 0) return true; // fornecedor sem categoria definida = aceita tudo
      return sc.some((c: string) => catList.includes(c));
    });
  }

  /** Monta a mensagem de cotação enviada ao fornecedor. */
  private static buildQuoteMessage(orgName: string, supplierName: string, items: any[]): string {
    const first = (supplierName || "").trim().split(/\s+/)[0] || "";
    const lines = items.map((it, i) => `${i + 1}. ${it.product_name}${it.variant_name ? ` (${it.variant_name})` : ""} — *${it.suggested_qty} un.*`).join("\n");
    return [
      `Olá${first ? `, ${first}` : ""}! 👋`,
      `Aqui é da equipe de compras do ${orgName || "nosso estabelecimento"}.`,
      `Preciso cotar os itens abaixo. Pode me passar *preço por unidade*, *quantidade disponível* e *prazo de entrega*?`,
      ``,
      lines,
      ``,
      `Se puder responder por aqui mesmo, agradeço! 🙏`,
    ].join("\n");
  }

  /** Dispara as cotações para os fornecedores elegíveis. Retorna nº enviadas. */
  static async sendQuotes(orgId: string, reqId: string, io?: any): Promise<{ sent: number }> {
    const items = db.prepare(`
      SELECT ri.product_service_id, ri.variant_id, ri.suggested_qty,
             p.name AS product_name, pv.name AS variant_name
      FROM purchase_requisition_items ri
      JOIN products_services p ON p.id = ri.product_service_id
      LEFT JOIN product_variants pv ON pv.id = ri.variant_id
      WHERE ri.requisition_id = ?
    `).all(reqId) as any[];
    if (items.length === 0) return { sent: 0 };

    const suppliers = this.eligibleSuppliers(orgId, reqId);
    if (suppliers.length === 0) return { sent: 0 };

    const o = db.prepare("SELECT business_name FROM organization_settings WHERE organization_id = ?").get(orgId) as any;
    const fallbackChannel = db.prepare(`SELECT id FROM channels WHERE organization_id = ? AND status != 'disabled' ORDER BY (provider LIKE 'evolution%') DESC, created_at ASC LIMIT 1`).get(orgId) as any;

    let sent = 0;
    for (const s of suppliers) {
      try {
        const channelId = s.channel_id || fallbackChannel?.id;
        if (!channelId || !s.identifier) continue;
        const quoteId = uuidv4();
        db.prepare(`INSERT INTO purchase_quotes (id, organization_id, requisition_id, supplier_contact_id, status) VALUES (?, ?, ?, ?, 'sent')`)
          .run(quoteId, orgId, reqId, s.id);
        const message = this.buildQuoteMessage(o?.business_name || "", s.name, items);
        await MessageProviderService.sendMessage(channelId, s.identifier, message);
        sent++;
        if (io) io.to(`org:${orgId}`).emit("supplier_quote_sent", { quoteId, supplierId: s.id });
      } catch (e) { console.error("[Supply] Falha ao enviar cotação para", s.name, e); }
    }
    return { sent };
  }

  /**
   * Parseia a resposta livre do fornecedor (texto) em preços/disponibilidade/prazo,
   * comparando contra os itens da requisição. Usa o LLM com JSON forçado.
   */
  static async parseSupplierReply(orgId: string, quote: any, replyText: string): Promise<boolean> {
    const items = db.prepare(`
      SELECT ri.product_service_id, ri.suggested_qty, p.name AS product_name, pv.name AS variant_name
      FROM purchase_requisition_items ri
      JOIN products_services p ON p.id = ri.product_service_id
      LEFT JOIN product_variants pv ON pv.id = ri.variant_id
      WHERE ri.requisition_id = ?
    `).all(quote.requisition_id) as any[];
    if (items.length === 0) return false;

    const catalog = items.map((it, i) => `${i + 1}. id="${it.product_service_id}" nome="${it.product_name}${it.variant_name ? ' (' + it.variant_name + ')' : ''}" pedido=${it.suggested_qty}`).join("\n");
    const prompt = `Você é um assistente de compras. O fornecedor respondeu uma cotação em TEXTO LIVRE. Extraia os preços, disponibilidade e prazo. NÃO invente.

ITENS PEDIDOS:
${catalog}

RESPOSTA DO FORNECEDOR:
"""${replyText}"""

DEVOLVA APENAS UM JSON neste formato (em reais e dias; use null se o fornecedor não informou):
{
  "delivery_days": 3,
  "items": [
    { "product_service_id": "...", "unit_price": 12.5, "available_qty": 20 }
  ],
  "notes": "observação opcional do fornecedor"
}`;
    let parsed: any;
    try {
      const raw = await chat(prompt, { temperature: 0, json: true });
      parsed = JSON.parse(raw);
    } catch (e) { console.error("[Supply] Falha ao parsear cotação", e); return false; }

    const tx = db.transaction(() => {
      let total = 0;
      const ins = db.prepare(`INSERT INTO purchase_quote_items (id, quote_id, organization_id, product_service_id, product_name, unit_price, available_qty, line_total) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const it of Array.isArray(parsed.items) ? parsed.items : []) {
        const ref = items.find(x => String(x.product_service_id) === String(it.product_service_id));
        if (!ref) continue;
        const unit = Number(it.unit_price) || 0;
        const avail = it.available_qty != null ? Math.max(0, parseInt(String(it.available_qty), 10) || 0) : null;
        // Linha = unit × min(pedido, disponível).
        const qty = avail != null ? Math.min(ref.suggested_qty, avail) : ref.suggested_qty;
        const line = Math.round(unit * qty * 100) / 100;
        ins.run(uuidv4(), quote.id, orgId, ref.product_service_id, ref.product_name, unit, avail, line);
        total += line;
      }
      db.prepare(`UPDATE purchase_quotes SET status = 'answered', delivery_days = ?, total_amount = ?, notes = COALESCE(?, notes), answered_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .run(parsed.delivery_days || null, Math.round(total * 100) / 100, parsed.notes || null, quote.id);
    });
    tx();
    try { NotificationService.lowStock(orgId, "Nova cotação respondida", 0); } catch (e) { /* reuso da notificação */ }
    return true;
  }

  /** Lista as cotações de uma requisição com seus itens. */
  static listByRequisition(orgId: string, reqId: string): any[] {
    const quotes = db.prepare(`
      SELECT q.*, c.name AS supplier_name
      FROM purchase_quotes q
      JOIN contacts c ON c.id = q.supplier_contact_id
      WHERE q.organization_id = ? AND q.requisition_id = ?
      ORDER BY q.total_amount ASC NULLS LAST, q.sent_at ASC
    `).all(orgId, reqId) as any[];
    for (const q of quotes) {
      q.items = db.prepare(`SELECT * FROM purchase_quote_items WHERE quote_id = ?`).all(q.id);
    }
    return quotes;
  }

  /** Confirma o vencedor (marca esta como aceita e as demais como rejeitadas). */
  static accept(orgId: string, quoteId: string): boolean {
    const q = db.prepare(`SELECT * FROM purchase_quotes WHERE id = ? AND organization_id = ?`).get(quoteId, orgId) as any;
    if (!q) return false;
    const tx = db.transaction(() => {
      db.prepare(`UPDATE purchase_quotes SET status = 'accepted', accepted_at = CURRENT_TIMESTAMP WHERE id = ?`).run(quoteId);
      db.prepare(`UPDATE purchase_quotes SET status = 'rejected' WHERE requisition_id = ? AND id != ? AND status IN ('sent','answered')`).run(q.requisition_id, quoteId);
      db.prepare(`UPDATE purchase_requisitions SET status = 'ordered' WHERE id = ?`).run(q.requisition_id);
    });
    tx();
    return true;
  }
}
