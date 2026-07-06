import db from "./db.js";
import { v4 as uuidv4 } from "uuid";

/**
 * LGPD — retenção de dados e direitos do titular.
 *
 * - Retenção (opt-in): expurga o CONTEÚDO de mensagens antigas de tickets já
 *   encerrados, mantendo os agregados (pedidos, métricas) para fins contábeis.
 * - Exportação: devolve todos os dados pessoais de um contato (portabilidade).
 * - Esquecimento: anonimiza o contato (remove PII) e apaga o conteúdo das
 *   mensagens, preservando os registros financeiros sem dado pessoal.
 */
export class LgpdService {
  /** Pass de retenção do Scheduler. Apaga conteúdo de mensagens de tickets
   *  FECHADOS mais antigas que retention_days, nas orgs com a retenção ligada. */
  static retentionPass(): { orgs: number; messages: number } {
    let orgs: any[] = [];
    try {
      orgs = db.prepare(`
        SELECT organization_id, COALESCE(retention_days,365) AS days
        FROM organization_settings WHERE COALESCE(retention_enabled,0) = 1
      `).all() as any[];
    } catch (e) { return { orgs: 0, messages: 0 }; }

    let totalMsgs = 0;
    for (const org of orgs) {
      try {
        const days = Math.max(30, parseInt(String(org.days || 365), 10) || 365);
        // Conteúdo das mensagens de tickets já encerrados, além da janela.
        const r = db.prepare(`
          UPDATE messages SET content = '[removido por política de retenção]', media_url = NULL
          WHERE organization_id = ?
            AND content != '[removido por política de retenção]'
            AND ticket_id IN (
              SELECT id FROM tickets WHERE organization_id = ? AND status = 'closed'
                AND COALESCE(closed_at, updated_at, created_at) <= datetime('now', ?)
            )
        `).run(org.organization_id, org.organization_id, `-${days} days`);
        totalMsgs += r.changes || 0;
      } catch (e) { console.error('[LGPD] Falha na retenção da org', org.organization_id, e); }
    }
    if (totalMsgs) console.log(`[LGPD] Retenção: ${totalMsgs} mensagem(ns) expurgada(s).`);
    return { orgs: orgs.length, messages: totalMsgs };
  }

  /** Exporta (portabilidade) todos os dados pessoais de um contato. */
  static exportContact(orgId: string, contactId: string): any {
    const contact = db.prepare(`SELECT * FROM contacts WHERE id = ? AND organization_id = ?`).get(contactId, orgId) as any;
    if (!contact) return null;
    const tickets = db.prepare(`SELECT id, status, stage, created_at, closed_at FROM tickets WHERE contact_id = ? AND organization_id = ?`).all(contactId, orgId);
    const messages = db.prepare(`SELECT ticket_id, sender_type, content, created_at FROM messages WHERE organization_id = ? AND ticket_id IN (SELECT id FROM tickets WHERE contact_id = ?) ORDER BY created_at ASC`).all(orgId, contactId);
    const orders = db.prepare(`SELECT id, status, total_amount, created_at FROM orders WHERE organization_id = ? AND contact_id = ?`).all(orgId, contactId);
    const reservations = (() => { try { return db.prepare(`SELECT id, start_at, end_at, status, total_amount FROM reservations WHERE organization_id = ? AND contact_id = ?`).all(orgId, contactId); } catch { return []; } })();
    const appointments = (() => { try { return db.prepare(`SELECT id, title, scheduled_start, status FROM appointments WHERE organization_id = ? AND contact_id = ?`).all(orgId, contactId); } catch { return []; } })();
    return {
      exportedAt: new Date().toISOString(),
      contact: {
        id: contact.id, name: contact.name, identifier: contact.identifier,
        email: contact.email, created_at: contact.created_at,
        tags: contact.tags, marketing_opt_out: !!contact.marketing_opt_out,
        anonymized_at: contact.anonymized_at,
      },
      tickets, messages, orders, reservations, appointments,
    };
  }

  /**
   * Direito ao esquecimento: anonimiza o contato (remove PII) e apaga o conteúdo
   * das mensagens. Mantém pedidos/valores (sem PII) para histórico financeiro.
   */
  static forgetContact(orgId: string, contactId: string): boolean {
    const contact = db.prepare(`SELECT id FROM contacts WHERE id = ? AND organization_id = ?`).get(contactId, orgId) as any;
    if (!contact) return false;
    const tx = db.transaction(() => {
      // Identifier precisa ser único por (org, canal); usa um marcador estável.
      const redactedId = `anon_${contactId.slice(0, 8)}`;
      db.prepare(`UPDATE contacts SET name = 'Contato removido', identifier = ?, email = NULL, profile_pic_url = NULL, marketing_opt_out = 1, memory_facts = NULL, memory_summary = NULL, memory_updated_at = NULL, anonymized_at = CURRENT_TIMESTAMP WHERE id = ? AND organization_id = ?`)
        .run(redactedId, contactId, orgId);
      db.prepare(`UPDATE messages SET content = '[removido a pedido do titular]', media_url = NULL WHERE organization_id = ? AND ticket_id IN (SELECT id FROM tickets WHERE contact_id = ?)`)
        .run(orgId, contactId);
    });
    tx();
    return true;
  }

  // ---- Granular consent tracking ----

  static grantConsent(orgId: string, contactId: string, consentType: string, opts: { legalBasis?: string; policyVersion?: string; channel?: string; actorId?: string } = {}): string {
    const id = uuidv4();
    const tx = db.transaction(() => {
      db.prepare(`UPDATE contact_consents SET granted = 0, revoked_at = CURRENT_TIMESTAMP WHERE organization_id = ? AND contact_id = ? AND consent_type = ? AND granted = 1`)
        .run(orgId, contactId, consentType);
      db.prepare(`INSERT INTO contact_consents (id, organization_id, contact_id, consent_type, legal_basis, policy_version, granted, granted_at, channel, actor_id) VALUES (?, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP, ?, ?)`)
        .run(id, orgId, contactId, consentType, opts.legalBasis || null, opts.policyVersion || '1.0', opts.channel || null, opts.actorId || null);
    });
    tx();
    return id;
  }

  static revokeConsent(orgId: string, contactId: string, consentType: string, actorId?: string): boolean {
    const r = db.prepare(`UPDATE contact_consents SET granted = 0, revoked_at = CURRENT_TIMESTAMP WHERE organization_id = ? AND contact_id = ? AND consent_type = ? AND granted = 1`)
      .run(orgId, contactId, consentType);
    return (r.changes || 0) > 0;
  }

  static getConsentsForContact(orgId: string, contactId: string): any[] {
    try {
      return db.prepare(`SELECT * FROM contact_consents WHERE organization_id = ? AND contact_id = ? ORDER BY created_at DESC`).all(orgId, contactId) as any[];
    } catch { return []; }
  }

  static hasConsent(orgId: string, contactId: string, consentType: string): boolean {
    const r = db.prepare(`SELECT 1 FROM contact_consents WHERE organization_id = ? AND contact_id = ? AND consent_type = ? AND granted = 1 LIMIT 1`).get(orgId, contactId, consentType) as any;
    return !!r;
  }

  static getConsentConfig(orgId: string): { categories: string[]; bannerText: string; policyVersion: string } {
    const o = db.prepare(`SELECT consent_categories, consent_banner_text, consent_policy_version FROM organization_settings WHERE organization_id = ?`).get(orgId) as any || {};
    return {
      categories: o.consent_categories ? JSON.parse(o.consent_categories) : ['marketing', 'dados_pessoais', 'perfilamento', 'comunicacoes'],
      bannerText: o.consent_banner_text || '',
      policyVersion: o.consent_policy_version || '1.0',
    };
  }

  static updateConsentConfig(orgId: string, config: { categories?: string[]; bannerText?: string; policyVersion?: string }): void {
    if (config.categories !== undefined)
      db.prepare(`UPDATE organization_settings SET consent_categories = ? WHERE organization_id = ?`).run(JSON.stringify(config.categories), orgId);
    if (config.bannerText !== undefined)
      db.prepare(`UPDATE organization_settings SET consent_banner_text = ? WHERE organization_id = ?`).run(config.bannerText, orgId);
    if (config.policyVersion !== undefined)
      db.prepare(`UPDATE organization_settings SET consent_policy_version = ? WHERE organization_id = ?`).run(config.policyVersion, orgId);
  }

  static getConsentSummary(orgId: string): { type: string; granted: number; revoked: number }[] {
    try {
      return db.prepare(`
        SELECT consent_type AS type,
          SUM(CASE WHEN granted = 1 THEN 1 ELSE 0 END) AS granted,
          SUM(CASE WHEN granted = 0 THEN 1 ELSE 0 END) AS revoked
        FROM contact_consents WHERE organization_id = ?
        GROUP BY consent_type ORDER BY consent_type
      `).all(orgId) as any[];
    } catch { return []; }
  }
}
