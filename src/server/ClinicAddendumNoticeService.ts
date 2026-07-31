/**
 * Módulo Clínica — NOTIFICAÇÃO DE ADDENDUM AO PACIENTE (ADR-080 Fase 24).
 *
 * Fecha o loop da Fase 20: quando o profissional adiciona addendum ao
 * prontuário assinado, o paciente é avisado via WhatsApp com link seguro do
 * portal (Fase L) pra ler o que mudou. Sem esta fatia, o paciente só
 * descobre no próximo atendimento — quebrando confiança e a intenção
 * clínica do addendum (informar o titular).
 *
 * Best-effort e não bloqueante: qualquer falha (canal fora do ar, provider
 * off, sem identifier) grava row com status `failed`/`skipped` e loga
 * auditoria — nunca lança pra fora, pra não travar a criação do addendum
 * clínico (o dado precisa ser gravado mesmo que a notificação falhe).
 *
 * Guardrails LGPD:
 *   - `dados_sensiveis` (SENSITIVE_CONSENT) obrigatório — sem consent, nem
 *     tenta enviar (grava skip + audit).
 *   - `comunicacoes` (COMMS_CONSENT) obrigatório — mesmo racional das Fases
 *     M/K (envio por canal exige consentimento SEPARADO).
 *   - `generateToken` do portal já revalida ambos internamente (Fase L).
 *
 * Dedup: por (addendum_id, status IN sent|queued). Mesma nota clínica não
 * é notificada 2×; `force:true` bypassa (re-envio manual pra caso do
 * paciente ter apagado a mensagem).
 *
 * Config por org: `clinic_addendum_notification_enabled` (default 1) —
 * clínicas que preferem contato manual podem desligar globalmente.
 */
import { randomUUID } from "node:crypto";
import db from "./db.js";
import { logAuthEvent, maskIdentifier } from "./auditLog.js";
import { LgpdService } from "./LgpdService.js";
import { MessageProviderService } from "./MessageProviderService.js";
import { ClinicPatientPortalService } from "./ClinicPatientPortalService.js";

const SENSITIVE_CONSENT = "dados_sensiveis";
const COMMS_CONSENT = "comunicacoes";
const TOKEN_TTL_DAYS = 7; // curto — a notificação em si é pontual
const APP_URL = (process.env.APP_URL || "").replace(/\/$/, "");

export type NoticeStatus = "queued" | "sent" | "failed" | "skipped";

export interface AddendumNotification {
  id: string;
  organizationId: string;
  addendumId: string;
  encounterId: string;
  contactId: string;
  channelId: string | null;
  toIdentifier: string | null;
  status: NoticeStatus;
  providerMessageId: string | null;
  error: string | null;
  portalTokenId: string | null;
  sentAt: string;
}

export type NoticeSender = (channelId: string, to: string, message: string) => Promise<any>;

function hydrate(r: any): AddendumNotification | null {
  if (!r) return null;
  return {
    id: r.id,
    organizationId: r.organization_id,
    addendumId: r.addendum_id,
    encounterId: r.encounter_id,
    contactId: r.contact_id,
    channelId: r.channel_id ?? null,
    toIdentifier: r.to_identifier ?? null,
    status: r.status,
    providerMessageId: r.provider_message_id ?? null,
    error: r.error ?? null,
    portalTokenId: r.portal_token_id ?? null,
    sentAt: r.sent_at,
  };
}

function isEnabled(orgId: string): boolean {
  try {
    const r = db.prepare(`SELECT clinic_addendum_notification_enabled FROM organization_settings WHERE organization_id = ?`).get(orgId) as any;
    // default 1 quando row/coluna ausente
    return r == null || r.clinic_addendum_notification_enabled == null || Number(r.clinic_addendum_notification_enabled) !== 0;
  } catch { return true; }
}

function resolveChannel(orgId: string, contactChannelId: string | null): string | null {
  if (contactChannelId) {
    const c = db.prepare(`SELECT id, status FROM channels WHERE id = ? AND organization_id = ?`).get(contactChannelId, orgId) as any;
    if (c && c.status !== "disabled" && c.status !== "disconnected") return c.id;
  }
  const fb = db.prepare(
    `SELECT id FROM channels WHERE organization_id = ?
       AND status NOT IN ('disabled','disconnected')
      ORDER BY (provider LIKE 'evolution%') DESC, created_at ASC LIMIT 1`
  ).get(orgId) as any;
  return fb?.id || null;
}

function insertNotice(row: {
  orgId: string; addendumId: string; encounterId: string; contactId: string;
  channelId: string | null; toIdentifier: string | null; status: NoticeStatus;
  error?: string | null; portalTokenId?: string | null;
}): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO clinical_addendum_notifications
       (id, organization_id, addendum_id, encounter_id, contact_id, channel_id, to_identifier, status, error, portal_token_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id, row.orgId, row.addendumId, row.encounterId, row.contactId,
    row.channelId, row.toIdentifier, row.status,
    row.error ?? null, row.portalTokenId ?? null
  );
  return id;
}

function renderMessage(patientName: string, businessName: string, portalUrl: string): string {
  const name = (patientName || "").split(/\s+/)[0] || "paciente";
  return `Olá, ${name}! Seu prontuário foi atualizado em ${businessName}. Acesse com segurança pelo link:\n${portalUrl}\n\nEste link é pessoal e expira em 7 dias.`;
}

export class ClinicAddendumNoticeService {
  static list(orgId: string, addendumId: string): AddendumNotification[] {
    const rows = db.prepare(
      `SELECT * FROM clinical_addendum_notifications
        WHERE organization_id = ? AND addendum_id = ?
        ORDER BY sent_at DESC, rowid DESC`
    ).all(orgId, addendumId) as any[];
    return rows.map((r) => hydrate(r)!).filter(Boolean);
  }

  /**
   * Envia (ou tenta enviar) notificação pra 1 addendum. Sempre grava row
   * (sent/failed/skipped) e devolve. Nunca lança — best-effort real.
   *
   * `sender` injetável facilita teste sem chamada de rede.
   */
  static async notifyForAddendum(
    orgId: string,
    addendumId: string,
    opts: { actorId?: string | null; force?: boolean; sender?: NoticeSender } = {}
  ): Promise<AddendumNotification | null> {
    const addendum = db.prepare(
      `SELECT id, encounter_id, contact_id FROM clinical_encounter_addendums
        WHERE id = ? AND organization_id = ?`
    ).get(addendumId, orgId) as any;
    if (!addendum) return null;

    // Feature toggle por org
    if (!isEnabled(orgId)) {
      const id = insertNotice({
        orgId, addendumId, encounterId: addendum.encounter_id, contactId: addendum.contact_id,
        channelId: null, toIdentifier: null, status: "skipped", error: "notificação desabilitada por config",
      });
      logAuthEvent(orgId, opts.actorId ?? null, addendum.contact_id, "CLINIC_ADDENDUM_NOTICE_SKIPPED", {
        addendumId, reason: "disabled",
      });
      return hydrate(db.prepare(`SELECT * FROM clinical_addendum_notifications WHERE id = ?`).get(id));
    }

    // Dedup por (addendum, sent|queued). Se já tem sucesso, devolve o
    // existente. `force:true` ignora e gera uma nova row.
    if (!opts.force) {
      const existing = db.prepare(
        `SELECT * FROM clinical_addendum_notifications
          WHERE organization_id = ? AND addendum_id = ? AND status IN ('sent','queued')
          ORDER BY sent_at DESC, rowid DESC LIMIT 1`
      ).get(orgId, addendumId) as any;
      if (existing) return hydrate(existing);
    }

    // LGPD sensível (sem consent, nem sequer tenta)
    if (!LgpdService.hasConsent(orgId, addendum.contact_id, SENSITIVE_CONSENT)) {
      const id = insertNotice({
        orgId, addendumId, encounterId: addendum.encounter_id, contactId: addendum.contact_id,
        channelId: null, toIdentifier: null, status: "skipped", error: "LGPD_CONSENT_REQUIRED",
      });
      logAuthEvent(orgId, opts.actorId ?? null, addendum.contact_id, "CLINIC_ADDENDUM_NOTICE_SKIPPED", {
        addendumId, reason: "LGPD_CONSENT_REQUIRED",
      });
      return hydrate(db.prepare(`SELECT * FROM clinical_addendum_notifications WHERE id = ?`).get(id));
    }
    // LGPD comms
    if (!LgpdService.hasConsent(orgId, addendum.contact_id, COMMS_CONSENT)) {
      const id = insertNotice({
        orgId, addendumId, encounterId: addendum.encounter_id, contactId: addendum.contact_id,
        channelId: null, toIdentifier: null, status: "skipped", error: "LGPD_COMMS_CONSENT_REQUIRED",
      });
      logAuthEvent(orgId, opts.actorId ?? null, addendum.contact_id, "CLINIC_ADDENDUM_NOTICE_SKIPPED", {
        addendumId, reason: "LGPD_COMMS_CONSENT_REQUIRED",
      });
      return hydrate(db.prepare(`SELECT * FROM clinical_addendum_notifications WHERE id = ?`).get(id));
    }

    const contact = db.prepare(
      `SELECT id, name, identifier, channel_id FROM contacts WHERE organization_id = ? AND id = ?`
    ).get(orgId, addendum.contact_id) as any;
    if (!contact || !contact.identifier) {
      const id = insertNotice({
        orgId, addendumId, encounterId: addendum.encounter_id, contactId: addendum.contact_id,
        channelId: null, toIdentifier: null, status: "failed",
        error: contact ? "Paciente sem identificador (telefone/WhatsApp)." : "Paciente não encontrado.",
      });
      logAuthEvent(orgId, opts.actorId ?? null, addendum.contact_id, "CLINIC_ADDENDUM_NOTICE_FAILED", {
        addendumId, error: contact ? "no_identifier" : "no_contact",
      });
      return hydrate(db.prepare(`SELECT * FROM clinical_addendum_notifications WHERE id = ?`).get(id));
    }

    const channelId = resolveChannel(orgId, contact.channel_id);
    if (!channelId) {
      const id = insertNotice({
        orgId, addendumId, encounterId: addendum.encounter_id, contactId: addendum.contact_id,
        channelId: null, toIdentifier: contact.identifier, status: "failed",
        error: "Nenhum canal WhatsApp ativo.",
      });
      logAuthEvent(orgId, opts.actorId ?? null, addendum.contact_id, "CLINIC_ADDENDUM_NOTICE_FAILED", {
        addendumId, error: "no_channel",
      });
      return hydrate(db.prepare(`SELECT * FROM clinical_addendum_notifications WHERE id = ?`).get(id));
    }

    // Token curto (7d), específico pra esta notificação. Sob revoke de
    // consent posterior, ClinicPatientPortalService.resolveToken já
    // revalida em cada acesso (Fase 18).
    let tokenInfo: { token: string; id: string; expiresAt: string };
    try {
      tokenInfo = ClinicPatientPortalService.generateToken(orgId, addendum.contact_id, opts.actorId ?? null, { ttlDays: TOKEN_TTL_DAYS });
    } catch (e: any) {
      const id = insertNotice({
        orgId, addendumId, encounterId: addendum.encounter_id, contactId: addendum.contact_id,
        channelId, toIdentifier: contact.identifier, status: "failed",
        error: `Falha ao gerar token do portal: ${String(e?.message || e).slice(0, 200)}`,
      });
      logAuthEvent(orgId, opts.actorId ?? null, addendum.contact_id, "CLINIC_ADDENDUM_NOTICE_FAILED", {
        addendumId, error: "portal_token_failed",
      });
      return hydrate(db.prepare(`SELECT * FROM clinical_addendum_notifications WHERE id = ?`).get(id));
    }

    const org = db.prepare(`SELECT business_name FROM organization_settings WHERE organization_id = ?`).get(orgId) as any;
    const portalPath = `/patient/${tokenInfo.token}`;
    const portalUrl = APP_URL ? `${APP_URL}${portalPath}` : portalPath;
    const message = renderMessage(contact.name || "paciente", org?.business_name || "Clínica", portalUrl);

    // Queue row antes do envio (rastro mesmo se o provider travar)
    const id = insertNotice({
      orgId, addendumId, encounterId: addendum.encounter_id, contactId: addendum.contact_id,
      channelId, toIdentifier: contact.identifier, status: "queued", portalTokenId: tokenInfo.id,
    });

    const sender: NoticeSender = opts.sender || MessageProviderService.sendMessage.bind(MessageProviderService);
    try {
      const result = await sender(channelId, contact.identifier, message);
      const providerMessageId = typeof result === "string" ? result
        : (result?.messages?.[0]?.id || result?.key?.id || result?.id || null);
      db.prepare(
        `UPDATE clinical_addendum_notifications SET status='sent', provider_message_id=? WHERE id=? AND organization_id=?`
      ).run(providerMessageId, id, orgId);
      logAuthEvent(orgId, opts.actorId ?? null, addendum.contact_id, "CLINIC_ADDENDUM_NOTIFIED", {
        addendumId, notificationId: id, channelId, portalTokenId: tokenInfo.id,
        toIdentifier: maskIdentifier(contact.identifier),
      });
    } catch (e: any) {
      const err = String(e?.message || e).slice(0, 500);
      db.prepare(
        `UPDATE clinical_addendum_notifications SET status='failed', error=? WHERE id=? AND organization_id=?`
      ).run(err, id, orgId);
      logAuthEvent(orgId, opts.actorId ?? null, addendum.contact_id, "CLINIC_ADDENDUM_NOTICE_FAILED", {
        addendumId, notificationId: id, error: err.slice(0, 200),
      });
    }

    return hydrate(db.prepare(`SELECT * FROM clinical_addendum_notifications WHERE id = ?`).get(id));
  }
}

export default ClinicAddendumNoticeService;
