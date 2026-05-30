import db from "./db.js";

/**
 * Mantém o perfil de relacionamento/compra de cada contato (CRM).
 * É a base para segmentação, reativação e campanhas.
 *
 * Temperatura do lead (heurística):
 *  - quente: comprou nos últimos 30 dias OU interagiu hoje/ontem com compra no histórico.
 *  - morno:  interagiu nos últimos 7 dias, ou já comprou alguma vez.
 *  - frio:   sem interação recente e sem compra (ou inativo há muito tempo).
 */
export class CustomerProfileService {
  /** Marca o último contato (chamado quando o cliente manda mensagem). */
  static touchContact(contactId: string) {
    try {
      db.prepare(`UPDATE contacts SET last_contact_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(contactId);
      this.recomputeTemperature(contactId);
    } catch (e) { /* noop */ }
  }

  /**
   * Recalcula os agregados de compra de um contato a partir dos pedidos
   * efetivamente faturados (pago/em_preparo/entregue/concluido).
   */
  static recomputePurchaseStats(orgId: string, contactId: string) {
    try {
      const row = db.prepare(`
        SELECT COUNT(*) as cnt, COALESCE(SUM(total_amount),0) as total, MAX(created_at) as last
        FROM orders
        WHERE organization_id = ? AND contact_id = ?
          AND status IN ('pago','em_preparo','entregue','concluido')
      `).get(orgId, contactId) as any;
      const cnt = row?.cnt || 0;
      const total = row?.total || 0;
      const avg = cnt > 0 ? total / cnt : 0;
      db.prepare(`
        UPDATE contacts SET purchase_count = ?, total_spent = ?, avg_ticket = ?, last_purchase_at = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(cnt, total, avg, row?.last || null, contactId);
      this.recomputeTemperature(contactId);
    } catch (e) { /* noop */ }
  }

  /** Recalcula a temperatura do lead com base em recência de contato/compra. */
  static recomputeTemperature(contactId: string) {
    try {
      const c = db.prepare(`SELECT last_contact_at, last_purchase_at, purchase_count FROM contacts WHERE id = ?`).get(contactId) as any;
      if (!c) return;
      const days = (d: string | null) => d ? (Date.now() - new Date(d).getTime()) / 86400000 : Infinity;
      const sinceContact = days(c.last_contact_at);
      const sincePurchase = days(c.last_purchase_at);

      let temp = 'frio';
      if (sincePurchase <= 30 || sinceContact <= 1) temp = 'quente';
      else if (sinceContact <= 7 || (c.purchase_count || 0) > 0) temp = 'morno';

      db.prepare(`UPDATE contacts SET lead_temperature = ? WHERE id = ?`).run(temp, contactId);
    } catch (e) { /* noop */ }
  }

  /** Resumo de CRM de um contato (para a IA e a UI). */
  static getProfile(orgId: string, contactId: string): any {
    return db.prepare(`
      SELECT id, name, identifier, lead_temperature, purchase_count, total_spent, avg_ticket,
             last_purchase_at, last_contact_at, tags, notes
      FROM contacts WHERE id = ? AND organization_id = ?
    `).get(contactId, orgId);
  }

  /** Gera uma linha curta de contexto de CRM para injetar no prompt da IA. */
  static profileLine(orgId: string, contactId: string): string {
    const p = this.getProfile(orgId, contactId) as any;
    if (!p) return "";
    const parts: string[] = [];
    parts.push(`temperatura: ${p.lead_temperature || 'frio'}`);
    if (p.purchase_count > 0) {
      parts.push(`${p.purchase_count} compra(s)`);
      parts.push(`ticket médio R$ ${Number(p.avg_ticket || 0).toFixed(2)}`);
      if (p.last_purchase_at) {
        const d = Math.floor((Date.now() - new Date(p.last_purchase_at).getTime()) / 86400000);
        parts.push(`última compra há ${d} dia(s)`);
      }
    } else {
      parts.push("ainda sem compras");
    }
    if (p.tags) parts.push(`tags: ${p.tags}`);
    return `PERFIL DO CLIENTE (${p.name || 'sem nome'}): ${parts.join(' · ')}.`;
  }
}
