import db from "./db.js";
import { v4 as uuidv4 } from "uuid";
import { CONSENT_BY_VERTICAL } from "./verticals.js";
import { logAuthEvent } from "./auditLog.js";

// Fase 18: consentimentos cujo revoke dispara cascade em tokens do Portal do
// Paciente (LGPD Art.8 §5 — revogação facilitada). Se o titular tira o
// consentimento sensível OU o de comunicações, todo link ativo do portal
// dele vira inerte imediatamente, sem depender do TTL.
const PORTAL_CASCADE_CONSENTS = new Set(["dados_sensiveis", "comunicacoes"]);

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

  /**
   * Exporta (portabilidade LGPD Art.18) todos os dados pessoais de um
   * contato. Fase 28: além do básico (tickets/messages/orders/reservations/
   * appointments), inclui os dados clínicos do módulo Clínica quando
   * existirem — direito de portabilidade cobre TODOS os dados pessoais que
   * o controlador tem sobre o titular, incluindo saúde (Art.11).
   *
   * Cada bloco clínico é `try`-guardado: em orgs sem módulo clínica ou em
   * banco sem as migrations aplicadas, a chave simplesmente vem `[]`. Nada
   * de binário — anexos vêm com metadata (label/kind/mime/uploaded_at) +
   * URL de download já autenticada; o titular baixa via portal se quiser.
   */
  static exportContact(orgId: string, contactId: string): any {
    const contact = db.prepare(`SELECT * FROM contacts WHERE id = ? AND organization_id = ?`).get(contactId, orgId) as any;
    if (!contact) return null;
    const safe = <T>(fn: () => T, fallback: T): T => { try { return fn(); } catch { return fallback; } };

    const tickets = db.prepare(`SELECT id, status, stage, created_at, closed_at FROM tickets WHERE contact_id = ? AND organization_id = ?`).all(contactId, orgId);
    const messages = db.prepare(`SELECT ticket_id, sender_type, content, created_at FROM messages WHERE organization_id = ? AND ticket_id IN (SELECT id FROM tickets WHERE contact_id = ?) ORDER BY created_at ASC`).all(orgId, contactId);
    const orders = db.prepare(`SELECT id, status, total_amount, created_at FROM orders WHERE organization_id = ? AND contact_id = ?`).all(orgId, contactId);
    const reservations = safe(() => db.prepare(`SELECT id, start_at, end_at, status, total_amount FROM reservations WHERE organization_id = ? AND contact_id = ?`).all(orgId, contactId), [] as any[]);
    const appointments = safe(() => db.prepare(`SELECT id, title, scheduled_start, scheduled_end, status, cancelled_at, cancelled_by, cancellation_reason FROM appointments WHERE organization_id = ? AND contact_id = ?`).all(orgId, contactId), [] as any[]);

    // ── Módulo Clínica (ADR-080) ─────────────────────────────────────────
    const patientProfile = safe(() => db.prepare(`SELECT * FROM patient_profiles WHERE organization_id = ? AND contact_id = ?`).get(orgId, contactId), null);
    const patientPlanHistory = safe(() => db.prepare(`SELECT * FROM patient_plan_history WHERE organization_id = ? AND contact_id = ? ORDER BY created_at ASC`).all(orgId, contactId), [] as any[]);
    const encounters = safe(() => db.prepare(
      `SELECT id, appointment_id, professional_id, professional_name_snapshot, status,
              subjective, objective, assessment, plan, form_data,
              follow_up_recommended_days, signed_at, created_at, updated_at
         FROM clinical_encounters
        WHERE organization_id = ? AND contact_id = ?
        ORDER BY created_at ASC`
    ).all(orgId, contactId), [] as any[]);
    const encounterHistory = safe(() => db.prepare(
      `SELECT h.encounter_id, h.changed_by, h.changed_fields_json, h.created_at
         FROM clinical_encounter_history h
         JOIN clinical_encounters e ON e.id = h.encounter_id AND e.organization_id = h.organization_id
        WHERE h.organization_id = ? AND e.contact_id = ?
        ORDER BY h.created_at ASC`
    ).all(orgId, contactId), [] as any[]);
    const addendums = safe(() => db.prepare(
      `SELECT id, encounter_id, author_name_snapshot, note, signed_with_pin, created_at
         FROM clinical_encounter_addendums
        WHERE organization_id = ? AND contact_id = ?
        ORDER BY created_at ASC`
    ).all(orgId, contactId), [] as any[]);
    const prescriptions = safe(() => db.prepare(
      `SELECT id, encounter_id, appointment_id, professional_name_snapshot,
              professional_registration_snapshot, professional_council_snapshot,
              header_notes, items_json, repeats_allowed, valid_until,
              status, signed_with_pin, signature_hash, signature_timestamp,
              issued_at, created_at
         FROM clinical_prescriptions
        WHERE organization_id = ? AND contact_id = ?
        ORDER BY created_at ASC`
    ).all(orgId, contactId), [] as any[]);
    const certificates = safe(() => db.prepare(
      `SELECT id, encounter_id, appointment_id, professional_name_snapshot,
              professional_registration_snapshot, professional_council_snapshot,
              cid, cid_description, days, purpose, notes,
              status, signed_with_pin, signature_hash, signature_timestamp,
              issued_at, created_at
         FROM clinical_medical_certificates
        WHERE organization_id = ? AND contact_id = ?
        ORDER BY created_at ASC`
    ).all(orgId, contactId), [] as any[]);
    const receipts = safe(() => db.prepare(
      `SELECT id, encounter_id, appointment_id, amount_cents, payment_method,
              description, notes, patient_document, patient_document_type,
              business_name_snapshot, business_document_snapshot, business_document_type_snapshot,
              professional_name_snapshot, professional_registration_snapshot, professional_council_snapshot,
              status, signed_with_pin, signature_hash, signature_timestamp,
              issued_at, created_at
         FROM clinical_receipts
        WHERE organization_id = ? AND contact_id = ?
        ORDER BY created_at ASC`
    ).all(orgId, contactId), [] as any[]);
    const attachments = safe(() => db.prepare(
      `SELECT id, encounter_id, appointment_id, label, kind, mime_type,
              original_filename, size_bytes, share_with_patient, uploaded_at, purged_at
         FROM clinical_encounter_attachments
        WHERE organization_id = ? AND contact_id = ?
        ORDER BY uploaded_at ASC`
    ).all(orgId, contactId), [] as any[]);
    const documentDeliveries = safe(() => db.prepare(
      `SELECT id, doc_kind, doc_id, channel_id, to_identifier, status,
              provider_message_id, error, sent_at
         FROM clinical_document_deliveries
        WHERE organization_id = ? AND contact_id = ?
        ORDER BY sent_at ASC`
    ).all(orgId, contactId), [] as any[]);
    const addendumNotifications = safe(() => db.prepare(
      `SELECT id, addendum_id, encounter_id, channel_id, to_identifier,
              status, provider_message_id, error, sent_at
         FROM clinical_addendum_notifications
        WHERE organization_id = ? AND contact_id = ?
        ORDER BY sent_at ASC`
    ).all(orgId, contactId), [] as any[]);
    const followUpNotifications = safe(() => db.prepare(
      `SELECT id, encounter_id, recommended_days, suggested_at,
              channel_id, to_identifier, status, provider_message_id, error, sent_at
         FROM clinical_follow_up_notifications
        WHERE organization_id = ? AND contact_id = ?
        ORDER BY sent_at ASC`
    ).all(orgId, contactId), [] as any[]);
    const patientAllergies = safe(() => db.prepare(
      `SELECT id, substance_display, kind, severity, reaction, notes,
              active, created_at, deactivated_at
         FROM clinical_patient_allergies
        WHERE organization_id = ? AND contact_id = ?
        ORDER BY created_at ASC`
    ).all(orgId, contactId), [] as any[]);
    const patientPortalTokens = safe(() => db.prepare(
      `SELECT id, active, expires_at, last_access_at, created_at
         FROM patient_portal_tokens
        WHERE organization_id = ? AND contact_id = ?
        ORDER BY created_at ASC`
    ).all(orgId, contactId), [] as any[]);

    const clinical = {
      patientProfile,
      patientPlanHistory,
      encounters,
      encounterHistory,
      addendums,
      prescriptions,
      certificates,
      receipts,
      attachments,
      documentDeliveries,
      addendumNotifications,
      followUpNotifications,
      patientAllergies,
      patientPortalTokens,
    };

    return {
      exportedAt: new Date().toISOString(),
      contact: {
        id: contact.id, name: contact.name, identifier: contact.identifier,
        email: contact.email, created_at: contact.created_at,
        tags: contact.tags, marketing_opt_out: !!contact.marketing_opt_out,
        anonymized_at: contact.anonymized_at,
      },
      tickets, messages, orders, reservations, appointments,
      clinical,
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
    // Fase 18: cascade pra portal token. Sem isso, o token gerado antes
    // continuava servindo receita/atestado/anexos por até 30 dias mesmo
    // depois de o paciente revogar. Faz por SQL direto pra evitar
    // dependência circular com `ClinicPatientPortalService`.
    if ((r.changes || 0) > 0 && PORTAL_CASCADE_CONSENTS.has(consentType)) {
      try {
        const revoke = db.prepare(`UPDATE patient_portal_tokens SET active = 0 WHERE organization_id = ? AND contact_id = ? AND active = 1`).run(orgId, contactId);
        if ((revoke.changes || 0) > 0) {
          logAuthEvent(orgId, actorId || null, contactId, "CLINIC_PATIENT_PORTAL_REVOKED_CASCADE", {
            trigger: consentType,
            tokensRevoked: Number(revoke.changes),
          });
        }
      } catch { /* tabela inexistente em orgs sem clínica — silencia */ }
    }
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

  /**
   * Pré-popula as categorias de consentimento conforme a vertical (ADR-093 §3).
   * Só age se a org AINDA NÃO tem consent_categories — nunca sobrescreve uma
   * config que o dono já ajustou (o controlador dos dados é ele). Chamado ao
   * definir a vertical (ModuleService.applyVertical).
   */
  static seedConsentForVertical(orgId: string, vertical?: string | null): boolean {
    const o = db.prepare(`SELECT consent_categories FROM organization_settings WHERE organization_id = ?`).get(orgId) as any;
    if (!o || (o.consent_categories != null && o.consent_categories !== "")) return false; // já configurado — respeita
    const cats = CONSENT_BY_VERTICAL[vertical || "outro"] || CONSENT_BY_VERTICAL.outro;
    db.prepare(`UPDATE organization_settings SET consent_categories = ? WHERE organization_id = ?`).run(JSON.stringify(cats), orgId);
    return true;
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
