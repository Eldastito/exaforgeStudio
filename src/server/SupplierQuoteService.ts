import db from "./db.js";
import { v4 as uuidv4 } from "uuid";
import { chat } from "./llm.js";
import { MessageProviderService } from "./MessageProviderService.js";
import { NotificationService } from "./NotificationService.js";
import { SupplyNetworkService } from "./SupplyNetworkService.js";
import { GoogleOAuthService } from "./GoogleOAuthService.js";
import { PurchaseOrderService } from "./PurchaseOrderService.js";

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

    // identifier OU email — um fornecedor só de e-mail (sem WhatsApp) também
    // é elegível (ADR-099: e-mail como canal paralelo).
    const suppliers = db.prepare(`
      SELECT id, name, identifier, email, channel_id, supplier_categories
      FROM contacts
      WHERE organization_id = ? AND COALESCE(is_supplier,0) = 1
        AND (identifier IS NOT NULL OR (email IS NOT NULL AND TRIM(email) != ''))
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

  /** Assunto + corpo do e-mail de cotação (canal paralelo ao WhatsApp, ADR-099). */
  private static buildQuoteEmail(orgName: string, supplierName: string, items: any[]): { subject: string; body: string } {
    const first = (supplierName || "").trim().split(/\s+/)[0] || "";
    const lines = items.map((it, i) => `${i + 1}. ${it.product_name}${it.variant_name ? ` (${it.variant_name})` : ""} — ${it.suggested_qty} un.`).join("\n");
    const subject = `Cotação de compra — ${orgName || "pedido"}`;
    const body = [
      `Olá${first ? `, ${first}` : ""}!`,
      ``,
      `Aqui é da equipe de compras do ${orgName || "nosso estabelecimento"}. Gostaríamos de cotar os itens abaixo — por favor, informe preço por unidade, quantidade disponível e prazo de entrega:`,
      ``,
      lines,
      ``,
      `Pode responder a este e-mail ou pelo WhatsApp. Obrigado!`,
    ].join("\n");
    return { subject, body };
  }

  /**
   * Dispara as cotações para fornecedores elegíveis. Cobre os DOIS canais:
   * (1) fornecedores LOCAIS (contato com is_supplier=1) — envia mensagem no
   *     WhatsApp; a resposta livre é parseada pelo LLM (webhookProcessor).
   * (2) fornecedores DA REDE ZappFlow — cria a cotação na própria base com
   *     network_org_id; o fornecedor responde direto na UI "Pedidos da Rede".
   */
  static async sendQuotes(orgId: string, reqId: string, io?: any): Promise<{ sent: number; network: number; emailed: number; failed: number }> {
    const items = db.prepare(`
      SELECT ri.product_service_id, ri.variant_id, ri.suggested_qty,
             p.name AS product_name, pv.name AS variant_name, p.category AS category
      FROM purchase_requisition_items ri
      JOIN products_services p ON p.id = ri.product_service_id
      LEFT JOIN product_variants pv ON pv.id = ri.variant_id
      WHERE ri.requisition_id = ?
    `).all(reqId) as any[];
    if (items.length === 0) return { sent: 0, network: 0, emailed: 0, failed: 0 };

    const suppliers = this.eligibleSuppliers(orgId, reqId);
    const o = db.prepare("SELECT business_name FROM organization_settings WHERE organization_id = ?").get(orgId) as any;
    const fallbackChannel = db.prepare(`SELECT id FROM channels WHERE organization_id = ? AND status != 'disabled' ORDER BY (provider LIKE 'evolution%') DESC, created_at ASC LIMIT 1`).get(orgId) as any;

    // E-mail é canal paralelo: só disponível se a org conectou o Google.
    // Checa uma vez (evita bater no OAuth por fornecedor).
    const emailAvailable = (() => { try { return !!GoogleOAuthService.status(orgId)?.connected; } catch { return false; } })();

    let sent = 0;
    let emailed = 0;
    let failed = 0;
    for (const s of suppliers) {
      try {
        const channelId = s.channel_id || fallbackChannel?.id;
        const canWhats = !!(channelId && s.identifier);
        const supplierEmail = String(s.email || "").trim();
        const canEmail = emailAvailable && !!supplierEmail;
        // Sem nenhum canal alcançável → não cria cotação órfã.
        if (!canWhats && !canEmail) continue;

        const quoteId = uuidv4();
        db.prepare(`INSERT INTO purchase_quotes (id, organization_id, requisition_id, supplier_contact_id, status) VALUES (?, ?, ?, ?, 'sent')`)
          .run(quoteId, orgId, reqId, s.id);

        // (a) WhatsApp — canal primário.
        if (canWhats) {
          const message = this.buildQuoteMessage(o?.business_name || "", s.name, items);
          await MessageProviderService.sendMessage(channelId, s.identifier, message);
        }
        // (b) E-mail — canal paralelo, degrada em silêncio se falhar.
        if (canEmail) {
          const { subject, body } = this.buildQuoteEmail(o?.business_name || "", s.name, items);
          try {
            const r = await GoogleOAuthService.gmailSend(orgId, supplierEmail, subject, body);
            if (r && !("error" in r)) emailed++;
            else console.warn("[Supply] E-mail de cotação não enviado para", s.name, (r as any)?.error);
          } catch (e) { console.warn("[Supply] Falha ao enviar e-mail de cotação para", s.name, e); }
        }

        sent++;
        if (io) io.to(`org:${orgId}`).emit("supplier_quote_sent", { quoteId, supplierId: s.id });
      } catch (e) { failed++; console.error("[Supply] Falha ao enviar cotação para", s.name, e); }
    }

    // (2) FORNECEDORES DA REDE: cria a cotação na própria base. A org fornecedora
    // verá em "Pedidos da Rede" e preenche preço/disponibilidade direto na UI.
    let network = 0;
    try {
      const cats = Array.from(new Set(items.map(i => String(i.category || "").toLowerCase().trim()).filter(Boolean)));
      const networkSuppliers = SupplyNetworkService.listSuppliers(orgId, { categories: cats });
      for (const ns of networkSuppliers) {
        try {
          const quoteId = uuidv4();
          db.prepare(`INSERT INTO purchase_quotes (id, organization_id, requisition_id, supplier_contact_id, network_org_id, status) VALUES (?, ?, ?, NULL, ?, 'sent')`)
            .run(quoteId, orgId, reqId, ns.orgId);
          // Pré-cria os itens vazios (preço null) para o fornecedor preencher.
          const ins = db.prepare(`INSERT INTO purchase_quote_items (id, quote_id, organization_id, product_service_id, product_name, unit_price, available_qty, line_total) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL)`);
          for (const it of items) {
            const display = it.variant_name ? `${it.product_name} (${it.variant_name})` : it.product_name;
            ins.run(uuidv4(), quoteId, orgId, it.product_service_id, display);
          }
          network++;
          if (io) {
            io.to(`org:${orgId}`).emit("supplier_quote_sent", { quoteId, networkOrgId: ns.orgId });
            io.to(`org:${ns.orgId}`).emit("network_quote_received", { quoteId, fromOrgId: orgId });
          }
        } catch (e) { failed++; console.error("[Supply] Falha ao criar cotação de rede para", ns.name, e); }
      }
    } catch (e) { console.error("[Supply] Falha ao listar fornecedores da rede", e); }

    return { sent, network, emailed, failed };
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
    // Une cotações de contatos locais E de orgs da rede ZappFlow. supplier_name vem
    // do contato (local) OU do business_name da org fornecedora (rede).
    const quotes = db.prepare(`
      SELECT q.*,
             COALESCE(c.name, s.business_name, 'Fornecedor da rede') AS supplier_name,
             CASE WHEN q.network_org_id IS NOT NULL THEN 1 ELSE 0 END AS from_network
      FROM purchase_quotes q
      LEFT JOIN contacts c ON c.id = q.supplier_contact_id
      LEFT JOIN organization_settings s ON s.organization_id = q.network_org_id
      WHERE q.organization_id = ? AND q.requisition_id = ?
      ORDER BY q.total_amount ASC NULLS LAST, q.sent_at ASC
    `).all(orgId, reqId) as any[];
    for (const q of quotes) {
      q.items = db.prepare(`SELECT * FROM purchase_quote_items WHERE quote_id = ?`).all(q.id);
    }
    return quotes;
  }

  /**
   * Inbox de cotações recebidas pela org como FORNECEDORA da rede.
   * Não revela o nome do comprador completo nem a requisição.
   */
  static incomingForNetwork(orgId: string): any[] {
    const quotes = db.prepare(`
      SELECT q.id, q.status, q.requisition_id, q.organization_id AS buyer_org_id, q.sent_at,
             q.delivery_days, q.total_amount, q.notes, q.answered_at,
             COALESCE(s.business_name, 'Comprador') AS buyer_name,
             s.address_city AS buyer_city
      FROM purchase_quotes q
      LEFT JOIN organization_settings s ON s.organization_id = q.organization_id
      WHERE q.network_org_id = ?
      ORDER BY q.sent_at DESC
    `).all(orgId) as any[];
    for (const q of quotes) {
      q.items = db.prepare(`SELECT * FROM purchase_quote_items WHERE quote_id = ?`).all(q.id);
    }
    return quotes;
  }

  /**
   * Fornecedor da rede preenche/atualiza sua cotação (preço por item +
   * disponibilidade + prazo + observação) e marca como 'answered'.
   *
   * Só permite atualizar quando network_org_id == orgId chamadora.
   */
  static submitNetworkAnswer(networkOrgId: string, quoteId: string, payload: {
    deliveryDays?: number | null; notes?: string | null;
    items: { id: string; unitPrice?: number | null; availableQty?: number | null }[];
  }): boolean {
    const q = db.prepare(`SELECT * FROM purchase_quotes WHERE id = ? AND network_org_id = ?`).get(quoteId, networkOrgId) as any;
    if (!q) return false;
    const tx = db.transaction(() => {
      let total = 0;
      const upd = db.prepare(`UPDATE purchase_quote_items SET unit_price = ?, available_qty = ?, line_total = ? WHERE id = ? AND quote_id = ?`);
      const itemsCur = db.prepare(`SELECT id, product_service_id FROM purchase_quote_items WHERE quote_id = ?`).all(q.id) as any[];
      const ridItems = db.prepare(`SELECT product_service_id, suggested_qty FROM purchase_requisition_items WHERE requisition_id = ?`).all(q.requisition_id) as any[];
      const wantedByPid = new Map(ridItems.map(r => [String(r.product_service_id), r.suggested_qty as number]));
      const itemPidById = new Map(itemsCur.map(i => [String(i.id), String(i.product_service_id)]));
      for (const it of payload.items || []) {
        const pid = itemPidById.get(String(it.id));
        if (!pid) continue;
        const unit = it.unitPrice != null && !isNaN(Number(it.unitPrice)) ? Math.max(0, Number(it.unitPrice)) : null;
        const avail = it.availableQty != null && !isNaN(Number(it.availableQty)) ? Math.max(0, parseInt(String(it.availableQty), 10) || 0) : null;
        const wanted = Number(wantedByPid.get(pid) || 0);
        const qty = avail != null ? Math.min(wanted, avail) : wanted;
        const line = unit != null ? Math.round(unit * qty * 100) / 100 : null;
        upd.run(unit, avail, line, it.id, q.id);
        if (line != null) total += line;
      }
      db.prepare(`UPDATE purchase_quotes SET status = 'answered', delivery_days = ?, total_amount = ?, notes = COALESCE(?, notes), answered_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .run(payload.deliveryDays ?? null, Math.round(total * 100) / 100, payload.notes ?? null, q.id);
    });
    tx();
    // Avisa o comprador em tempo real.
    try { (global as any).io?.to(`org:${q.organization_id}`).emit("supplier_quote_answered", { quoteId, requisitionId: q.requisition_id }); } catch (e) { /* noop */ }
    return true;
  }

  /**
   * Confirma o vencedor (marca esta como aceita, as demais como rejeitadas) e
   * gera a ORDEM DE COMPRA imutável (snapshot dos itens). Idempotente: aceitar a
   * mesma cotação de novo não cria uma segunda ordem (PRD §16). Devolve o id da
   * ordem para a UI.
   */
  static accept(orgId: string, quoteId: string): { ok: boolean; orderId: string | null } {
    const q = db.prepare(`SELECT * FROM purchase_quotes WHERE id = ? AND organization_id = ?`).get(quoteId, orgId) as any;
    if (!q) return { ok: false, orderId: null };
    const tx = db.transaction(() => {
      db.prepare(`UPDATE purchase_quotes SET status = 'accepted', accepted_at = CURRENT_TIMESTAMP WHERE id = ?`).run(quoteId);
      db.prepare(`UPDATE purchase_quotes SET status = 'rejected' WHERE requisition_id = ? AND id != ? AND status IN ('sent','answered')`).run(q.requisition_id, quoteId);
      db.prepare(`UPDATE purchase_requisitions SET status = 'ordered' WHERE id = ?`).run(q.requisition_id);
    });
    tx();
    // Fora da transação de status: cria (ou reusa) a ordem imutável.
    const po = PurchaseOrderService.createFromQuote(orgId, quoteId);
    return { ok: true, orderId: po.id };
  }
}
