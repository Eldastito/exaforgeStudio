import db from "./db.js";
import { StorefrontAttributionService } from "./StorefrontAttributionService.js";

/**
 * ContactOriginService — ADR-207 F2: a ORIGEM do contato no CRM.
 *
 * O CRM passa a guardar de onde o contato VEIO (first touch), sem apagar isso quando ele depois conversa
 * por outro canal ou compra em outro lugar. São quatro coisas diferentes, que não se misturam:
 *   - ORIGEM (first touch): onde o contato apareceu pela primeira vez — gravada UMA vez, imutável;
 *   - CANAL ATUAL: o canal do cadastro dele hoje (derivado de `contacts.channel_id`);
 *   - CONVERSÃO: onde a compra aconteceu (derivado do pedido: loja ZapFlow / atendimento / equipe);
 *   - TOQUES: as atribuições de campanha de cada pedido (F1) — o histórico, não a origem.
 *
 * REGRAS (testadas):
 *  - Imutável: `UPDATE … WHERE first_touch_channel IS NULL`. WhatsApp depois do Instagram NÃO troca a origem.
 *  - Aditivo e best-effort: falhar aqui nunca derruba o recebimento da mensagem.
 *  - Sem inventar: contato antigo sem registro mostra a origem INFERIDA do canal da 1ª conversa, rotulada
 *    `inferred_channel` (nunca como se fosse registrada); sem canal conhecido → `unknown`. Nada é gravado na inferência.
 *  - Sem unificar pessoas por palpite: o mesmo humano em dois canais continua sendo dois contatos (identity stitching
 *    especulativo fica de fora — PRD §76).
 *  - Dinheiro (receita por origem) só com `includeMoney` (rota: dono/administrador, §73). Isolamento por org.
 */

export type OriginBasis = "recorded" | "inferred_channel" | "unknown";
export interface Origin { channel: string | null; campaign: string | null; content: string | null; ref: string | null; at: string | null; basis: OriginBasis }

const PAID_STATUSES = ["pago", "em_preparo", "entregue", "concluido"];

export class ContactOriginService {
  /** Provider do canal → canal de negócio (o que o dono entende). */
  static normalizeChannel(provider: string | null | undefined): string | null {
    const p = String(provider || "").toLowerCase();
    if (!p) return null;
    if (p.includes("whatsapp") || p.includes("evolution")) return "whatsapp";
    if (p.includes("instagram")) return "instagram";
    if (p.includes("facebook") || p.includes("messenger")) return "facebook";
    if (p.includes("telegram")) return "telegram";
    if (p.includes("email") || p.includes("mail")) return "email";
    return "other";
  }

  /** Grava a origem UMA vez. Já registrada → não mexe. Contato de outra empresa → não grava. Best-effort. */
  static recordFirstTouch(orgId: string, contactId: string, input: { channel?: string | null; campaign?: string | null; content?: string | null; ref?: string | null }): { set: boolean } {
    try {
      const a = StorefrontAttributionService.sanitize({ source: input?.channel, campaign: input?.campaign, content: input?.content, ref: input?.ref });
      if (!a?.source) return { set: false };      // sem canal não há origem (campanha sozinha não basta)
      const r = db.prepare(
        `UPDATE contacts SET first_touch_channel = ?, first_touch_campaign = ?, first_touch_content = ?, first_touch_ref = ?, first_touch_at = CURRENT_TIMESTAMP
          WHERE id = ? AND organization_id = ? AND first_touch_channel IS NULL`
      ).run(a.source, a.campaign, a.content, a.ref, contactId, orgId);
      return { set: r.changes > 0 };
    } catch { return { set: false }; }
  }

  /** Chamado quando o contato é CRIADO por mensagem recebida: a origem é o canal por onde ele chegou. */
  static recordFromNewContact(orgId: string, contactId: string, provider: string | null | undefined): { set: boolean } {
    const channel = this.normalizeChannel(provider);
    return channel ? this.recordFirstTouch(orgId, contactId, { channel }) : { set: false };
  }

  /** Origem efetiva de uma linha de contato: a registrada, senão a inferida do canal (rotulada), senão desconhecida. */
  static effective(row: { first_touch_channel?: string | null; first_touch_campaign?: string | null; first_touch_content?: string | null; first_touch_ref?: string | null; first_touch_at?: string | null; channel_provider?: string | null; created_at?: string | null }): Origin {
    if (row.first_touch_channel) {
      return { channel: row.first_touch_channel, campaign: row.first_touch_campaign ?? null, content: row.first_touch_content ?? null, ref: row.first_touch_ref ?? null, at: row.first_touch_at ?? null, basis: "recorded" };
    }
    const inferred = this.normalizeChannel(row.channel_provider);
    if (inferred) return { channel: inferred, campaign: null, content: null, ref: null, at: row.created_at ?? null, basis: "inferred_channel" };
    return { channel: null, campaign: null, content: null, ref: null, at: null, basis: "unknown" };
  }

  /** A história de UM contato: origem, canal atual, onde converteu e os toques de campanha dos pedidos. null se não é da empresa. */
  static originOf(orgId: string, contactId: string) {
    const c = db.prepare(
      `SELECT c.id, c.created_at, c.first_touch_channel, c.first_touch_campaign, c.first_touch_content, c.first_touch_ref, c.first_touch_at, ch.provider AS channel_provider
         FROM contacts c LEFT JOIN channels ch ON ch.id = c.channel_id AND ch.organization_id = c.organization_id
        WHERE c.id = ? AND c.organization_id = ?`
    ).get(contactId, orgId) as any;
    if (!c) return null;
    const orders = db.prepare(
      `SELECT id, status, payment_status, created_by, created_at, attr_source, attr_campaign, attr_content, attr_ref FROM orders
        WHERE organization_id = ? AND contact_id = ? AND status NOT IN ('cancelado','reembolso','devolucao') ORDER BY created_at ASC`
    ).all(orgId, contactId) as any[];
    const isPaid = (o: any) => o.payment_status === "paid" || PAID_STATUSES.includes(o.status);
    const firstPaid = orders.find(isPaid) || null;
    const conversion = (o: any) => (o.created_by === "storefront" ? "zapflow_store" : o.created_by === "ai" ? "ai_chat" : "staff");
    return {
      contactId,
      origin: this.effective(c),
      currentChannel: this.normalizeChannel(c.channel_provider),
      conversionChannel: firstPaid ? conversion(firstPaid) : null,
      touches: orders.filter((o) => o.attr_source || o.attr_campaign || o.attr_content || o.attr_ref)
        .map((o) => ({ orderId: o.id, at: o.created_at, source: o.attr_source, campaign: o.attr_campaign, content: o.attr_content, paid: isPaid(o) })),
    };
  }

  /**
   * De onde vêm os contatos: por origem, quantos contatos e quantos já compraram. Receita (total gasto) só com includeMoney.
   * `scope` é o recorte de loja do CRM (ADR-173), aplicado igual ao da lista de contatos.
   */
  static summary(orgId: string, opts: { includeMoney?: boolean; scope?: { clause: string; args: any[] } } = {}) {
    const scope = opts.scope || { clause: "", args: [] };
    const rows = db.prepare(
      `SELECT contacts.first_touch_channel AS ftc, (SELECT provider FROM channels WHERE id = contacts.channel_id AND organization_id = contacts.organization_id) AS prov,
              COUNT(*) AS n, SUM(CASE WHEN COALESCE(contacts.purchase_count,0) > 0 THEN 1 ELSE 0 END) AS buyers, COALESCE(SUM(contacts.total_spent),0) AS spent
         FROM contacts WHERE contacts.organization_id = ?${scope.clause} GROUP BY ftc, prov`
    ).all(orgId, ...scope.args) as any[];
    const by = new Map<string, { channel: string | null; contacts: number; buyers: number; revenue: number; recorded: number; inferred: number }>();
    for (const r of rows) {
      const o = this.effective({ first_touch_channel: r.ftc, channel_provider: r.prov });
      const k = o.channel ?? "unknown";
      const e = by.get(k) || { channel: o.channel, contacts: 0, buyers: 0, revenue: 0, recorded: 0, inferred: 0 };
      e.contacts += r.n; e.buyers += r.buyers; e.revenue += Number(r.spent || 0);
      if (o.basis === "recorded") e.recorded += r.n; else if (o.basis === "inferred_channel") e.inferred += r.n;
      by.set(k, e);
    }
    const list = [...by.values()].sort((a, b) => b.contacts - a.contacts).map((e) => ({
      channel: e.channel, contacts: e.contacts, buyers: e.buyers,
      buyerRatePct: e.contacts > 0 ? Math.round((e.buyers / e.contacts) * 1000) / 10 : null,
      recorded: e.recorded, inferred: e.inferred,
      ...(opts.includeMoney ? { revenue: Math.round(e.revenue * 100) / 100 } : {}),
    }));
    return { basis: "first_touch" as const, note: "Origem registrada quando o contato chegou; contatos antigos mostram o canal da 1ª conversa (inferido).", byChannel: list, total: list.reduce((s, e) => s + e.contacts, 0) };
  }
}

export default ContactOriginService;
