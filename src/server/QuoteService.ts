import db from "./db.js";
import { v4 as uuidv4 } from "uuid";
import { InventoryService } from "./InventoryService.js";
import { MessageProviderService } from "./MessageProviderService.js";

export type QuoteStatus = 'sent' | 'viewed' | 'accepted' | 'declined' | 'expired';

/**
 * Orçamentos como OBJETO rastreável: enviado / aceito / recusado / expirado.
 *
 * O agente de atendimento gera com `quote_request` (lista de itens). O serviço
 * resolve cada item no catálogo (com checagem de estoque), monta o texto que
 * vai para o WhatsApp E persiste em `quotes` para análise e follow-up.
 */
export class QuoteService {
  static validityHours(orgId: string): number {
    const o = db.prepare(`SELECT COALESCE(quote_validity_hours,72) AS h FROM organization_settings WHERE organization_id = ?`).get(orgId) as any;
    return Math.max(1, parseInt(String(o?.h || 72), 10) || 72);
  }

  /**
   * Gera o orçamento a partir de itens livres da IA. Persiste em `quotes` e
   * devolve o texto humanizado para anexar à resposta.
   * Retorna null se não conseguiu casar nenhum item.
   */
  static buildAndSave(orgId: string, rawItems: any[], opts: { contactId?: string; ticketId?: string; createdBy?: string } = {}): { id: string; text: string; total: number; itemCount: number } | null {
    const reqs = (rawItems || []).map((it: any) => ({
      name: typeof it?.name === 'string' ? it.name.trim() : '',
      qty: Math.max(1, parseInt(String(it?.quantity ?? 1), 10) || 1),
    })).filter(r => r.name);
    if (reqs.length === 0) return null;

    const currency = 'R$';
    const lines: string[] = [];
    const snapshot: any[] = [];
    const notFound: string[] = [];
    let total = 0;

    for (const r of reqs) {
      let product = db.prepare(
        'SELECT * FROM products_services WHERE organization_id = ? AND active = 1 AND lower(name) = lower(?)'
      ).get(orgId, r.name) as any;
      if (!product) {
        product = db.prepare(
          "SELECT * FROM products_services WHERE organization_id = ? AND active = 1 AND lower(name) LIKE lower(?) ORDER BY length(name) ASC LIMIT 1"
        ).get(orgId, `%${r.name}%`) as any;
      }
      if (!product) { notFound.push(r.name); continue; }

      const price = Number(product.price ?? 0);
      let qty = r.qty;
      let note = '';
      if (product.stock_control_enabled) {
        const sellable = InventoryService.sellable(orgId, product.id) ?? 0;
        if (sellable <= 0) { note = ' — *sem estoque*'; qty = 0; }
        else if (qty > sellable) { note = ` — só temos *${sellable}*`; qty = sellable; }
      }
      const sub = price * qty;
      total += sub;
      snapshot.push({ product_id: product.id, name: product.name, qty, unit_price: price, sub_total: sub, note });
      if (qty > 0) {
        lines.push(`• ${qty}x ${product.name} — ${currency} ${price.toFixed(2)} = *${currency} ${sub.toFixed(2)}*${note}`);
      } else {
        lines.push(`• ${product.name}${note}`);
      }
    }

    if (lines.length === 0 && notFound.length > 0) {
      // Nada casou — não vale persistir.
      return { id: '', text: `Não localizei esses itens no catálogo: ${notFound.join(', ')}. Pode me dizer de outro jeito? 🙂`, total: 0, itemCount: 0 };
    }

    const validityH = this.validityHours(orgId);
    const id = uuidv4();
    db.prepare(`
      INSERT INTO quotes (id, organization_id, contact_id, ticket_id, status, total_amount, items_snapshot, valid_until, created_by)
      VALUES (?, ?, ?, ?, 'sent', ?, ?, datetime('now', ?), ?)
    `).run(id, orgId, opts.contactId || null, opts.ticketId || null, total, JSON.stringify(snapshot), `+${validityH} hours`, opts.createdBy || 'ai');

    let out = `🧾 *Sua cotação:*\n${lines.join('\n')}\n\n*Total: ${currency} ${total.toFixed(2)}*`;
    if (notFound.length > 0) out += `\n\n⚠️ Não encontrei: ${notFound.join(', ')}.`;
    out += `\n\nA cotação vale por ${validityH}h. Quer que eu *feche o pedido* com esses itens? 👍`;
    return { id, text: out, total, itemCount: snapshot.length };
  }

  /** Marca como aceito (cliente confirmou — geralmente vira pedido). */
  static markAccepted(orgId: string, quoteId: string): boolean {
    const r = db.prepare(`UPDATE quotes SET status = 'accepted', accepted_at = CURRENT_TIMESTAMP WHERE id = ? AND organization_id = ? AND status IN ('sent','viewed')`).run(quoteId, orgId);
    return r.changes > 0;
  }

  /** Marca como recusado (cliente disse não). */
  static markDeclined(orgId: string, quoteId: string, reason?: string): boolean {
    const r = db.prepare(`UPDATE quotes SET status = 'declined', declined_at = CURRENT_TIMESTAMP, notes = COALESCE(?, notes) WHERE id = ? AND organization_id = ? AND status IN ('sent','viewed')`).run(reason || null, quoteId, orgId);
    return r.changes > 0;
  }

  /** Encontra o orçamento aberto mais recente do contato. */
  static openForContact(orgId: string, contactId: string): any | null {
    return db.prepare(`SELECT * FROM quotes WHERE organization_id = ? AND contact_id = ? AND status IN ('sent','viewed') ORDER BY sent_at DESC LIMIT 1`).get(orgId, contactId) as any || null;
  }

  /** Lista para a tela. */
  static list(orgId: string, opts: { status?: QuoteStatus } = {}): any[] {
    const where = opts.status ? ` AND q.status = ?` : '';
    const params: any[] = [orgId];
    if (opts.status) params.push(opts.status);
    return db.prepare(`
      SELECT q.*, c.name AS contact_name, c.identifier AS contact_identifier
      FROM quotes q LEFT JOIN contacts c ON c.id = q.contact_id
      WHERE q.organization_id = ?${where}
      ORDER BY q.sent_at DESC LIMIT 500
    `).all(...params);
  }

  /**
   * Scheduler: marca como expirado o que passou da validade SEM resposta e
   * dispara follow-up (cutucão gentil) para orçamentos que ficaram parados.
   */
  static async passFollowupAndExpire(io?: any): Promise<void> {
    // 1) EXPIRAR — só os sent/viewed cujo valid_until já passou.
    try {
      const expired = db.prepare(`
        SELECT id, organization_id FROM quotes
        WHERE status IN ('sent','viewed') AND valid_until IS NOT NULL AND valid_until <= datetime('now')
        LIMIT 1000
      `).all() as any[];
      for (const e of expired) {
        db.prepare(`UPDATE quotes SET status = 'expired' WHERE id = ?`).run(e.id);
        if (io) io.to(`org:${e.organization_id}`).emit("quote_expired", { quoteId: e.id });
      }
    } catch (e) { console.error('[Quote] Falha ao expirar', e); }

    // 2) FOLLOW-UP — orçamentos abertos sem resposta há >= followup_hours, com
    // limite de quote_followup_max. Reusa o WhatsApp do contato.
    let orgs: any[] = [];
    try {
      orgs = db.prepare(`
        SELECT organization_id, COALESCE(quote_followup_hours,24) AS h, COALESCE(quote_followup_max,2) AS max
        FROM organization_settings
      `).all() as any[];
    } catch (e) { return; }

    for (const org of orgs) {
      try {
        const orgId = org.organization_id;
        const hours = Math.max(1, parseInt(String(org.h || 24), 10) || 24);
        const max = Math.min(5, Math.max(0, parseInt(String(org.max || 2), 10) || 2));
        if (max <= 0) continue;

        const due = db.prepare(`
          SELECT q.id, q.followup_count, q.last_followup_at, q.sent_at, q.total_amount,
                 c.id AS contact_id, c.name AS contact_name, c.identifier AS contact_number, c.channel_id
          FROM quotes q
          JOIN contacts c ON c.id = q.contact_id
          WHERE q.organization_id = ?
            AND q.status IN ('sent','viewed')
            AND COALESCE(q.followup_count,0) < ?
            AND COALESCE(q.last_followup_at, q.sent_at) <= datetime('now', ?)
          LIMIT 200
        `).all(orgId, max, `-${hours} hours`) as any[];

        const fallbackChannel = db.prepare(`SELECT id FROM channels WHERE organization_id = ? AND status != 'disabled' ORDER BY (provider LIKE 'evolution%') DESC, created_at ASC LIMIT 1`).get(orgId) as any;

        for (const q of due) {
          try {
            const channelId = q.channel_id || fallbackChannel?.id;
            if (!channelId || !q.contact_number) continue;
            const first = (q.contact_name || '').trim().split(/\s+/)[0] || '';
            const msg = q.followup_count === 0
              ? `Oi${first ? `, ${first}` : ''}! Passei pra saber se conseguiu olhar o orçamento que te mandei (total R$ ${Number(q.total_amount || 0).toFixed(2)}). Posso ajudar com alguma dúvida? 😊`
              : `Oi${first ? `, ${first}` : ''}! Última vez que te chamo por aqui sobre o orçamento — caso ainda faça sentido, é só me dizer e eu separo tudo pra você. 🙏`;
            await MessageProviderService.sendMessage(channelId, q.contact_number, msg);
            db.prepare(`UPDATE quotes SET followup_count = COALESCE(followup_count,0) + 1, last_followup_at = CURRENT_TIMESTAMP WHERE id = ?`).run(q.id);
          } catch (e) { console.error('[Quote] Falha no follow-up', q.id, e); }
        }
      } catch (e) { console.error('[Quote] Falha no pass de follow-up da org', org.organization_id, e); }
    }
  }
}
