/**
 * Módulo Clínica — ENVIO DE GUIA POR CANAL (ADR-145 Fatia 45).
 *
 * Fecha o loop da Fatia 44: recepção emite guia → clica "Enviar por
 * WhatsApp" → paciente recebe o PDF no celular. LGPD:
 *   - `dados_sensiveis` do paciente OBRIGATÓRIO (guia carrega
 *     diagnóstico/procedimento).
 *   - `comunicacoes` do paciente OBRIGATÓRIO (envio ativo por canal).
 *
 * PDF salvo em `PRIVATE_MEDIA_DIR/clinical_guides/{orgId}/{uuid}.pdf`
 * (subpasta por org — isolamento tenant Fase 18). Servido por rota
 * pública com HMAC + `exp` 15min (mesmo padrão Fase K/18/33/34).
 *
 * Cada tentativa vira row em `clinical_guide_deliveries` (histórico
 * completo, mesmo em falha — visão pra operador rastrear no BSP).
 * Sem retry automático (KISS); Scheduler futuro reprocessa `failed`
 * se surgir necessidade.
 */
import { randomUUID } from "node:crypto";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import db from "./db.js";
import { logAuthEvent, maskIdentifier } from "./auditLog.js";
import { LgpdService } from "./LgpdService.js";
import { MessageProviderService } from "./MessageProviderService.js";
import { ClinicGuideService } from "./ClinicGuideService.js";
import { JWT_SECRET } from "./config/secret.js";

const SENSITIVE_CONSENT = "dados_sensiveis";
const COMMS_CONSENT = "comunicacoes";
const SIGNED_URL_TTL_MS = 15 * 60 * 1000;
const APP_URL = (process.env.APP_URL || "").replace(/\/$/, "");

// Segredo próprio derivado — rotacionar JWT_SECRET invalida URLs antigas.
const MEDIA_SIGNING_SECRET = crypto.createHash("sha256")
  .update(`${JWT_SECRET}:clinical_guide_v1`).digest("hex");

export const CLINIC_GUIDES_DIR = path.join(
  process.env.DATA_DIR || process.cwd(),
  "private_media",
  "clinical_guides"
);
try { fs.mkdirSync(CLINIC_GUIDES_DIR, { recursive: true }); } catch { /* noop */ }

export type DeliveryStatus = "queued" | "sent" | "failed";

export interface GuideDelivery {
  id: string;
  organizationId: string;
  guideId: string;
  contactId: string;
  channelId: string | null;
  toIdentifier: string | null;
  status: DeliveryStatus;
  providerMessageId: string | null;
  error: string | null;
  sentBy: string | null;
  sentAt: string;
}

export type DocSender = (
  channelId: string,
  recipientIdentifier: string,
  fileUrl: string,
  fileName: string,
  caption?: string
) => Promise<any>;

function hydrate(r: any): GuideDelivery | null {
  if (!r) return null;
  return {
    id: r.id,
    organizationId: r.organization_id,
    guideId: r.guide_id,
    contactId: r.contact_id,
    channelId: r.channel_id ?? null,
    toIdentifier: r.to_identifier ?? null,
    status: r.status,
    providerMessageId: r.provider_message_id ?? null,
    error: r.error ?? null,
    sentBy: r.sent_by ?? null,
    sentAt: r.sent_at,
  };
}

// key = "{orgId}/{uuid}.pdf" — mesmo padrão isolamento por tenant Fase 18
function safeStorageKey(storageKey: string): string {
  const s = String(storageKey || "");
  const parts = s.split("/");
  if (parts.length !== 2) throw new Error("Chave de arquivo inválida.");
  const [orgSeg, fileSeg] = parts;
  if (!/^[a-zA-Z0-9._-]+$/.test(orgSeg) || !/^[a-zA-Z0-9._-]+$/.test(fileSeg)) {
    throw new Error("Chave de arquivo inválida.");
  }
  if (path.basename(orgSeg) !== orgSeg || path.basename(fileSeg) !== fileSeg) {
    throw new Error("Chave de arquivo inválida.");
  }
  return `${orgSeg}/${fileSeg}`;
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

function insertDelivery(row: {
  orgId: string; guideId: string; contactId: string;
  channelId: string | null; toIdentifier: string | null;
  status: DeliveryStatus; error?: string | null; sentBy?: string | null;
}): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO clinical_guide_deliveries
       (id, organization_id, guide_id, contact_id, channel_id, to_identifier, status, error, sent_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, row.orgId, row.guideId, row.contactId, row.channelId, row.toIdentifier,
        row.status, row.error ?? null, row.sentBy ?? null);
  return id;
}

export class ClinicGuideDeliveryService {
  static signedUrl(storageKey: string, ttlMs = SIGNED_URL_TTL_MS, now = Date.now()): string {
    const key = safeStorageKey(storageKey);
    const exp = now + ttlMs;
    const sig = crypto.createHmac("sha256", MEDIA_SIGNING_SECRET).update(`${key}:${exp}`).digest("hex");
    const [orgSeg, fileSeg] = key.split("/");
    const rel = `/api/public/clinic/guides/${encodeURIComponent(orgSeg)}/${encodeURIComponent(fileSeg)}?exp=${exp}&sig=${sig}`;
    return APP_URL ? `${APP_URL}${rel}` : rel;
  }

  static resolveSignedFile(storageKey: string, exp: string, sig: string, now = Date.now()): string | null {
    let key: string;
    try { key = safeStorageKey(storageKey); } catch { return null; }
    const expMs = Number(exp);
    if (!Number.isFinite(expMs) || expMs < now) return null;
    const expected = crypto.createHmac("sha256", MEDIA_SIGNING_SECRET).update(`${key}:${expMs}`).digest("hex");
    const a = Buffer.from(String(sig || ""), "utf-8");
    const b = Buffer.from(expected, "utf-8");
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const file = path.join(CLINIC_GUIDES_DIR, key);
    return fs.existsSync(file) ? file : null;
  }

  static list(orgId: string, guideId: string): GuideDelivery[] {
    const rows = db.prepare(
      `SELECT * FROM clinical_guide_deliveries
        WHERE organization_id = ? AND guide_id = ?
        ORDER BY sent_at DESC, rowid DESC`
    ).all(orgId, guideId) as any[];
    return rows.map((r) => hydrate(r)!).filter(Boolean);
  }

  /**
   * Salva o PDF em disco privado e devolve `storageKey` + `filePath`.
   * Se a guia já tem pdf_storage_key, REUSA (segunda via = mesmo arquivo).
   * Chamado pelo `sendGuide` e pela rota GET /guides/:id/pdf.
   */
  static async materializePdf(orgId: string, guideId: string): Promise<{ storageKey: string; filePath: string; bytes: Buffer }> {
    const guide = ClinicGuideService.get(orgId, guideId);
    if (!guide) throw new Error("Guia não encontrada.");
    if (guide.status === "draft") {
      const e: any = new Error("Guia em rascunho — emita antes de gerar PDF.");
      e.code = "GUIDE_NOT_ISSUED"; throw e;
    }
    if (guide.status === "cancelled") {
      const e: any = new Error("Guia cancelada — PDF indisponível.");
      e.code = "GUIDE_CANCELLED"; throw e;
    }

    // Se já tem PDF gravado, reusa (evita re-render — snapshot é imutável)
    if (guide.pdfStorageKey) {
      const filePath = path.join(CLINIC_GUIDES_DIR, guide.pdfStorageKey);
      if (fs.existsSync(filePath)) {
        return { storageKey: guide.pdfStorageKey, filePath, bytes: fs.readFileSync(filePath) };
      }
      // Arquivo sumiu do disco (retention/purge?) — regenera do snapshot.
    }

    const bytes = await ClinicGuideService.renderPdf(orgId, guideId);
    const orgDir = path.join(CLINIC_GUIDES_DIR, orgId);
    try { fs.mkdirSync(orgDir, { recursive: true }); } catch { /* noop */ }
    const basename = `${randomUUID()}.pdf`;
    const storageKey = safeStorageKey(`${orgId}/${basename}`);
    const filePath = path.join(CLINIC_GUIDES_DIR, storageKey);
    fs.writeFileSync(filePath, bytes);
    db.prepare(`UPDATE clinical_guides SET pdf_storage_key = ? WHERE id = ? AND organization_id = ?`)
      .run(storageKey, guideId, orgId);
    return { storageKey, filePath, bytes };
  }

  /**
   * Envia a guia por canal. Sempre grava row em clinical_guide_deliveries
   * (mesmo em falha) pra UI e auditoria rastrearem. Reusa mesmo padrão do
   * ClinicDocumentDeliveryService (Fase K).
   *
   * Guards:
   *   - status precisa ser issued (nem draft, nem cancelled, nem denied).
   *   - LGPD dados_sensiveis + comunicacoes do paciente.
   *   - Contact tem identifier + canal ativo disponível.
   */
  static async send(
    orgId: string,
    guideId: string,
    actorId: string | null = null,
    opts: { sender?: DocSender; caption?: string } = {}
  ): Promise<GuideDelivery> {
    const guide = ClinicGuideService.get(orgId, guideId);
    if (!guide) throw new Error("Guia não encontrada.");
    if (guide.status !== "issued" && guide.status !== "submitted" &&
        guide.status !== "approved") {
      const e: any = new Error(`Guia com status ${guide.status} não pode ser enviada.`);
      e.code = "GUIDE_NOT_SENDABLE"; throw e;
    }

    // LGPD (Art.11 sensível + Art.7 comunicações)
    if (!LgpdService.hasConsent(orgId, guide.contactId, SENSITIVE_CONSENT)) {
      const e: any = new Error("Consentimento LGPD para dados sensíveis é obrigatório.");
      e.code = "LGPD_CONSENT_REQUIRED"; throw e;
    }
    if (!LgpdService.hasConsent(orgId, guide.contactId, COMMS_CONSENT)) {
      const e: any = new Error("Consentimento para comunicações é obrigatório para envio por canal.");
      e.code = "LGPD_COMMS_CONSENT_REQUIRED"; throw e;
    }

    // Contact + canal
    const contact = db.prepare(
      `SELECT id, name, identifier, channel_id FROM contacts WHERE organization_id = ? AND id = ?`
    ).get(orgId, guide.contactId) as any;
    if (!contact) throw new Error("Paciente não encontrado.");
    if (!contact.identifier) {
      throw new Error("Paciente sem identificador (telefone/WhatsApp) para enviar.");
    }
    const channelId = resolveChannel(orgId, contact.channel_id);
    if (!channelId) {
      throw new Error("Nenhum canal WhatsApp ativo para enviar. Conecte um canal e tente novamente.");
    }

    // Materializa PDF (reusa se já existe) + gera URL assinada
    const { storageKey } = await this.materializePdf(orgId, guideId);
    const fileUrl = this.signedUrl(storageKey);
    const titleByType: Record<string, string> = {
      tiss_authorization: "guia",
      referral: "encaminhamento",
      medical_order: "pedido médico",
    };
    const label = titleByType[guide.guideType] || "guia";
    const filename = `${label}-${guide.internalNumber}.pdf`;
    const defaultCaption = `Sua ${label} — ${contact.name || "paciente"}. Guarde este arquivo (Nº ${guide.internalNumber}).`;
    const caption = opts.caption || defaultCaption;

    // Row queued → sender → sent|failed
    const id = insertDelivery({
      orgId, guideId, contactId: guide.contactId,
      channelId, toIdentifier: contact.identifier, status: "queued",
      sentBy: actorId,
    });

    const sender: DocSender = opts.sender || MessageProviderService.sendDocument.bind(MessageProviderService);
    try {
      const result = await sender(channelId, contact.identifier, fileUrl, filename, caption);
      const providerMessageId = typeof result === "string" ? result
        : (result?.messages?.[0]?.id || result?.key?.id || result?.id || null);
      db.prepare(
        `UPDATE clinical_guide_deliveries SET status='sent', provider_message_id=? WHERE id=? AND organization_id=?`
      ).run(providerMessageId, id, orgId);
      logAuthEvent(orgId, actorId, guide.contactId, "CLINIC_GUIDE_SENT", {
        deliveryId: id, guideId, guideType: guide.guideType,
        internalNumber: guide.internalNumber, channelId,
        toIdentifier: maskIdentifier(contact.identifier),
      });
    } catch (e: any) {
      const err = String(e?.message || e).slice(0, 500);
      db.prepare(
        `UPDATE clinical_guide_deliveries SET status='failed', error=? WHERE id=? AND organization_id=?`
      ).run(err, id, orgId);
      logAuthEvent(orgId, actorId, guide.contactId, "CLINIC_GUIDE_SEND_FAILED", {
        deliveryId: id, guideId, guideType: guide.guideType,
        internalNumber: guide.internalNumber,
        error: err.slice(0, 200),
      });
    }

    return hydrate(db.prepare(`SELECT * FROM clinical_guide_deliveries WHERE id = ?`).get(id))!;
  }
}

export default ClinicGuideDeliveryService;
