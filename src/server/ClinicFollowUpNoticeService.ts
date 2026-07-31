/**
 * Módulo Clínica — NOTIFICAÇÃO AUTOMÁTICA DE RETORNO (ADR-080 Fase 26).
 *
 * Fecha o loop plano-de-tratamento → retorno-agendado sem depender da
 * recepção olhar a fila (Fase I). Scheduler varre encounters `signed`
 * com `follow_up_recommended_days` cujo retorno AINDA NÃO foi agendado
 * e, N dias antes da data sugerida, dispara WhatsApp pro paciente com
 * link do portal (Fase L) pra escolher horário.
 *
 * Best-effort e não bloqueante: qualquer falha grava row `failed`/`skipped`
 * e loga auditoria — o Scheduler nunca trava em falha de 1 paciente.
 *
 * Guardrails LGPD (mesmo padrão da Fase 24 addendum-notice):
 *   - `dados_sensiveis` obrigatório (contexto clínico da recomendação)
 *   - `comunicacoes` obrigatório (envio por canal exige consent separado)
 *
 * Dedup por (encounter, status IN sent|queued). Uma recomendação de
 * retorno = um lembrete. `force:true` bypassa (re-envio manual).
 *
 * Toggle por org: `clinic_followup_notification_enabled` (default 1).
 * Antecedência: `clinic_followup_notification_lead_days` (default 3,
 * faixa 1..30). Encounter cujo retorno já foi agendado (existe apt filho
 * ativo) NÃO recebe — a Fase M cuida do lembrete de consulta agendada.
 *
 * Determinístico, isolado por `organization_id`.
 */
import { randomUUID } from "node:crypto";
import db from "./db.js";
import { logAuthEvent, maskIdentifier } from "./auditLog.js";
import { LgpdService } from "./LgpdService.js";
import { MessageProviderService } from "./MessageProviderService.js";
import { ClinicPatientPortalService } from "./ClinicPatientPortalService.js";

const SENSITIVE_CONSENT = "dados_sensiveis";
const COMMS_CONSENT = "comunicacoes";
const TOKEN_TTL_DAYS = 7;
const DEFAULT_LEAD_DAYS = 3;
const MIN_LEAD_DAYS = 1;
const MAX_LEAD_DAYS = 30;
const APP_URL = (process.env.APP_URL || "").replace(/\/$/, "");

export type NoticeStatus = "queued" | "sent" | "failed" | "skipped";

export interface FollowUpNotification {
  id: string;
  organizationId: string;
  encounterId: string;
  contactId: string;
  sourceAppointmentId: string | null;
  recommendedDays: number | null;
  suggestedAt: string | null;
  channelId: string | null;
  toIdentifier: string | null;
  status: NoticeStatus;
  providerMessageId: string | null;
  error: string | null;
  portalTokenId: string | null;
  sentAt: string;
}

export type NoticeSender = (channelId: string, to: string, message: string) => Promise<any>;

function hydrate(r: any): FollowUpNotification | null {
  if (!r) return null;
  return {
    id: r.id,
    organizationId: r.organization_id,
    encounterId: r.encounter_id,
    contactId: r.contact_id,
    sourceAppointmentId: r.source_appointment_id ?? null,
    recommendedDays: r.recommended_days != null ? Number(r.recommended_days) : null,
    suggestedAt: r.suggested_at ?? null,
    channelId: r.channel_id ?? null,
    toIdentifier: r.to_identifier ?? null,
    status: r.status,
    providerMessageId: r.provider_message_id ?? null,
    error: r.error ?? null,
    portalTokenId: r.portal_token_id ?? null,
    sentAt: r.sent_at,
  };
}

function readConfig(orgId: string): { enabled: boolean; leadDays: number } {
  try {
    const r = db.prepare(
      `SELECT clinic_followup_notification_enabled AS en,
              clinic_followup_notification_lead_days AS lead
         FROM organization_settings WHERE organization_id = ?`
    ).get(orgId) as any;
    const enabled = r == null || r.en == null || Number(r.en) !== 0;
    const raw = Number(r?.lead ?? DEFAULT_LEAD_DAYS);
    const leadDays = Number.isFinite(raw)
      ? Math.max(MIN_LEAD_DAYS, Math.min(MAX_LEAD_DAYS, Math.floor(raw)))
      : DEFAULT_LEAD_DAYS;
    return { enabled, leadDays };
  } catch { return { enabled: true, leadDays: DEFAULT_LEAD_DAYS }; }
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
  orgId: string; encounterId: string; contactId: string;
  sourceAppointmentId: string | null;
  recommendedDays: number | null; suggestedAt: string | null;
  channelId: string | null; toIdentifier: string | null; status: NoticeStatus;
  error?: string | null; portalTokenId?: string | null;
}): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO clinical_follow_up_notifications
       (id, organization_id, encounter_id, contact_id, source_appointment_id,
        recommended_days, suggested_at, channel_id, to_identifier, status, error, portal_token_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id, row.orgId, row.encounterId, row.contactId, row.sourceAppointmentId,
    row.recommendedDays, row.suggestedAt,
    row.channelId, row.toIdentifier, row.status,
    row.error ?? null, row.portalTokenId ?? null
  );
  return id;
}

// PT-BR curto — o portal permite escolher slot (a Fase L já mostra próximas
// consultas do paciente; a extensão de "agendar novo" fica pra outra fatia,
// nesta o portal serve como landing pro paciente CHAMAR a clínica ou
// esperar contato). Mensagem intencionalmente honesta sobre isso.
function renderMessage(patientName: string, businessName: string, suggestedAtISO: string | null, portalUrl: string): string {
  const name = (patientName || "").split(/\s+/)[0] || "paciente";
  const when = suggestedAtISO ? formatDateBR(suggestedAtISO) : "";
  const line = when
    ? `Seu profissional em ${businessName} recomendou um retorno por volta de ${when}.`
    : `Seu profissional em ${businessName} recomendou um retorno.`;
  return `Olá, ${name}! ${line} Acesse seu portal para ver seu histórico e falar com a clínica pra marcar:\n${portalUrl}\n\nEste link é pessoal e expira em 7 dias.`;
}

function formatDateBR(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`;
}

interface Candidate {
  encounter_id: string;
  contact_id: string;
  source_appointment_id: string | null;
  recommended_days: number;
  signed_at: string | null;
  source_scheduled_start: string | null;
  contact_name: string | null;
  contact_identifier: string | null;
  contact_channel_id: string | null;
  business_name: string | null;
  suggested_at: string;
}

/**
 * SELECT dos encounters signed que ainda precisam de aviso de retorno.
 * Filtra:
 *   - status='signed' com follow_up_recommended_days > 0
 *   - retorno ainda NÃO agendado (sem apt filho ativo)
 *   - sem notificação prévia com status sent|queued (dedup)
 * Não filtra por janela aqui — quem decide se "está na hora de mandar"
 * é `dispatchForOrg` (compara suggestedAt vs nowMs + leadDaysMs).
 */
function candidatesForOrg(orgId: string): Candidate[] {
  const rows = db.prepare(`
    SELECT e.id AS encounter_id, e.contact_id, e.appointment_id AS source_appointment_id,
           e.follow_up_recommended_days AS recommended_days, e.signed_at,
           a.scheduled_start AS source_scheduled_start,
           c.name AS contact_name, c.identifier AS contact_identifier, c.channel_id AS contact_channel_id,
           os.business_name AS business_name
      FROM clinical_encounters e
      JOIN appointments a ON a.id = e.appointment_id AND a.organization_id = e.organization_id
      LEFT JOIN contacts c ON c.id = e.contact_id AND c.organization_id = e.organization_id
      LEFT JOIN organization_settings os ON os.organization_id = e.organization_id
     WHERE e.organization_id = ?
       AND e.status = 'signed'
       AND e.follow_up_recommended_days IS NOT NULL
       AND e.follow_up_recommended_days > 0
       AND NOT EXISTS (
         SELECT 1 FROM appointments ret
          WHERE ret.organization_id = e.organization_id
            AND ret.parent_appointment_id = e.appointment_id
            AND ret.status NOT IN ('cancelled','no_show')
       )
       AND NOT EXISTS (
         SELECT 1 FROM clinical_follow_up_notifications n
          WHERE n.organization_id = e.organization_id
            AND n.encounter_id = e.id
            AND n.status IN ('sent','queued')
       )
  `).all(orgId) as any[];
  return rows.map((r) => {
    const base = r.source_scheduled_start ? Date.parse(r.source_scheduled_start)
              : (r.signed_at ? Date.parse(r.signed_at) : NaN);
    const suggestedAt = Number.isFinite(base)
      ? new Date(base + Number(r.recommended_days) * 86400000).toISOString()
      : "";
    return { ...r, suggested_at: suggestedAt } as Candidate;
  });
}

export class ClinicFollowUpNoticeService {
  static list(orgId: string, encounterId: string): FollowUpNotification[] {
    const rows = db.prepare(
      `SELECT * FROM clinical_follow_up_notifications
        WHERE organization_id = ? AND encounter_id = ?
        ORDER BY sent_at DESC, rowid DESC`
    ).all(orgId, encounterId) as any[];
    return rows.map((r) => hydrate(r)!).filter(Boolean);
  }

  /**
   * Envia (ou tenta enviar) notificação de retorno pra 1 encounter.
   * Sempre grava row. Nunca lança. `sender` injetável.
   *
   * Fluxo:
   *   1. Encounter existe e é signed com follow_up_recommended_days? Não → null
   *   2. Toggle disabled → skipped disabled
   *   3. Retorno já agendado → skipped already_scheduled
   *   4. Dedup por (encounter, sent|queued) — sem force devolve existente
   *   5. LGPD sensível → skipped
   *   6. LGPD comms → skipped
   *   7. Sem identifier → failed
   *   8. Sem canal ativo → failed
   *   9. Token portal 7d
   *  10. INSERT queued → sender → UPDATE sent|failed
   */
  static async notifyForEncounter(
    orgId: string,
    encounterId: string,
    opts: { actorId?: string | null; force?: boolean; sender?: NoticeSender } = {}
  ): Promise<FollowUpNotification | null> {
    const enc = db.prepare(
      `SELECT id, contact_id, appointment_id, status, follow_up_recommended_days, signed_at
         FROM clinical_encounters
        WHERE id = ? AND organization_id = ?`
    ).get(encounterId, orgId) as any;
    if (!enc) return null;
    if (enc.status !== "signed") return null;
    const recommendedDays = Number(enc.follow_up_recommended_days || 0);
    if (!recommendedDays || recommendedDays <= 0) return null;

    // Calcula suggestedAt a partir do source appointment
    const srcApt = db.prepare(
      `SELECT id, scheduled_start FROM appointments WHERE id = ? AND organization_id = ?`
    ).get(enc.appointment_id, orgId) as any;
    const baseMs = srcApt?.scheduled_start ? Date.parse(srcApt.scheduled_start)
                : (enc.signed_at ? Date.parse(enc.signed_at) : NaN);
    const suggestedAt = Number.isFinite(baseMs)
      ? new Date(baseMs + recommendedDays * 86400000).toISOString()
      : null;

    const insert = (partial: Omit<Parameters<typeof insertNotice>[0], "orgId" | "encounterId" | "contactId" | "sourceAppointmentId" | "recommendedDays" | "suggestedAt">) =>
      insertNotice({
        orgId, encounterId: enc.id, contactId: enc.contact_id,
        sourceAppointmentId: enc.appointment_id ?? null,
        recommendedDays, suggestedAt,
        ...partial,
      });

    // (2) Toggle desativado
    const { enabled } = readConfig(orgId);
    if (!enabled) {
      const id = insert({ channelId: null, toIdentifier: null, status: "skipped", error: "notificação desabilitada por config" });
      logAuthEvent(orgId, opts.actorId ?? null, enc.contact_id, "CLINIC_FOLLOWUP_NOTICE_SKIPPED", {
        encounterId, reason: "disabled",
      });
      return hydrate(db.prepare(`SELECT * FROM clinical_follow_up_notifications WHERE id = ?`).get(id));
    }

    // (3) Retorno já agendado — não faz sentido lembrar de agendar o que já está agendado
    const alreadyScheduled = db.prepare(
      `SELECT 1 FROM appointments
        WHERE organization_id = ? AND parent_appointment_id = ?
          AND status NOT IN ('cancelled','no_show') LIMIT 1`
    ).get(orgId, enc.appointment_id) as any;
    if (alreadyScheduled) {
      const id = insert({ channelId: null, toIdentifier: null, status: "skipped", error: "retorno já agendado" });
      logAuthEvent(orgId, opts.actorId ?? null, enc.contact_id, "CLINIC_FOLLOWUP_NOTICE_SKIPPED", {
        encounterId, reason: "already_scheduled",
      });
      return hydrate(db.prepare(`SELECT * FROM clinical_follow_up_notifications WHERE id = ?`).get(id));
    }

    // (4) Dedup
    if (!opts.force) {
      const existing = db.prepare(
        `SELECT * FROM clinical_follow_up_notifications
          WHERE organization_id = ? AND encounter_id = ? AND status IN ('sent','queued')
          ORDER BY sent_at DESC, rowid DESC LIMIT 1`
      ).get(orgId, encounterId) as any;
      if (existing) return hydrate(existing);
    }

    // (5) LGPD sensível
    if (!LgpdService.hasConsent(orgId, enc.contact_id, SENSITIVE_CONSENT)) {
      const id = insert({ channelId: null, toIdentifier: null, status: "skipped", error: "LGPD_CONSENT_REQUIRED" });
      logAuthEvent(orgId, opts.actorId ?? null, enc.contact_id, "CLINIC_FOLLOWUP_NOTICE_SKIPPED", {
        encounterId, reason: "LGPD_CONSENT_REQUIRED",
      });
      return hydrate(db.prepare(`SELECT * FROM clinical_follow_up_notifications WHERE id = ?`).get(id));
    }
    // (6) LGPD comms
    if (!LgpdService.hasConsent(orgId, enc.contact_id, COMMS_CONSENT)) {
      const id = insert({ channelId: null, toIdentifier: null, status: "skipped", error: "LGPD_COMMS_CONSENT_REQUIRED" });
      logAuthEvent(orgId, opts.actorId ?? null, enc.contact_id, "CLINIC_FOLLOWUP_NOTICE_SKIPPED", {
        encounterId, reason: "LGPD_COMMS_CONSENT_REQUIRED",
      });
      return hydrate(db.prepare(`SELECT * FROM clinical_follow_up_notifications WHERE id = ?`).get(id));
    }

    const contact = db.prepare(
      `SELECT id, name, identifier, channel_id FROM contacts WHERE organization_id = ? AND id = ?`
    ).get(orgId, enc.contact_id) as any;
    if (!contact || !contact.identifier) {
      const id = insert({
        channelId: null, toIdentifier: null, status: "failed",
        error: contact ? "Paciente sem identificador (telefone/WhatsApp)." : "Paciente não encontrado.",
      });
      logAuthEvent(orgId, opts.actorId ?? null, enc.contact_id, "CLINIC_FOLLOWUP_NOTICE_FAILED", {
        encounterId, error: contact ? "no_identifier" : "no_contact",
      });
      return hydrate(db.prepare(`SELECT * FROM clinical_follow_up_notifications WHERE id = ?`).get(id));
    }

    const channelId = resolveChannel(orgId, contact.channel_id);
    if (!channelId) {
      const id = insert({
        channelId: null, toIdentifier: contact.identifier, status: "failed",
        error: "Nenhum canal WhatsApp ativo.",
      });
      logAuthEvent(orgId, opts.actorId ?? null, enc.contact_id, "CLINIC_FOLLOWUP_NOTICE_FAILED", {
        encounterId, error: "no_channel",
      });
      return hydrate(db.prepare(`SELECT * FROM clinical_follow_up_notifications WHERE id = ?`).get(id));
    }

    // (9) Token curto (7d) — sob revoke posterior, resolveToken revalida.
    let tokenInfo: { token: string; id: string; expiresAt: string };
    try {
      tokenInfo = ClinicPatientPortalService.generateToken(orgId, enc.contact_id, opts.actorId ?? null, { ttlDays: TOKEN_TTL_DAYS });
    } catch (e: any) {
      const id = insert({
        channelId, toIdentifier: contact.identifier, status: "failed",
        error: `Falha ao gerar token do portal: ${String(e?.message || e).slice(0, 200)}`,
      });
      logAuthEvent(orgId, opts.actorId ?? null, enc.contact_id, "CLINIC_FOLLOWUP_NOTICE_FAILED", {
        encounterId, error: "portal_token_failed",
      });
      return hydrate(db.prepare(`SELECT * FROM clinical_follow_up_notifications WHERE id = ?`).get(id));
    }

    const org = db.prepare(`SELECT business_name FROM organization_settings WHERE organization_id = ?`).get(orgId) as any;
    const portalPath = `/patient/${tokenInfo.token}`;
    const portalUrl = APP_URL ? `${APP_URL}${portalPath}` : portalPath;
    const message = renderMessage(contact.name || "paciente", org?.business_name || "Clínica", suggestedAt, portalUrl);

    // (10) queue → sender → sent|failed
    const id = insert({
      channelId, toIdentifier: contact.identifier, status: "queued", portalTokenId: tokenInfo.id,
    });

    const sender: NoticeSender = opts.sender || MessageProviderService.sendMessage.bind(MessageProviderService);
    try {
      const result = await sender(channelId, contact.identifier, message);
      const providerMessageId = typeof result === "string" ? result
        : (result?.messages?.[0]?.id || result?.key?.id || result?.id || null);
      db.prepare(
        `UPDATE clinical_follow_up_notifications SET status='sent', provider_message_id=? WHERE id=? AND organization_id=?`
      ).run(providerMessageId, id, orgId);
      logAuthEvent(orgId, opts.actorId ?? null, enc.contact_id, "CLINIC_FOLLOWUP_NOTIFIED", {
        encounterId, notificationId: id, channelId, portalTokenId: tokenInfo.id,
        recommendedDays, suggestedAt,
        toIdentifier: maskIdentifier(contact.identifier),
      });
    } catch (e: any) {
      const err = String(e?.message || e).slice(0, 500);
      db.prepare(
        `UPDATE clinical_follow_up_notifications SET status='failed', error=? WHERE id=? AND organization_id=?`
      ).run(err, id, orgId);
      logAuthEvent(orgId, opts.actorId ?? null, enc.contact_id, "CLINIC_FOLLOWUP_NOTICE_FAILED", {
        encounterId, notificationId: id, error: err.slice(0, 200),
      });
    }

    return hydrate(db.prepare(`SELECT * FROM clinical_follow_up_notifications WHERE id = ?`).get(id));
  }

  /**
   * Passe do Scheduler — 1 org. Retorna `{scanned, notified, skipped, failed}`
   * pra métrica/log. Percorre candidatos elegíveis e envia só os que caíram
   * na JANELA (`suggestedAt <= now + leadDays`). Best-effort por-encounter.
   */
  static async dispatchForOrg(orgId: string, opts: { nowMs?: number; sender?: NoticeSender } = {}): Promise<{ scanned: number; notified: number; skipped: number; failed: number }> {
    const summary = { scanned: 0, notified: 0, skipped: 0, failed: 0 };
    const { enabled, leadDays } = readConfig(orgId);
    if (!enabled) return summary;

    const nowMs = Number.isFinite(opts.nowMs as number) ? (opts.nowMs as number) : Date.now();
    const windowMs = nowMs + leadDays * 86400000;

    const list = candidatesForOrg(orgId);
    summary.scanned = list.length;

    for (const c of list) {
      const sMs = c.suggested_at ? Date.parse(c.suggested_at) : NaN;
      if (!Number.isFinite(sMs)) continue;
      // Fora da janela? (ainda cedo demais)
      if (sMs > windowMs) continue;
      // Nota: NÃO descartamos "muito tarde" — se o retorno recomendado já
      // passou e ninguém agendou, o lembrete ainda vale (paciente pode
      // agendar em atraso). Só filtramos por janela superior.

      try {
        const notif = await this.notifyForEncounter(orgId, c.encounter_id, {
          actorId: null,
          sender: opts.sender,
        });
        if (!notif) continue;
        if (notif.status === "sent") summary.notified++;
        else if (notif.status === "skipped") summary.skipped++;
        else if (notif.status === "failed") summary.failed++;
      } catch (e) {
        console.error("[Clínica] follow-up notice falhou", orgId, c.encounter_id, e);
        summary.failed++;
      }
    }
    return summary;
  }
}

export default ClinicFollowUpNoticeService;
