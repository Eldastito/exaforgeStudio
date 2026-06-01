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
      this.recomputeScore(contactId);
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
      this.recomputeScore(contactId);
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

  /**
   * Lead Scoring (0-100): pontuação preditiva da chance de conversão, combinando
   * sinais comportamentais. Transparente e determinística (sem ML), pensada para
   * priorizar atendimento e disparar/segmentar cadências e campanhas.
   *
   * Pesos:
   *  - Recência de contato (engajamento atual): até 25
   *  - É comprador + frequência: até 35
   *  - Valor investido (LTV): até 15
   *  - Recência da compra: até 15
   *  - Intenção pelo estágio do ticket aberto (proposta/pagamento): até 20
   */
  static recomputeScore(contactId: string): number {
    try {
      const c = db.prepare(`
        SELECT organization_id, last_contact_at, last_purchase_at, purchase_count, total_spent
        FROM contacts WHERE id = ?
      `).get(contactId) as any;
      if (!c) return 0;

      const days = (d: string | null) => d ? (Date.now() - new Date(d).getTime()) / 86400000 : Infinity;
      const sinceContact = days(c.last_contact_at);
      const sincePurchase = days(c.last_purchase_at);
      const purchases = c.purchase_count || 0;
      const spent = c.total_spent || 0;

      let score = 0;

      // Engajamento (recência de contato).
      if (sinceContact <= 1) score += 25;
      else if (sinceContact <= 3) score += 18;
      else if (sinceContact <= 7) score += 10;
      else if (sinceContact <= 30) score += 4;

      // É comprador + frequência.
      if (purchases > 0) score += 15;
      score += Math.min(purchases * 5, 20);

      // Valor investido (LTV em faixas).
      if (spent >= 1000) score += 15;
      else if (spent >= 300) score += 10;
      else if (spent > 0) score += 5;

      // Recência da última compra.
      if (sincePurchase <= 30) score += 15;
      else if (sincePurchase <= 90) score += 8;

      // Intenção de compra pelo estágio do ticket aberto mais recente.
      const ticket = db.prepare(`
        SELECT stage FROM tickets WHERE contact_id = ? AND status = 'open' ORDER BY created_at DESC LIMIT 1
      `).get(contactId) as any;
      const stage = ticket?.stage || '';
      if (stage === 'aguardando_pagamento' || stage === 'proposta') score += 20;
      else if (stage === 'qualificado' || stage === 'agendado') score += 12;

      score = Math.max(0, Math.min(100, Math.round(score)));
      db.prepare(`UPDATE contacts SET lead_score = ?, lead_score_updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(score, contactId);
      return score;
    } catch (e) { return 0; }
  }

  /** Faixa textual a partir do score numérico. */
  static scoreBand(score: number): 'alto' | 'medio' | 'baixo' {
    if (score >= 70) return 'alto';
    if (score >= 40) return 'medio';
    return 'baixo';
  }

  /** Resumo de CRM de um contato (para a IA e a UI). */
  static getProfile(orgId: string, contactId: string): any {
    return db.prepare(`
      SELECT id, name, identifier, lead_temperature, lead_score, purchase_count, total_spent, avg_ticket,
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
    parts.push(`lead score: ${p.lead_score || 0}/100 (${this.scoreBand(p.lead_score || 0)})`);
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
