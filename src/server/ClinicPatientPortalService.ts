/**
 * Módulo Clínica — Portal do Paciente (ADR-080 Fase L).
 *
 * Molde do `ClinicPortalService` (Fase D — Portal do Profissional): token
 * aleatório de 32 bytes, devolvido UMA vez ao gestor; no banco fica só o
 * hash SHA-256 + expiração. O link resolve por token (nunca por id), e
 * expõe SOMENTE dados do próprio paciente:
 *
 *   - próximas consultas (agendadas e futuras),
 *   - consultas passadas com professional,
 *   - receitas + atestados EMITIDOS (rascunho não vaza),
 *   - anexos que o profissional marcou como `share_with_patient=1`
 *     (default `NÃO` compartilha — evita foto de tratamento interno
 *     virar visível por acidente).
 *
 * NÃO expõe SOAP (achado clínico é do profissional) nem financeiro.
 *
 * LGPD Art.11: o gestor só pode gerar link se o paciente tem
 * `dados_sensiveis` (ver clínico) E `comunicacoes` (envio/portal)
 * concedidos.  Uma vez gerado, o token vale pelo TTL — expirado ou
 * revogado deixa de resolver.
 *
 * O link é SEMPRE enviado por outro canal (WhatsApp/e-mail); o paciente
 * usa o token no navegador.  Rota pública mora em `clinicPublic.ts`.
 */
import db from "./db.js";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { logAuthEvent } from "./auditLog.js";
import { LgpdService } from "./LgpdService.js";

const DEFAULT_TTL_DAYS = 30;
const MAX_TTL_DAYS = 90;

function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

const SENSITIVE_CONSENT = "dados_sensiveis";
const COMMS_CONSENT = "comunicacoes";

function requirePortalConsent(orgId: string, contactId: string) {
  if (!LgpdService.hasConsent(orgId, contactId, SENSITIVE_CONSENT)) {
    const e: any = new Error("Consentimento LGPD para dados sensíveis (saúde) é obrigatório.");
    e.code = "LGPD_CONSENT_REQUIRED"; throw e;
  }
  if (!LgpdService.hasConsent(orgId, contactId, COMMS_CONSENT)) {
    const e: any = new Error("Consentimento para comunicações é obrigatório para gerar o link do portal.");
    e.code = "LGPD_COMMS_CONSENT_REQUIRED"; throw e;
  }
}

export interface PortalTokenInfo {
  id: string;
  active: boolean;
  expiresAt: string | null;
  lastAccessAt: string | null;
  createdAt: string;
  createdBy: string | null;
}

export class ClinicPatientPortalService {
  /**
   * Gera token novo pra paciente. Devolve o token CRU **uma vez** — depois
   * fica só o hash. Cada chamada cria um token novo (paciente pode ter
   * múltiplos ativos: celular + tablet do familiar); pra revogar, chama
   * `revokeToken` (por id) ou `revokeAll` (por paciente).
   */
  static generateToken(orgId: string, contactId: string, actorId: string | null, opts: { ttlDays?: number } = {}): { token: string; id: string; expiresAt: string } {
    const contact = db.prepare(`SELECT id FROM contacts WHERE organization_id = ? AND id = ?`).get(orgId, contactId) as any;
    if (!contact) throw new Error("Paciente não encontrado.");
    requirePortalConsent(orgId, contactId);

    const ttl = Math.max(1, Math.min(MAX_TTL_DAYS, Math.floor(Number(opts?.ttlDays)) || DEFAULT_TTL_DAYS));
    const raw = randomBytes(32).toString("hex");
    const id = randomUUID();
    db.prepare(
      `INSERT INTO patient_portal_tokens (id, organization_id, contact_id, token_hash, active, expires_at, created_by)
       VALUES (?, ?, ?, ?, 1, datetime('now', ?), ?)`
    ).run(id, orgId, contactId, hashToken(raw), `+${ttl} days`, actorId);

    logAuthEvent(orgId, actorId, contactId, "CLINIC_PATIENT_PORTAL_ISSUED", { tokenId: id, ttlDays: ttl });
    const row = db.prepare(`SELECT expires_at FROM patient_portal_tokens WHERE id = ?`).get(id) as any;
    return { token: raw, id, expiresAt: row.expires_at };
  }

  static revokeToken(orgId: string, tokenId: string, actorId: string | null): boolean {
    const before = db.prepare(`SELECT contact_id FROM patient_portal_tokens WHERE id = ? AND organization_id = ?`).get(tokenId, orgId) as any;
    if (!before) return false;
    const r = db.prepare(`UPDATE patient_portal_tokens SET active = 0 WHERE id = ? AND organization_id = ? AND active = 1`).run(tokenId, orgId);
    if (r.changes > 0) logAuthEvent(orgId, actorId, before.contact_id, "CLINIC_PATIENT_PORTAL_REVOKED", { tokenId });
    return r.changes > 0;
  }

  static revokeAll(orgId: string, contactId: string, actorId: string | null): number {
    const r = db.prepare(`UPDATE patient_portal_tokens SET active = 0 WHERE organization_id = ? AND contact_id = ? AND active = 1`).run(orgId, contactId);
    if (r.changes > 0) logAuthEvent(orgId, actorId, contactId, "CLINIC_PATIENT_PORTAL_REVOKED", { revoked: r.changes });
    return Number(r.changes || 0);
  }

  /** Lista tokens do paciente pro gestor (sem expor o token cru). */
  static listTokens(orgId: string, contactId: string): PortalTokenInfo[] {
    const rows = db.prepare(
      `SELECT id, active, expires_at, last_access_at, created_at, created_by
         FROM patient_portal_tokens
        WHERE organization_id = ? AND contact_id = ?
        ORDER BY created_at DESC, rowid DESC`
    ).all(orgId, contactId) as any[];
    return rows.map((r) => ({
      id: r.id,
      active: !!Number(r.active),
      expiresAt: r.expires_at || null,
      lastAccessAt: r.last_access_at || null,
      createdAt: r.created_at,
      createdBy: r.created_by || null,
    }));
  }

  /**
   * Resolve um token cru e devolve `{orgId, contactId}` ou null (não lança —
   * quem chama decide a resposta HTTP). Registra `last_access_at`.
   *
   * Fase 18: revalida o consentimento LGPD Art.11 em CADA acesso. Antes,
   * um paciente que revogava `dados_sensiveis` ou `comunicacoes` continuava
   * exposto pelos links já entregues (WhatsApp cacheia URL no celular) por
   * até 30 dias — o guardrail só bloqueava a EMISSÃO de token novo. A
   * revogação também dispara `LgpdService.revokeConsent` que já marca os
   * tokens `active = 0` em cascata; este re-check é a segunda camada de
   * defesa caso a cascade tenha falhado ou o consent tenha sido revogado
   * fora dos endpoints (script, migration).
   */
  static resolveToken(rawToken: string): { orgId: string; contactId: string; tokenId: string } | null {
    const raw = String(rawToken || "").trim();
    if (!raw) return null;
    const row = db.prepare(
      `SELECT id, organization_id, contact_id FROM patient_portal_tokens
        WHERE token_hash = ? AND active = 1 AND expires_at > CURRENT_TIMESTAMP`
    ).get(hashToken(raw)) as any;
    if (!row) return null;
    // Re-check LGPD: se o paciente revogou o consentimento sensível OU o de
    // comunicações depois que o token foi emitido, o portal cala.
    if (!LgpdService.hasConsent(row.organization_id, row.contact_id, SENSITIVE_CONSENT)) return null;
    if (!LgpdService.hasConsent(row.organization_id, row.contact_id, COMMS_CONSENT)) return null;
    db.prepare(`UPDATE patient_portal_tokens SET last_access_at = CURRENT_TIMESTAMP WHERE id = ?`).run(row.id);
    return { orgId: row.organization_id, contactId: row.contact_id, tokenId: row.id };
  }

  /**
   * Snapshot do portal pro paciente: dados do próprio paciente + próximas
   * consultas + histórico + docs emitidos + anexos marcados como
   * compartilháveis. Sem SOAP, sem financeiro, sem outros pacientes.
   */
  static getPortalData(orgId: string, contactId: string, opts: { pastLimit?: number; upcomingLimit?: number } = {}) {
    const patient = db.prepare(`SELECT id, name FROM contacts WHERE organization_id = ? AND id = ?`).get(orgId, contactId) as any;
    if (!patient) throw new Error("Paciente não encontrado.");

    const org = db.prepare(`SELECT business_name FROM organization_settings WHERE organization_id = ?`).get(orgId) as any;
    const nowISO = new Date().toISOString();

    const upcoming = db.prepare(
      `SELECT id, title, scheduled_start, scheduled_end, status,
              professional_name_snapshot, room_name_snapshot
         FROM appointments
        WHERE organization_id = ? AND contact_id = ?
          AND scheduled_start >= ?
          AND status NOT IN ('cancelled','no_show')
        ORDER BY scheduled_start ASC LIMIT ?`
    ).all(orgId, contactId, nowISO, Math.max(1, Math.min(20, opts?.upcomingLimit ?? 5))) as any[];

    const past = db.prepare(
      `SELECT id, title, scheduled_start, status, professional_name_snapshot
         FROM appointments
        WHERE organization_id = ? AND contact_id = ?
          AND scheduled_start < ?
        ORDER BY scheduled_start DESC LIMIT ?`
    ).all(orgId, contactId, nowISO, Math.max(1, Math.min(50, opts?.pastLimit ?? 10))) as any[];

    const prescriptions = db.prepare(
      `SELECT id, issued_at, professional_name_snapshot
         FROM clinical_prescriptions
        WHERE organization_id = ? AND contact_id = ? AND status = 'issued'
        ORDER BY issued_at DESC LIMIT 50`
    ).all(orgId, contactId) as any[];

    const certificates = db.prepare(
      `SELECT id, issued_at, days, cid, professional_name_snapshot
         FROM clinical_medical_certificates
        WHERE organization_id = ? AND contact_id = ? AND status = 'issued'
        ORDER BY issued_at DESC LIMIT 50`
    ).all(orgId, contactId) as any[];

    const attachments = db.prepare(
      `SELECT id, label, kind, mime_type, original_filename, size_bytes, uploaded_at, encounter_id
         FROM clinical_encounter_attachments
        WHERE organization_id = ? AND contact_id = ? AND share_with_patient = 1
        ORDER BY uploaded_at DESC LIMIT 100`
    ).all(orgId, contactId) as any[];

    return {
      clinic: { name: org?.business_name || "Clínica" },
      patient: { name: patient.name || "Paciente" },
      upcoming: upcoming.map((a) => ({
        id: a.id, title: a.title, scheduledStart: a.scheduled_start, scheduledEnd: a.scheduled_end,
        status: a.status, professionalName: a.professional_name_snapshot, roomName: a.room_name_snapshot,
      })),
      past: past.map((a) => ({
        id: a.id, title: a.title, scheduledStart: a.scheduled_start,
        status: a.status, professionalName: a.professional_name_snapshot,
      })),
      prescriptions: prescriptions.map((p) => ({
        id: p.id, issuedAt: p.issued_at, professionalName: p.professional_name_snapshot,
      })),
      certificates: certificates.map((c) => ({
        id: c.id, issuedAt: c.issued_at, days: c.days, cid: c.cid, professionalName: c.professional_name_snapshot,
      })),
      attachments: attachments.map((x) => ({
        id: x.id, label: x.label, kind: x.kind, mimeType: x.mime_type,
        originalFilename: x.original_filename, sizeBytes: x.size_bytes,
        uploadedAt: x.uploaded_at, encounterId: x.encounter_id,
      })),
    };
  }

  /**
   * ADR-145 D6 / RN-013 §3 (Fatia 43). Quando o appointment do paciente
   * pertence a uma sessão em grupo, o portal pode mostrar contexto
   * ("Grupo — 5 participantes") SEM VAZAR NOMES/DADOS dos outros
   * participantes. Este método retorna apenas contadores agregados +
   * capacidade + status da sessão — nunca a lista de contatos.
   *
   * Blindagem: valida que o appointment pertence ao contactId; se não,
   * retorna null (evita enumeração de sessões via IDs alheios).
   */
  static groupInfoForOwnAppointment(orgId: string, contactId: string, appointmentId: string): {
    sessionId: string;
    title: string | null;
    sessionType: string;
    capacity: number;
    participantsCount: number;
    scheduledStart: string;
    scheduledEnd: string;
    status: string;
  } | null {
    const appt = db.prepare(
      `SELECT id, contact_id, schedule_session_id FROM appointments
        WHERE organization_id = ? AND id = ?`
    ).get(orgId, appointmentId) as any;
    if (!appt) return null;
    if (appt.contact_id !== contactId) return null; // não é seu appointment
    if (!appt.schedule_session_id) return null; // não é grupo

    const session = db.prepare(
      `SELECT id, title, session_type, capacity, scheduled_start, scheduled_end, status
         FROM clinic_schedule_sessions
        WHERE organization_id = ? AND id = ?`
    ).get(orgId, appt.schedule_session_id) as any;
    if (!session) return null;

    const cnt = db.prepare(
      `SELECT COUNT(*) AS c FROM appointments
        WHERE organization_id = ? AND schedule_session_id = ?
          AND status NOT IN ('cancelled')`
    ).get(orgId, appt.schedule_session_id) as any;

    return {
      sessionId: session.id,
      title: session.title ?? null,
      sessionType: session.session_type,
      capacity: Number(session.capacity),
      participantsCount: Number(cnt?.c) || 0,
      scheduledStart: session.scheduled_start,
      scheduledEnd: session.scheduled_end,
      status: session.status,
    };
  }

  /**
   * Guardas de acesso público a arquivo do paciente (chamadas nas rotas
   * públicas). Devolve `{orgId, contactId}` verificados OU null.
   */
  static assertOwnsPrescription(orgId: string, contactId: string, prescriptionId: string): boolean {
    const r = db.prepare(`SELECT 1 FROM clinical_prescriptions WHERE organization_id = ? AND id = ? AND contact_id = ? AND status = 'issued'`)
      .get(orgId, prescriptionId, contactId) as any;
    return !!r;
  }
  static assertOwnsCertificate(orgId: string, contactId: string, certificateId: string): boolean {
    const r = db.prepare(`SELECT 1 FROM clinical_medical_certificates WHERE organization_id = ? AND id = ? AND contact_id = ? AND status = 'issued'`)
      .get(orgId, certificateId, contactId) as any;
    return !!r;
  }
  static assertOwnsSharedAttachment(orgId: string, contactId: string, attachmentId: string): boolean {
    const r = db.prepare(`SELECT 1 FROM clinical_encounter_attachments WHERE organization_id = ? AND id = ? AND contact_id = ? AND share_with_patient = 1`)
      .get(orgId, attachmentId, contactId) as any;
    return !!r;
  }
}

export default ClinicPatientPortalService;
