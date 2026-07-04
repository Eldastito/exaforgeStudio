import fs from "fs";
import path from "path";
import crypto from "crypto";
import sharp from "sharp";
import { v4 as uuidv4 } from "uuid";
import db from "./db.js";
import { JWT_SECRET } from "./config/secret.js";
import { validateGuidedPhoto, isAIConfigured } from "./llm.js";
import { FashionStudioService } from "./FashionStudioService.js";

/**
 * Avatar do Provador Virtual (FAS-1, ADR-035) — o dado mais sensível que o
 * produto guarda (foto de corpo inteiro de pessoa real), com regras próprias:
 *
 *  - STORAGE PRIVADO: os arquivos vivem em DATA_DIR/private_media, um
 *    diretório que NÃO é servido pelo express.static (o /media público segue
 *    intocado para foto de produto, decisão da ADR-034). O único caminho de
 *    leitura é a URL ASSINADA (HMAC + expiração) emitida para a própria dona.
 *  - CONSENTIMENTO ANTES DO UPLOAD (RF-002/003): sem um consentimento
 *    avatar_processing ativo e versionado, o upload nem grava o arquivo.
 *  - QUARENTENA (RF-008): todo upload nasce 'quarantined'; só vira 'approved'
 *    depois da validação da foto guiada (critérios 6.2, recusas legíveis 6.3
 *    mapeadas por código determinístico — a IA só devolve flags booleanas).
 *  - EXIF removido no re-encode via sharp (RF-010) — mesma técnica do
 *    smart-scan (ADR-020).
 *  - RETENÇÃO (19.4): expires_at = agora + fashion_avatar_retention_days
 *    (padrão 30); expiração preguiçosa no acesso + purga no Scheduler.
 */

const PRIVATE_MEDIA_DIR = path.join(process.env.DATA_DIR || process.cwd(), "private_media");
try { fs.mkdirSync(PRIVATE_MEDIA_DIR, { recursive: true }); } catch (e) { /* noop */ }

// Segredo próprio para assinar URLs de mídia privada (derivado, como o JWT do
// cliente do provador — nunca o JWT_SECRET cru).
const MEDIA_SIGNING_SECRET = crypto.createHash("sha256").update(`${JWT_SECRET}:fashion_private_media_v1`).digest("hex");
const SIGNED_URL_TTL_MS = 15 * 60 * 1000; // 15 minutos — o front pede outra quando precisar

export interface PhotoReport {
  singlePerson?: boolean; adultApparent?: boolean; fullBody?: boolean; frontal?: boolean;
  goodLighting?: boolean; armsVisible?: boolean; safeContent?: boolean; noDocuments?: boolean;
}

export class FashionAvatarService {
  // ---- consentimento (RF-002/003/004) ----

  static grantConsent(orgId: string, customerId: string, consentType: string, policyVersion: string): string {
    // Revoga qualquer consentimento anterior do mesmo tipo antes de conceder o
    // novo — o histórico fica preservado (linhas revogadas), nunca sobrescrito.
    db.prepare(`UPDATE fashion_consents SET revoked_at = CURRENT_TIMESTAMP WHERE organization_id = ? AND customer_id = ? AND consent_type = ? AND revoked_at IS NULL`)
      .run(orgId, customerId, consentType);
    const id = uuidv4();
    db.prepare(`INSERT INTO fashion_consents (id, organization_id, customer_id, consent_type, policy_version) VALUES (?, ?, ?, ?, ?)`)
      .run(id, orgId, customerId, consentType, String(policyVersion || "v1").slice(0, 40));
    FashionStudioService.recordEvent(orgId, "FashionConsentGranted", { consentType, policyVersion }, customerId);
    return id;
  }

  static revokeConsent(orgId: string, customerId: string, consentType: string): void {
    db.prepare(`UPDATE fashion_consents SET revoked_at = CURRENT_TIMESTAMP WHERE organization_id = ? AND customer_id = ? AND consent_type = ? AND revoked_at IS NULL`)
      .run(orgId, customerId, consentType);
    FashionStudioService.recordEvent(orgId, "FashionConsentRevoked", { consentType }, customerId);
    // Revogar o consentimento de avatar apaga os avatares na hora (RF-004).
    if (consentType === "avatar_processing") this.deleteAllAvatars(orgId, customerId);
  }

  static activeConsent(orgId: string, customerId: string, consentType: string): { id: string; policy_version: string } | null {
    return db.prepare(
      `SELECT id, policy_version FROM fashion_consents WHERE organization_id = ? AND customer_id = ? AND consent_type = ? AND revoked_at IS NULL ORDER BY granted_at DESC LIMIT 1`
    ).get(orgId, customerId, consentType) as any || null;
  }

  // ---- upload + validação ----

  static retentionDays(orgId: string): number {
    const row = db.prepare(`SELECT fashion_avatar_retention_days FROM storefront_settings WHERE organization_id = ?`).get(orgId) as any;
    const v = Number(row?.fashion_avatar_retention_days);
    if (!Number.isFinite(v) || v < 1) return 30;
    return Math.min(365, Math.round(v));
  }

  /**
   * Grava o upload em quarentena e roda a validação da foto guiada.
   * Pré-condições checadas AQUI (não só na rota): consentimento ativo e IA
   * configurada — sem visão de IA não há como validar os critérios 6.2, e um
   * avatar sem validação nunca pode ser aprovado.
   */
  static async submitAvatar(orgId: string, customerId: string, buffer: Buffer): Promise<{ ok: true; avatarId: string; status: string; reasons: string[] } | { ok: false; error: string }> {
    const consent = this.activeConsent(orgId, customerId, "avatar_processing");
    if (!consent) return { ok: false, error: "Antes de enviar sua foto, você precisa aceitar o termo de uso da imagem." };
    if (!isAIConfigured()) return { ok: false, error: "O provador está temporariamente indisponível. Tente de novo mais tarde." };

    // Re-encode via sharp: corrige rotação EXIF, REMOVE o EXIF (localização,
    // aparelho — RF-010) e normaliza para JPEG.
    let processed: Buffer;
    try {
      processed = await sharp(buffer).rotate().resize(1600, 1600, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 88 }).toBuffer();
    } catch {
      return { ok: false, error: "Não foi possível ler esta imagem. Envie uma foto em JPG, PNG ou WEBP." };
    }

    // Um avatar ativo por cliente: o novo substitui o anterior (apaga arquivo).
    this.deleteAllAvatars(orgId, customerId, true);

    const storageKey = `${uuidv4()}.jpg`;
    fs.writeFileSync(path.join(PRIVATE_MEDIA_DIR, storageKey), processed);

    const retention = this.retentionDays(orgId);
    const avatarId = uuidv4();
    db.prepare(
      `INSERT INTO fashion_avatar_assets (id, organization_id, customer_id, storage_key, status, consent_id, expires_at)
       VALUES (?, ?, ?, ?, 'quarantined', ?, datetime('now', '+' || ? || ' days'))`
    ).run(avatarId, orgId, customerId, storageKey, consent.id, retention);
    FashionStudioService.recordEvent(orgId, "FashionAvatarUploaded", { retentionDays: retention }, customerId);

    // Validação da foto guiada (6.2). Falha de IA = rascunho fica em
    // quarentena com erro amigável — nunca aprova sem validar.
    let report: PhotoReport = {};
    try {
      const raw = await validateGuidedPhoto(processed.toString("base64"), "image/jpeg");
      report = JSON.parse(raw || "{}");
    } catch (e) {
      console.error("[FashionAvatar] Validação de foto falhou:", e);
      return { ok: true, avatarId, status: "quarantined", reasons: ["Não foi possível validar a imagem com segurança. Tente outra foto."] };
    }

    const verdict = this.evaluatePhotoReport(report);
    db.prepare(`UPDATE fashion_avatar_assets SET status = ?, safety_report_json = ? WHERE id = ?`)
      .run(verdict.approved ? "approved" : "rejected", JSON.stringify(report), avatarId);
    FashionStudioService.recordEvent(orgId, verdict.approved ? "FashionAvatarApproved" : "FashionAvatarRejected", { reasons: verdict.reasons }, customerId);
    return { ok: true, avatarId, status: verdict.approved ? "approved" : "rejected", reasons: verdict.reasons };
  }

  /**
   * Mapeia as flags booleanas da IA para as recusas LEGÍVEIS da seção 6.3 —
   * determinístico e testável sem IA. A mensagem nunca sugere defeito físico
   * (regra do PRD): todo texto vem deste catálogo fixo, nunca da IA.
   */
  static evaluatePhotoReport(report: PhotoReport): { approved: boolean; reasons: string[] } {
    const reasons: string[] = [];
    if (report.singlePerson === false) reasons.push("Encontramos mais de uma pessoa na foto. Envie apenas sua foto.");
    if (report.adultApparent === false) reasons.push("Não foi possível validar a imagem com segurança. Tente outra foto.");
    if (report.fullBody === false) reasons.push("Não conseguimos ver seu corpo inteiro. Tente uma foto mostrando cabeça e pés.");
    if (report.frontal === false) reasons.push("A pose lateral dificulta a prévia. Fique de frente para a câmera.");
    if (report.goodLighting === false) reasons.push("A imagem está escura ou desfocada. Procure um local mais iluminado.");
    if (report.armsVisible === false) reasons.push("Deixe os braços levemente afastados do corpo para a prévia ficar melhor.");
    if (report.safeContent === false) reasons.push("Não foi possível validar a imagem com segurança. Tente outra foto.");
    if (report.noDocuments === false) reasons.push("Evite documentos ou dados visíveis na foto. Tente novamente.");
    // Campos ausentes (IA não respondeu a flag) contam como reprovação segura.
    for (const k of ["singlePerson", "adultApparent", "fullBody", "safeContent"] as (keyof PhotoReport)[]) {
      if (report[k] === undefined && !reasons.length) reasons.push("Não foi possível validar a imagem com segurança. Tente outra foto.");
    }
    return { approved: reasons.length === 0, reasons };
  }

  // ---- leitura (URL assinada) ----

  static listAvatars(orgId: string, customerId: string): { id: string; status: string; url: string | null; expiresAt: string | null }[] {
    const rows = db.prepare(
      `SELECT id, storage_key, status, expires_at FROM fashion_avatar_assets
       WHERE organization_id = ? AND customer_id = ? AND status != 'deleted' ORDER BY created_at DESC`
    ).all(orgId, customerId) as any[];
    const out: any[] = [];
    for (const r of rows) {
      // Expiração preguiçosa: passou da retenção = apaga arquivo e marca.
      if (r.expires_at && new Date(r.expires_at).getTime() < Date.now()) {
        this.deleteAvatarRow(r);
        continue;
      }
      out.push({
        id: r.id, status: r.status, expiresAt: r.expires_at || null,
        url: r.status === "approved" && r.storage_key ? this.signedUrl(r.storage_key) : null,
      });
    }
    return out;
  }

  /** URL assinada e com expiração para uma chave privada (só emitida à dona pela rota autenticada). */
  static signedUrl(storageKey: string, ttlMs = SIGNED_URL_TTL_MS, now = Date.now()): string {
    const exp = now + ttlMs;
    const sig = crypto.createHmac("sha256", MEDIA_SIGNING_SECRET).update(`${storageKey}:${exp}`).digest("hex");
    return `/api/public/fashion/media/${encodeURIComponent(storageKey)}?exp=${exp}&sig=${sig}`;
  }

  /** Verifica assinatura+expiração e devolve o caminho do arquivo. null = nega. */
  static resolveSignedFile(storageKey: string, exp: string, sig: string, now = Date.now()): string | null {
    const expMs = Number(exp);
    if (!Number.isFinite(expMs) || expMs < now) return null;
    const expected = crypto.createHmac("sha256", MEDIA_SIGNING_SECRET).update(`${storageKey}:${expMs}`).digest("hex");
    const a = Buffer.from(String(sig || ""), "utf-8");
    const b = Buffer.from(expected, "utf-8");
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    // Chave nunca sai do diretório privado (anti path traversal).
    const file = path.join(PRIVATE_MEDIA_DIR, path.basename(storageKey));
    return fs.existsSync(file) ? file : null;
  }

  // ---- exclusão e retenção ----

  private static deleteAvatarRow(row: { id: string; storage_key?: string | null }): void {
    try { if (row.storage_key) fs.rmSync(path.join(PRIVATE_MEDIA_DIR, path.basename(row.storage_key)), { force: true }); } catch { /* noop */ }
    db.prepare(`UPDATE fashion_avatar_assets SET status = 'deleted', storage_key = NULL, deleted_at = CURRENT_TIMESTAMP WHERE id = ?`).run(row.id);
  }

  static deleteAvatar(orgId: string, customerId: string, avatarId: string): boolean {
    const row = db.prepare(`SELECT id, storage_key FROM fashion_avatar_assets WHERE id = ? AND organization_id = ? AND customer_id = ? AND status != 'deleted'`)
      .get(avatarId, orgId, customerId) as any;
    if (!row) return false;
    this.deleteAvatarRow(row);
    FashionStudioService.recordEvent(orgId, "FashionDataDeleted", { scope: "avatar" }, customerId);
    return true;
  }

  static deleteAllAvatars(orgId: string, customerId: string, silent = false): void {
    const rows = db.prepare(`SELECT id, storage_key FROM fashion_avatar_assets WHERE organization_id = ? AND customer_id = ? AND status != 'deleted'`).all(orgId, customerId) as any[];
    for (const r of rows) this.deleteAvatarRow(r);
    if (rows.length && !silent) FashionStudioService.recordEvent(orgId, "FashionDataDeleted", { scope: "all_avatars", count: rows.length }, customerId);
  }

  /** Direito de exclusão (RF-004/11.4): apaga avatares, preferências, perfil, consentimentos e a conta. */
  static deleteAllCustomerData(orgId: string, customerId: string): void {
    this.deleteAllAvatars(orgId, customerId, true);
    const profile = db.prepare(`SELECT id FROM fashion_customer_profiles WHERE organization_id = ? AND customer_id = ?`).get(orgId, customerId) as any;
    if (profile) {
      db.prepare(`DELETE FROM fashion_preferences WHERE organization_id = ? AND profile_id = ?`).run(orgId, profile.id);
      db.prepare(`DELETE FROM fashion_customer_profiles WHERE id = ?`).run(profile.id);
    }
    db.prepare(`UPDATE fashion_consents SET revoked_at = CURRENT_TIMESTAMP WHERE organization_id = ? AND customer_id = ? AND revoked_at IS NULL`).run(orgId, customerId);
    db.prepare(`UPDATE storefront_customers SET deleted_at = CURRENT_TIMESTAMP, name = 'Excluído', email = 'excluido-' || id, phone = NULL, password_hash = 'deleted' WHERE id = ? AND organization_id = ?`).run(customerId, orgId);
    FashionStudioService.recordEvent(orgId, "FashionDataDeleted", { scope: "all" }, customerId);
  }

  /** Purga por retenção (Scheduler): apaga arquivos de avatares vencidos. */
  static purgeExpired(): number {
    const rows = db.prepare(`SELECT id, storage_key FROM fashion_avatar_assets WHERE status != 'deleted' AND expires_at IS NOT NULL AND expires_at < datetime('now')`).all() as any[];
    for (const r of rows) this.deleteAvatarRow(r);
    return rows.length;
  }
}
