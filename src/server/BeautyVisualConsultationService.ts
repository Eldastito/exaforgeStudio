/**
 * BeautyVisualConsultationService (ADR-169 F5 / BEAUTY-005) — fundação da
 * Beauty AI (Simulador de Cabelo).
 *
 * Reusa 100% do padrão canônico do Fashion Studio (`FashionAvatarService`),
 * adaptado à vertical Beleza:
 *
 *  - CRM canônico: usa `contact_id` (não `customer_id` do storefront).
 *  - Consent TIPADO: 4 escopos separados (RN-BS-04 — hair_simulation ≠
 *    use_in_marketing; uma autorização NUNCA implica a outra). Consent é
 *    pré-condição do upload — sem consent ativo, o arquivo nem grava.
 *  - STORAGE PRIVADO: arquivos em DATA_DIR/private_media (NÃO servido por
 *    express.static — o único caminho de leitura é URL assinada HMAC).
 *  - QUARENTENA: todo upload nasce `quarantined`. Validação por IA (F6+)
 *    aprovará automaticamente; em F5 a aprovação é manual (`approveAsset`).
 *  - EXIF STRIP via sharp (RN-BS-04): nunca guarda metadata (GPS, aparelho).
 *  - URL ASSINADA compartilhada (`fileSigning` — escopo
 *    `beauty_private_media_v1`, TTL 15min, `timingSafeEqual`).
 *  - RETENÇÃO configurável (default 30d, clamp 1..365 — RN-BS-04) + purga
 *    preguiçosa no acesso + Scheduler pass (F16+).
 *  - REVOGAÇÃO DE CONSENT → DELETE DE ASSETS (LGPD Art.18): revogar
 *    `hair_simulation` apaga todos os avatares do contato imediatamente.
 *
 * Guardrails RN-BS ATIVOS nesta fatia:
 *  - RN-BS-04: consent tipado antes do processamento; escopos SEPARADOS;
 *    quarentena; EXIF strip; URL assinada TTL 15min; retenção configurável.
 *  - RN-BS-05: `safety_report_json` só flags booleanas; NUNCA log de foto/
 *    base64/prompt.
 *  - RN-BS-07: isolamento cross-tenant duro (organization_id em toda query;
 *    contact/consultation/asset validados na mesma org).
 *  - RN-BS-11: sem foto → não gera consulta pronta (status permanece draft);
 *    quarantena aguarda validação, nunca aprova no vácuo.
 *
 * Beauty AI real (Simulador de Cabelo — geração de imagem) vem em F6:
 * `BeautyHairSimulationProvider` atrás do MESMO contrato `TryOnProvider`
 * do Fashion Studio (prompt invertido — preserva rosto/corpo, ALTERA cabelo).
 */
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { randomUUID } from "node:crypto";
import db from "./db.js";
import { logAuthEvent } from "./auditLog.js";
import { signKey, verifyKey, safeStorageKey, DEFAULT_SIGNED_TTL_MS } from "./fileSigning.js";

const PRIVATE_MEDIA_DIR = path.join(process.env.DATA_DIR || process.cwd(), "private_media");
try { fs.mkdirSync(PRIVATE_MEDIA_DIR, { recursive: true }); } catch { /* noop */ }

const SIGNING_SCOPE = "beauty_private_media_v1";
const PUBLIC_MEDIA_ROUTE = "/api/public/beauty/media"; // F6+ terá a rota; F5 só emite URL

// Escopos aceitos de consent (RN-BS-04 — cada um é INDEPENDENTE).
export const BEAUTY_CONSENT_SCOPES = [
  "hair_simulation",      // upload+processamento da foto pro Simulador
  "use_in_marketing",     // publicar antes/depois no Instagram
  "whatsapp_notification",// receber lembretes/oportunidades
  "guardian_approval",    // menor de idade — autoriza responsável
] as const;
export type BeautyConsentScope = (typeof BEAUTY_CONSENT_SCOPES)[number];

export const BEAUTY_CONSULTATION_STATUSES = [
  "draft",       // criada, aguardando foto
  "ready",       // foto aprovada, pronta pra simulação (F6)
  "selected",    // cliente escolheu uma simulação
  "scheduled",   // virou agendamento (F10)
  "abandoned",   // TTL vencido sem escolha
] as const;
export type BeautyConsultationStatus = (typeof BEAUTY_CONSULTATION_STATUSES)[number];

export interface BeautyConsentRow {
  id: string;
  organizationId: string;
  contactId: string;
  consentType: BeautyConsentScope;
  policyVersion: string;
  grantedAt: string;
  revokedAt: string | null;
}

export interface BeautyConsultationRow {
  id: string;
  organizationId: string;
  contactId: string | null;
  status: BeautyConsultationStatus;
  goal: string | null;
  intensity: string | null;
  referencePhotoKey: string | null;
  consentId: string | null;
  selectedSimulationId: string | null;
  selectedAt: string | null;
  scheduledAppointmentId: string | null;
  expiresAt: string | null;
  createdAt: string;
}

export interface BeautyAvatarAssetRow {
  id: string;
  organizationId: string;
  contactId: string;
  consultationId: string | null;
  storageKey: string | null;
  status: "quarantined" | "approved" | "rejected" | "deleted" | "expired";
  safetyReportJson: string | null;
  consentId: string | null;
  expiresAt: string | null;
  deletedAt: string | null;
  createdAt: string;
  signedUrl?: string | null;
}

export class BeautyVisualConsultationService {
  // ─────────────────────── CONSENT (RN-BS-04) ────────────────────────────

  /**
   * Concede consent para (org, contact, scope). Idempotente: se já existe
   * ativo, RE-USA (mesmo id, mesma policy_version). Escopo inválido → lança.
   * Preserva histórico — nunca UPDATE cruzado, sempre novo INSERT após
   * revogar o anterior.
   */
  static grantConsent(
    orgId: string,
    contactId: string,
    consentType: BeautyConsentScope,
    policyVersion = "v1",
  ): string {
    if (!(BEAUTY_CONSENT_SCOPES as readonly string[]).includes(consentType)) {
      throw new Error(`Escopo de consent inválido: ${consentType}`);
    }
    // Se já tem ativo, reusa (idempotente)
    const active = db.prepare(
      `SELECT id FROM beauty_consents
        WHERE organization_id = ? AND contact_id = ? AND consent_type = ? AND revoked_at IS NULL
        ORDER BY granted_at DESC LIMIT 1`,
    ).get(orgId, contactId, consentType) as any;
    if (active) return active.id;
    const id = randomUUID();
    db.prepare(
      `INSERT INTO beauty_consents (id, organization_id, contact_id, consent_type, policy_version)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(id, orgId, contactId, consentType, String(policyVersion).slice(0, 40));
    try { logAuthEvent(orgId, null, contactId, "BEAUTY_CONSENT_GRANTED", { consentType, policyVersion }); } catch { /* noop */ }
    return id;
  }

  /**
   * Revoga consent do escopo. Idempotente. Se escopo for `hair_simulation`,
   * apaga na hora todos os avatares do contato (LGPD Art.18 — direito ao
   * esquecimento aplicado ao dado sensível).
   */
  static revokeConsent(orgId: string, contactId: string, consentType: BeautyConsentScope): { revoked: boolean; assetsDeleted: number } {
    const r = db.prepare(
      `UPDATE beauty_consents SET revoked_at = CURRENT_TIMESTAMP
        WHERE organization_id = ? AND contact_id = ? AND consent_type = ? AND revoked_at IS NULL`,
    ).run(orgId, contactId, consentType);
    const revoked = r.changes > 0;
    let assetsDeleted = 0;
    if (revoked && consentType === "hair_simulation") {
      assetsDeleted = this.deleteAllForContact(orgId, contactId);
    }
    if (revoked) {
      try { logAuthEvent(orgId, null, contactId, "BEAUTY_CONSENT_REVOKED", { consentType, assetsDeleted }); } catch { /* noop */ }
    }
    return { revoked, assetsDeleted };
  }

  /** Consent ATIVO (não revogado) por (org, contact, scope). */
  static activeConsent(orgId: string, contactId: string, consentType: BeautyConsentScope): BeautyConsentRow | null {
    const r = db.prepare(
      `SELECT id, organization_id, contact_id, consent_type, policy_version, granted_at, revoked_at
         FROM beauty_consents
        WHERE organization_id = ? AND contact_id = ? AND consent_type = ? AND revoked_at IS NULL
        ORDER BY granted_at DESC LIMIT 1`,
    ).get(orgId, contactId, consentType) as any;
    if (!r) return null;
    return {
      id: r.id,
      organizationId: r.organization_id,
      contactId: r.contact_id,
      consentType: r.consent_type,
      policyVersion: r.policy_version,
      grantedAt: r.granted_at,
      revokedAt: r.revoked_at,
    };
  }

  /** Atalho booleano — pré-condição de upload/simulação. */
  static hasConsent(orgId: string, contactId: string, consentType: BeautyConsentScope): boolean {
    return this.activeConsent(orgId, contactId, consentType) !== null;
  }

  // ─────────────────────── CONSULTA (sessão) ─────────────────────────────

  /**
   * Cria consulta em `draft`. Contato precisa existir na mesma org
   * (RN-BS-07). `expiresInDays` default 30 (config futura em
   * organization_settings).
   */
  static startConsultation(
    orgId: string,
    input: { contactId: string; goal?: string | null; intensity?: string | null; expiresInDays?: number },
  ): BeautyConsultationRow {
    const contactId = String(input.contactId || "").trim();
    if (!contactId) throw new Error("Consulta exige um contato.");
    const contact = db.prepare("SELECT id FROM contacts WHERE id = ? AND organization_id = ?").get(contactId, orgId);
    if (!contact) throw new Error("Contato não encontrado nesta organização.");

    const days = Number.isFinite(input.expiresInDays) && (input.expiresInDays as number) > 0
      ? Math.min(365, Math.round(input.expiresInDays as number))
      : 30;

    const id = randomUUID();
    db.prepare(
      `INSERT INTO beauty_visual_consultations
         (id, organization_id, contact_id, status, goal, intensity, expires_at)
       VALUES (?, ?, ?, 'draft', ?, ?, datetime('now', '+' || ? || ' days'))`,
    ).run(id, orgId, contactId, input.goal || null, input.intensity || null, days);
    try { logAuthEvent(orgId, null, id, "BEAUTY_CONSULTATION_STARTED", { contactId, goal: input.goal || null, intensity: input.intensity || null }); } catch { /* noop */ }
    return this.getConsultation(orgId, id)!;
  }

  static getConsultation(orgId: string, consultationId: string): BeautyConsultationRow | null {
    const r = db.prepare(
      `SELECT id, organization_id, contact_id, status, goal, intensity,
              reference_photo_key, consent_id, selected_simulation_id,
              selected_at, scheduled_appointment_id, expires_at, created_at
         FROM beauty_visual_consultations
        WHERE id = ? AND organization_id = ?`,
    ).get(consultationId, orgId) as any;
    if (!r) return null;
    return {
      id: r.id,
      organizationId: r.organization_id,
      contactId: r.contact_id,
      status: r.status,
      goal: r.goal,
      intensity: r.intensity,
      referencePhotoKey: r.reference_photo_key,
      consentId: r.consent_id,
      selectedSimulationId: r.selected_simulation_id,
      selectedAt: r.selected_at,
      scheduledAppointmentId: r.scheduled_appointment_id,
      expiresAt: r.expires_at,
      createdAt: r.created_at,
    };
  }

  // ─────────────────────── UPLOAD (quarentena) ───────────────────────────

  static retentionDays(orgId: string): number {
    const r = db.prepare(
      `SELECT beauty_avatar_retention_days FROM organization_settings WHERE organization_id = ?`,
    ).get(orgId) as any;
    const v = Number(r?.beauty_avatar_retention_days);
    if (!Number.isFinite(v) || v < 1) return 30;
    return Math.min(365, Math.round(v));
  }

  /**
   * Grava foto em QUARENTENA + EXIF strip + storage privado. Pré-condições:
   *  (a) consulta existe na mesma org e status='draft';
   *  (b) consent ativo `hair_simulation` para o contato da consulta;
   *  (c) sharp lê a imagem (recusa formato inválido).
   * NÃO aprova sozinho — a aprovação (F5 manual, F6+ por IA) vira status
   * 'approved' e libera URL assinada.
   */
  static async uploadReferencePhoto(
    orgId: string,
    consultationId: string,
    buffer: Buffer,
  ): Promise<{ ok: true; assetId: string; status: "quarantined" } | { ok: false; error: string }> {
    const consultation = this.getConsultation(orgId, consultationId);
    if (!consultation) return { ok: false, error: "Consulta não encontrada." };
    if (consultation.status !== "draft") return { ok: false, error: `Consulta em status '${consultation.status}' — não aceita upload.` };
    if (!consultation.contactId) return { ok: false, error: "Consulta sem contato — não é possível associar foto." };

    const consent = this.activeConsent(orgId, consultation.contactId, "hair_simulation");
    if (!consent) return { ok: false, error: "Antes de enviar a foto, é preciso aceitar o termo de uso da imagem (hair_simulation)." };

    // Re-encode via sharp: corrige rotação EXIF, REMOVE EXIF (GPS/aparelho —
    // RN-BS-04), normaliza para JPEG. Limita dimensão (1600x1600 max).
    let processed: Buffer;
    try {
      processed = await sharp(buffer)
        .rotate()
        .resize(1600, 1600, { fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 88 })
        .toBuffer();
    } catch {
      return { ok: false, error: "Não foi possível ler a imagem. Envie uma foto em JPG, PNG ou WEBP." };
    }

    const storageKey = `beauty/${randomUUID()}.jpg`;
    // Diretório subdir "beauty/" evita colisão de nome com fashion_avatar_assets
    // ao compartilhar o mesmo PRIVATE_MEDIA_DIR.
    try {
      fs.mkdirSync(path.join(PRIVATE_MEDIA_DIR, "beauty"), { recursive: true });
      fs.writeFileSync(path.join(PRIVATE_MEDIA_DIR, safeStorageKey(storageKey)), processed);
    } catch (e) {
      console.error("[BeautyAvatar] falha ao gravar arquivo:", e);
      return { ok: false, error: "Falha interna ao salvar a imagem. Tente de novo." };
    }

    const retention = this.retentionDays(orgId);
    const assetId = randomUUID();
    db.prepare(
      `INSERT INTO beauty_avatar_assets
         (id, organization_id, contact_id, consultation_id, storage_key, status, consent_id, expires_at)
       VALUES (?, ?, ?, ?, ?, 'quarantined', ?, datetime('now', '+' || ? || ' days'))`,
    ).run(assetId, orgId, consultation.contactId, consultationId, storageKey, consent.id, retention);

    // Amarra a foto de referência à consulta (só o KEY, sem carregar buffer)
    db.prepare(
      `UPDATE beauty_visual_consultations
          SET reference_photo_key = ?, consent_id = ?
        WHERE id = ? AND organization_id = ?`,
    ).run(storageKey, consent.id, consultationId, orgId);

    try { logAuthEvent(orgId, null, assetId, "BEAUTY_AVATAR_UPLOADED", { consultationId, retentionDays: retention }); } catch { /* noop */ }
    return { ok: true, assetId, status: "quarantined" };
  }

  /**
   * Aprova asset em quarentena — em F5 é ação manual explícita (admin/rota
   * de moderação). Em F6+ o `BeautyHairSimulationProvider` chamará o
   * `validateGuidedPhoto` do llm.ts e aprovará automaticamente.
   *
   * `safetyReport` (opcional) armazena as flags booleanas da IA quando
   * disponíveis — NUNCA prompt/foto/base64 (RN-BS-05).
   */
  static approveAsset(orgId: string, assetId: string, safetyReport?: Record<string, boolean>): boolean {
    const r = db.prepare(
      `UPDATE beauty_avatar_assets SET status = 'approved', safety_report_json = ?
        WHERE id = ? AND organization_id = ? AND status = 'quarantined'`,
    ).run(safetyReport ? JSON.stringify(safetyReport) : null, assetId, orgId);
    if (r.changes > 0) {
      // Se a consulta é a fonte deste asset, avança pro estado 'ready'
      const asset = this.getAsset(orgId, assetId);
      if (asset?.consultationId) {
        db.prepare(
          `UPDATE beauty_visual_consultations SET status = 'ready'
            WHERE id = ? AND organization_id = ? AND status = 'draft'`,
        ).run(asset.consultationId, orgId);
      }
      try { logAuthEvent(orgId, null, assetId, "BEAUTY_AVATAR_APPROVED", {}); } catch { /* noop */ }
    }
    return r.changes > 0;
  }

  static rejectAsset(orgId: string, assetId: string, reason: string, safetyReport?: Record<string, boolean>): boolean {
    const r = db.prepare(
      `UPDATE beauty_avatar_assets SET status = 'rejected', safety_report_json = ?
        WHERE id = ? AND organization_id = ? AND status = 'quarantined'`,
    ).run(safetyReport ? JSON.stringify(safetyReport) : null, assetId, orgId);
    if (r.changes > 0) {
      try { logAuthEvent(orgId, null, assetId, "BEAUTY_AVATAR_REJECTED", { reason: String(reason || "").slice(0, 200) }); } catch { /* noop */ }
    }
    return r.changes > 0;
  }

  static getAsset(orgId: string, assetId: string): BeautyAvatarAssetRow | null {
    const r = db.prepare(
      `SELECT id, organization_id, contact_id, consultation_id, storage_key, status,
              safety_report_json, consent_id, expires_at, deleted_at, created_at
         FROM beauty_avatar_assets WHERE id = ? AND organization_id = ?`,
    ).get(assetId, orgId) as any;
    if (!r) return null;
    return this.rowToAsset(r);
  }

  /**
   * Lista assets ATIVOS (não deletados) de um contato. Purga preguiçosa:
   * assets com `expires_at` no passado viram 'deleted' + arquivo removido.
   * Retorna `signedUrl` só para status 'approved'.
   */
  static listAssetsForContact(orgId: string, contactId: string): BeautyAvatarAssetRow[] {
    const rows = db.prepare(
      `SELECT id, organization_id, contact_id, consultation_id, storage_key, status,
              safety_report_json, consent_id, expires_at, deleted_at, created_at
         FROM beauty_avatar_assets
        WHERE organization_id = ? AND contact_id = ? AND status != 'deleted'
        ORDER BY created_at DESC`,
    ).all(orgId, contactId) as any[];
    const out: BeautyAvatarAssetRow[] = [];
    for (const r of rows) {
      if (r.expires_at && new Date(r.expires_at).getTime() < Date.now()) {
        this.deleteAssetRow(r);
        continue;
      }
      const asset = this.rowToAsset(r);
      if (asset.status === "approved" && asset.storageKey) {
        asset.signedUrl = this.signedUrl(asset.storageKey);
      }
      out.push(asset);
    }
    return out;
  }

  private static rowToAsset(r: any): BeautyAvatarAssetRow {
    return {
      id: r.id,
      organizationId: r.organization_id,
      contactId: r.contact_id,
      consultationId: r.consultation_id,
      storageKey: r.storage_key,
      status: r.status,
      safetyReportJson: r.safety_report_json,
      consentId: r.consent_id,
      expiresAt: r.expires_at,
      deletedAt: r.deleted_at,
      createdAt: r.created_at,
      signedUrl: null,
    };
  }

  // ─────────────────────── URL ASSINADA (leitura) ────────────────────────

  /** URL assinada HMAC (fileSigning canônico) — TTL 15min por padrão. */
  static signedUrl(storageKey: string, ttlMs = DEFAULT_SIGNED_TTL_MS, now = Date.now()): string {
    const { exp, sig } = signKey(SIGNING_SCOPE, storageKey, ttlMs, now);
    return `${PUBLIC_MEDIA_ROUTE}/${encodeURIComponent(storageKey)}?exp=${exp}&sig=${sig}`;
  }

  /** Verifica assinatura+expiração e devolve o caminho do arquivo. null = nega. */
  static resolveSignedFile(storageKey: string, exp: string, sig: string, now = Date.now()): string | null {
    if (!verifyKey(SIGNING_SCOPE, storageKey, exp, sig, now)) return null;
    // safeStorageKey já validou o formato dentro de verifyKey; monta o caminho.
    let safe: string;
    try { safe = safeStorageKey(storageKey); } catch { return null; }
    const file = path.join(PRIVATE_MEDIA_DIR, safe);
    return fs.existsSync(file) ? file : null;
  }

  // ─────────────────────── EXCLUSÃO / RETENÇÃO ───────────────────────────

  private static deleteAssetRow(row: { id: string; storage_key?: string | null }): void {
    if (row.storage_key) {
      try {
        // safeStorageKey garante `{seg}/{seg}` — sem traversal
        const safe = safeStorageKey(row.storage_key);
        fs.rmSync(path.join(PRIVATE_MEDIA_DIR, safe), { force: true });
      } catch { /* noop — anti-traversal */ }
    }
    db.prepare(
      `UPDATE beauty_avatar_assets
          SET status = 'deleted', storage_key = NULL, deleted_at = CURRENT_TIMESTAMP
        WHERE id = ?`,
    ).run(row.id);
  }

  /** Apaga TODOS os assets de um contato (usado por `revokeConsent`). */
  static deleteAllForContact(orgId: string, contactId: string): number {
    const rows = db.prepare(
      `SELECT id, storage_key FROM beauty_avatar_assets
        WHERE organization_id = ? AND contact_id = ? AND status != 'deleted'`,
    ).all(orgId, contactId) as any[];
    for (const r of rows) this.deleteAssetRow(r);
    return rows.length;
  }

  /** Purga por retenção (Scheduler): apaga arquivos de assets vencidos. */
  static purgeExpired(): number {
    const rows = db.prepare(
      `SELECT id, storage_key FROM beauty_avatar_assets
        WHERE status != 'deleted' AND expires_at IS NOT NULL AND expires_at < datetime('now')`,
    ).all() as any[];
    for (const r of rows) this.deleteAssetRow(r);
    return rows.length;
  }
}
