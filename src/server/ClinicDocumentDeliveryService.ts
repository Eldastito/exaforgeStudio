/**
 * Módulo Clínica — ENVIO de receita/atestado por canal (ADR-080 Fase K).
 *
 * Fecha o loop pra o paciente: profissional emite → clica "Enviar por
 * WhatsApp" → paciente recebe o PDF no celular. Antes disso, o único
 * canal era imprimir e entregar em mãos.
 *
 * Restrições de produto:
 *   - Doc precisa estar `issued` (rascunho não vai por canal).
 *   - LGPD Art.11: exige `dados_sensiveis` (padrão do módulo) E
 *     `comunicacoes` (necessário pra usar canal de mensagem). O primeiro
 *     controla criar/ver o doc; o segundo controla mandá-lo por canal.
 *   - Canal precisa estar conectado; sem canal utilizável, erro síncrono.
 *   - PDF é sensível — NÃO vai pra `/media` estático. Salva em
 *     `PRIVATE_MEDIA_DIR/clinical_docs/` e serve por URL assinada (HMAC
 *     + `exp` curto) que o próprio provider baixa. Padrão idêntico ao
 *     `FashionAvatarService.signedUrl` (ADR-XXX).
 *
 * Cada tentativa vira row em `clinical_document_deliveries` — histórico
 * completo (paciente pediu 2ª via = 2 rows), com status/provider_message_id
 * pro operador rastrear no BSP.
 *
 * Envio é síncrono nesta fatia (KISS). Retry via `MessageDeliveryService`
 * fica pra fatia futura se surgir problema operacional.
 */
import { randomUUID } from "node:crypto";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import db from "./db.js";
import { logAuthEvent } from "./auditLog.js";
import { LgpdService } from "./LgpdService.js";
import { ClinicDocumentsService } from "./ClinicDocumentsService.js";
import { MessageProviderService } from "./MessageProviderService.js";

export type DocKind = "prescription" | "certificate";

const APP_URL = (process.env.APP_URL || "").replace(/\/$/, "");
const JWT_SECRET = process.env.JWT_SECRET || "";
// Segredo derivado só pra assinar essas URLs — se JWT_SECRET rotacionar,
// URLs assinadas antigas param de funcionar (comportamento desejado).
const MEDIA_SIGNING_SECRET = crypto.createHash("sha256")
  .update(`${JWT_SECRET}:clinical_document_v1`).digest("hex");
const SIGNED_URL_TTL_MS = 15 * 60 * 1000; // 15 min — provider baixa em segundos

export const CLINIC_DOCS_DIR = path.join(
  process.env.DATA_DIR || process.cwd(),
  "private_media",
  "clinical_docs"
);
try { fs.mkdirSync(CLINIC_DOCS_DIR, { recursive: true }); } catch { /* noop */ }

const SENSITIVE_CONSENT = "dados_sensiveis";
const COMMS_CONSENT = "comunicacoes";

export interface Delivery {
  id: string;
  organizationId: string;
  docKind: DocKind;
  docId: string;
  contactId: string;
  channelId: string;
  toIdentifier: string;
  status: "queued" | "sent" | "failed";
  providerMessageId: string | null;
  error: string | null;
  sentBy: string | null;
  sentAt: string;
}

/** Contrato mínimo pra teste injetar mock — mesmo shape do MessageProviderService.sendDocument. */
export type DocSender = (
  channelId: string,
  recipientIdentifier: string,
  fileUrl: string,
  fileName: string,
  caption?: string
) => Promise<any>;

function hydrate(r: any): Delivery | null {
  if (!r) return null;
  return {
    id: r.id,
    organizationId: r.organization_id,
    docKind: r.doc_kind,
    docId: r.doc_id,
    contactId: r.contact_id,
    channelId: r.channel_id,
    toIdentifier: r.to_identifier,
    status: r.status,
    providerMessageId: r.provider_message_id ?? null,
    error: r.error ?? null,
    sentBy: r.sent_by ?? null,
    sentAt: r.sent_at,
  };
}

function safeStorageKey(storageKey: string): string {
  const base = path.basename(storageKey);
  if (base !== storageKey || !/^[a-zA-Z0-9._-]+$/.test(base)) {
    throw new Error("Chave de arquivo inválida.");
  }
  return base;
}

export class ClinicDocumentDeliveryService {
  /** URL assinada temporária pro provider baixar o PDF sem auth de sessão. */
  static signedUrl(storageKey: string, ttlMs = SIGNED_URL_TTL_MS, now = Date.now()): string {
    const key = safeStorageKey(storageKey);
    const exp = now + ttlMs;
    const sig = crypto.createHmac("sha256", MEDIA_SIGNING_SECRET).update(`${key}:${exp}`).digest("hex");
    const rel = `/api/public/clinic/documents/${encodeURIComponent(key)}?exp=${exp}&sig=${sig}`;
    return APP_URL ? `${APP_URL}${rel}` : rel;
  }

  /** Verifica HMAC + expiração; devolve caminho absoluto no disco ou null. */
  static resolveSignedFile(storageKey: string, exp: string, sig: string, now = Date.now()): string | null {
    let key: string;
    try { key = safeStorageKey(storageKey); } catch { return null; }
    const expMs = Number(exp);
    if (!Number.isFinite(expMs) || expMs < now) return null;
    const expected = crypto.createHmac("sha256", MEDIA_SIGNING_SECRET).update(`${key}:${expMs}`).digest("hex");
    const a = Buffer.from(String(sig || ""), "utf-8");
    const b = Buffer.from(expected, "utf-8");
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const file = path.join(CLINIC_DOCS_DIR, key);
    return fs.existsSync(file) ? file : null;
  }

  static list(orgId: string, kind: DocKind, docId: string): Delivery[] {
    const rows = db.prepare(
      `SELECT * FROM clinical_document_deliveries
        WHERE organization_id = ? AND doc_kind = ? AND doc_id = ?
        ORDER BY sent_at DESC, rowid DESC`
    ).all(orgId, kind, docId) as any[];
    return rows.map((r) => hydrate(r)!).filter(Boolean);
  }

  /**
   * Envia o doc via canal. Síncrono, best-effort. Sempre cria row em
   * `clinical_document_deliveries` (mesmo em falha) pra a UI e a auditoria
   * verem a tentativa. `sender` injetável facilita teste sem chamar rede real.
   */
  static async send(
    orgId: string,
    kind: DocKind,
    docId: string,
    actorId: string | null,
    opts?: { caption?: string; sender?: DocSender }
  ): Promise<Delivery> {
    // 1) Doc issued e do próprio org
    const doc: any = kind === "prescription"
      ? ClinicDocumentsService.getPrescription(orgId, docId)
      : ClinicDocumentsService.getCertificate(orgId, docId);
    if (!doc) throw new Error(kind === "prescription" ? "Receita não encontrada." : "Atestado não encontrado.");
    if (doc.status !== "issued") {
      const e: any = new Error("Documento em rascunho — emita antes de enviar.");
      e.code = "DOCUMENT_NOT_ISSUED"; throw e;
    }

    // 2) LGPD: sensível + comunicações (dois consentimentos distintos).
    if (!LgpdService.hasConsent(orgId, doc.contactId, SENSITIVE_CONSENT)) {
      const e: any = new Error("Consentimento LGPD para dados sensíveis (saúde) é obrigatório.");
      e.code = "LGPD_CONSENT_REQUIRED"; throw e;
    }
    if (!LgpdService.hasConsent(orgId, doc.contactId, COMMS_CONSENT)) {
      const e: any = new Error("Consentimento para comunicações é obrigatório para envio por canal.");
      e.code = "LGPD_COMMS_CONSENT_REQUIRED"; throw e;
    }

    // 3) Resolver canal + destino: prioriza o canal do próprio contato;
    // fallback pro primeiro canal conectado da org (padrão do repo).
    const contact = db.prepare(`SELECT id, name, identifier, channel_id FROM contacts WHERE organization_id = ? AND id = ?`)
      .get(orgId, doc.contactId) as any;
    if (!contact) throw new Error("Paciente não encontrado.");
    if (!contact.identifier) throw new Error("Paciente sem identificador (telefone/WhatsApp) para enviar.");

    let channelId: string = contact.channel_id;
    if (channelId) {
      const c = db.prepare(`SELECT id, status FROM channels WHERE id = ? AND organization_id = ?`).get(channelId, orgId) as any;
      if (!c || c.status === "disabled" || c.status === "disconnected") channelId = "";
    }
    if (!channelId) {
      const fallback = db.prepare(
        `SELECT id FROM channels WHERE organization_id = ?
           AND status NOT IN ('disabled','disconnected')
         ORDER BY (provider LIKE 'evolution%') DESC, created_at ASC LIMIT 1`
      ).get(orgId) as any;
      if (!fallback) throw new Error("Nenhum canal WhatsApp ativo para enviar. Conecte um canal e tente novamente.");
      channelId = fallback.id;
    }

    // 4) Renderiza PDF em bytes → salva em disco privado.
    const pdfBuffer: Buffer = kind === "prescription"
      ? await ClinicDocumentsService.renderPrescriptionPdf(orgId, docId)
      : await ClinicDocumentsService.renderCertificatePdf(orgId, docId);
    const storageKey = `${randomUUID()}.pdf`;
    const filePath = path.join(CLINIC_DOCS_DIR, storageKey);
    fs.writeFileSync(filePath, pdfBuffer);

    // 5) Row 'queued' — se o send falhar, atualiza pra 'failed' com error.
    const id = randomUUID();
    db.prepare(
      `INSERT INTO clinical_document_deliveries
         (id, organization_id, doc_kind, doc_id, contact_id, channel_id, to_identifier, status, sent_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?)`
    ).run(id, orgId, kind, docId, doc.contactId, channelId, contact.identifier, actorId);

    const filename = kind === "prescription" ? `receita-${docId.slice(0, 8)}.pdf` : `atestado-${docId.slice(0, 8)}.pdf`;
    const fileUrl = this.signedUrl(storageKey);
    const caption = opts?.caption || (kind === "prescription"
      ? `Sua receita — ${contact.name || "paciente"}. Guarde este arquivo.`
      : `Seu atestado — ${contact.name || "paciente"}. Guarde este arquivo.`);

    const sender: DocSender = opts?.sender || MessageProviderService.sendDocument.bind(MessageProviderService);
    try {
      const result = await sender(channelId, contact.identifier, fileUrl, filename, caption);
      const providerMessageId = result?.messages?.[0]?.id || result?.key?.id || result?.id || null;
      db.prepare(`UPDATE clinical_document_deliveries SET status = 'sent', provider_message_id = ? WHERE id = ? AND organization_id = ?`)
        .run(providerMessageId, id, orgId);
      logAuthEvent(orgId, actorId, doc.contactId, "CLINIC_DOCUMENT_SENT", { deliveryId: id, kind, docId, channelId });
    } catch (e: any) {
      db.prepare(`UPDATE clinical_document_deliveries SET status = 'failed', error = ? WHERE id = ? AND organization_id = ?`)
        .run(String(e?.message || e).slice(0, 500), id, orgId);
      logAuthEvent(orgId, actorId, doc.contactId, "CLINIC_DOCUMENT_SEND_FAILED", { deliveryId: id, kind, docId, error: String(e?.message || e).slice(0, 200) });
      // Não relança: o histórico já registra a falha e a UI mostra pro operador.
    }

    return hydrate(
      db.prepare(`SELECT * FROM clinical_document_deliveries WHERE id = ?`).get(id)
    )!;
  }
}

export default ClinicDocumentDeliveryService;
