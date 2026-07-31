/**
 * Módulo Clínica — ANEXOS do prontuário (ADR-080 Fase J).
 *
 * Foto de exame, PDF de laudo, imagem antes/depois — critical pra fisio,
 * dermato, ortopedia (comparação visual é insumo clínico do próprio SOAP).
 *
 * Arquivo físico fica em **`PRIVATE_MEDIA_DIR/clinical/{orgId}/{encounterId}/`**
 * (fora do `/media` estático), acessível só via rota autenticada com
 * streaming. É dado LGPD Art.11 — o guardrail de consentimento
 * `dados_sensiveis` bloqueia `add()` e `remove()` (mesmo padrão do
 * encounter e docs).
 *
 * Após `finalize()` do encounter, `remove()` é BLOQUEADO
 * (`ATTACHMENT_FROZEN`) — não se apaga anexo de prontuário assinado.
 * Purge legítimo (retenção LGPD) fica pra Scheduler numa próxima fatia.
 *
 * Whitelist: image/png, image/jpeg, image/webp, application/pdf.
 * Tamanho: até 15 MB (limite do multer é validação primária; aqui é redundância).
 * Não espelha em S3 nesta fatia — política de espelhamento pra dado
 * sensível precisa de decisão dedicada.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import db from "./db.js";
import { logAuthEvent } from "./auditLog.js";
import { LgpdService } from "./LgpdService.js";

export const PRIVATE_CLINICAL_DIR = path.join(
  process.env.DATA_DIR || process.cwd(),
  "private_media",
  "clinical"
);
try { fs.mkdirSync(PRIVATE_CLINICAL_DIR, { recursive: true }); } catch { /* noop */ }

export const ALLOWED_MIME: Record<string, { ext: string; kind: "image" | "pdf" }> = {
  "image/png":       { ext: ".png",  kind: "image" },
  "image/jpeg":      { ext: ".jpg",  kind: "image" },
  "image/jpg":       { ext: ".jpg",  kind: "image" },
  "image/webp":      { ext: ".webp", kind: "image" },
  "application/pdf": { ext: ".pdf",  kind: "pdf"   },
};
export const MAX_BYTES = 15 * 1024 * 1024;

/**
 * Magic-byte sniffing dos 4 formatos permitidos (ADR-080 Fase 30).
 * Fecha buraco H4 da auditoria: `multer` só olha o Content-Type declarado
 * pelo cliente — atacante manda `<script>alert(1)</script>` com
 * `Content-Type: image/png` e o storage aceita; browser executa como HTML
 * se `X-Content-Type-Options: nosniff` estiver ausente ou se algum caminho
 * de download servir o buffer com mime baseado só na extensão. Assinatura
 * binária real é fonte de verdade — se o buffer não bate com nenhum dos
 * 4 formatos, `add()` rejeita `INVALID_FILE_CONTENT`.
 *
 * Sniffing manual (sem dep externa `file-type`, que puxaria centenas de
 * KB pra 4 casos):
 *   - PNG:  89 50 4E 47 0D 0A 1A 0A
 *   - JPEG: FF D8 FF
 *   - WEBP: "RIFF"...."WEBP" (bytes 0-3 = 'RIFF', 8-11 = 'WEBP')
 *   - PDF:  %PDF- (25 50 44 46 2D)
 */
export function detectMime(buf: Buffer): string | null {
  if (!buf || buf.length < 4) return null;
  // PNG
  if (buf.length >= 8 &&
      buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47 &&
      buf[4] === 0x0D && buf[5] === 0x0A && buf[6] === 0x1A && buf[7] === 0x0A) {
    return "image/png";
  }
  // JPEG
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return "image/jpeg";
  // WEBP: RIFF....WEBP
  if (buf.length >= 12 &&
      buf.toString("ascii", 0, 4) === "RIFF" &&
      buf.toString("ascii", 8, 12) === "WEBP") {
    return "image/webp";
  }
  // PDF: %PDF-
  if (buf.length >= 5 &&
      buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46 && buf[4] === 0x2D) {
    return "application/pdf";
  }
  return null;
}

/**
 * Sanitiza nome de arquivo pra ir em `Content-Disposition` — remove CRLF
 * (header injection), aspas, `;` (delimitador de header), path traversal.
 * ADR-080 Fase 30. Preserva caracteres seguros: letras/dígitos/underscore/
 * ponto/hífen/espaço. Vazio → fallback. Truncado a 120 chars.
 */
export function safeFilename(name: string | null | undefined): string {
  const raw = String(name || "").trim();
  if (!raw) return "anexo";
  const cleaned = raw
    .replace(/[\r\n\t]/g, " ")           // CRLF injection defense
    .replace(/[^A-Za-z0-9._\- ]/g, "_")  // resto vira _ (mesmo aspas/;/=)
    .replace(/_+/g, "_")
    .replace(/^\.+/, "")                 // sem dot-file
    .slice(0, 120);
  return cleaned || "anexo";
}

export interface Attachment {
  id: string;
  organizationId: string;
  encounterId: string;
  appointmentId: string | null;
  contactId: string;
  label: string | null;
  kind: "image" | "pdf" | "other";
  mimeType: string;
  originalFilename: string | null;
  storageKey: string;
  sizeBytes: number;
  shareWithPatient: boolean;
  uploadedBy: string | null;
  uploadedAt: string;
}

const SENSITIVE_CONSENT = "dados_sensiveis";

function requireConsent(orgId: string, contactId: string) {
  if (!LgpdService.hasConsent(orgId, contactId, SENSITIVE_CONSENT)) {
    const e: any = new Error("Consentimento LGPD para dados sensíveis (saúde) é obrigatório.");
    e.code = "LGPD_CONSENT_REQUIRED";
    throw e;
  }
}

function encounterDir(orgId: string, encounterId: string): string {
  // Isolar por org+encounter reduz risco de path traversal e facilita purge.
  const dir = path.join(PRIVATE_CLINICAL_DIR, orgId, encounterId);
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* noop */ }
  return dir;
}

function safeStorageKey(storageKey: string): string {
  // Defesa em profundidade: aceitar só basename (nada de "../"), letras/dígitos/hífen/ponto.
  const base = path.basename(storageKey);
  if (base !== storageKey || !/^[a-zA-Z0-9._-]+$/.test(base)) {
    throw new Error("Caminho de anexo inválido.");
  }
  return base;
}

function hydrate(r: any): Attachment | null {
  if (!r) return null;
  return {
    id: r.id,
    organizationId: r.organization_id,
    encounterId: r.encounter_id,
    appointmentId: r.appointment_id ?? null,
    contactId: r.contact_id,
    label: r.label ?? null,
    kind: r.kind,
    mimeType: r.mime_type,
    originalFilename: r.original_filename ?? null,
    storageKey: r.storage_key,
    sizeBytes: Number(r.size_bytes || 0),
    shareWithPatient: !!Number(r.share_with_patient || 0),
    uploadedBy: r.uploaded_by ?? null,
    uploadedAt: r.uploaded_at,
  };
}

function loadEncounter(orgId: string, encounterId: string): any {
  const enc = db.prepare(`SELECT * FROM clinical_encounters WHERE organization_id = ? AND id = ?`).get(orgId, encounterId) as any;
  if (!enc) throw new Error("Prontuário não encontrado.");
  return enc;
}

export class ClinicAttachmentService {
  /**
   * Fase 19: exige consent LGPD SENSITIVE do paciente dono do encounter
   * antes de listar anexos. Encounter inexistente → lista vazia (sem gate,
   * nada a proteger). Foto de exame, laudo, imagem antes/depois = dado
   * sensível.
   */
  static list(orgId: string, encounterId: string): Attachment[] {
    const enc = db.prepare(`SELECT contact_id FROM clinical_encounters WHERE organization_id = ? AND id = ?`).get(orgId, encounterId) as any;
    if (!enc) return [];
    requireConsent(orgId, enc.contact_id);
    const rows = db.prepare(
      `SELECT * FROM clinical_encounter_attachments
        WHERE organization_id = ? AND encounter_id = ?
        ORDER BY uploaded_at DESC, rowid DESC`
    ).all(orgId, encounterId) as any[];
    return rows.map((r) => hydrate(r)!).filter(Boolean);
  }

  /**
   * Fase 19: leitura de anexo isolado. Consent lookup usa o próprio row do
   * anexo (contact_id). Row inexistente → null (não gata).
   */
  static get(orgId: string, id: string): Attachment | null {
    const r = db.prepare(`SELECT * FROM clinical_encounter_attachments WHERE organization_id = ? AND id = ?`).get(orgId, id) as any;
    if (!r) return null;
    requireConsent(orgId, r.contact_id);
    return hydrate(r);
  }

  /**
   * Fase 19: irmã sem gate — uso interno por `remove()` (que já checa
   * consent explicitamente) e por `setSharedWithPatient` (visibilidade
   * não é achado clínico — decisão de compartilhar não muda com revoke,
   * o próprio Portal já revalida). NÃO exportar.
   */
  private static getRaw(orgId: string, id: string): Attachment | null {
    const r = db.prepare(`SELECT * FROM clinical_encounter_attachments WHERE organization_id = ? AND id = ?`).get(orgId, id);
    return hydrate(r);
  }

  /**
   * Adiciona anexo. Recebe buffer já lido (rota faz multer memoryStorage).
   * Grava arquivo em disco + row. Idempotência não faz sentido aqui — cada
   * upload é um evento próprio (mesmo arquivo enviado 2× vira 2 anexos).
   */
  static add(orgId: string, encounterId: string, input: {
    buffer: Buffer;
    mime: string;
    originalFilename?: string | null;
    label?: string | null;
  }, actorId: string | null): Attachment {
    const enc = loadEncounter(orgId, encounterId);
    requireConsent(orgId, enc.contact_id);

    if (!input.buffer || input.buffer.length === 0) throw new Error("Arquivo vazio.");
    if (input.buffer.length > MAX_BYTES) throw new Error(`Arquivo maior que ${Math.floor(MAX_BYTES / 1024 / 1024)} MB.`);
    // Fase 30: sniffing binário — sempre confia no CONTEÚDO REAL, nunca no
    // `Content-Type` declarado pelo cliente. Se magic byte não bate com
    // nenhum dos 4 formatos permitidos, rejeita. Se bate mas o mime
    // declarado é diferente, sobrescreve pro real (protege downstream que
    // possa depender de `mime_type` gravado).
    const detected = detectMime(input.buffer);
    if (!detected) {
      const e: any = new Error("Formato não suportado (use PNG, JPG, WEBP ou PDF).");
      e.code = "INVALID_FILE_CONTENT"; throw e;
    }
    const spec = ALLOWED_MIME[detected];
    if (!spec) {
      const e: any = new Error("Formato não suportado (use PNG, JPG, WEBP ou PDF).");
      e.code = "INVALID_FILE_CONTENT"; throw e;
    }
    // mime gravado = real detectado (não o declarado do multer)
    const actualMime = detected;

    const id = randomUUID();
    const storageKey = `${id}${spec.ext}`;
    const dir = encounterDir(orgId, encounterId);
    const filePath = path.join(dir, storageKey);
    fs.writeFileSync(filePath, input.buffer);

    db.prepare(
      `INSERT INTO clinical_encounter_attachments
         (id, organization_id, encounter_id, appointment_id, contact_id, label, kind,
          mime_type, original_filename, storage_key, size_bytes, uploaded_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id, orgId, encounterId, enc.appointment_id, enc.contact_id,
      input.label ? String(input.label).trim().slice(0, 200) : null,
      spec.kind,
      actualMime,
      input.originalFilename ? safeFilename(input.originalFilename) : null,
      storageKey,
      input.buffer.length,
      actorId
    );

    logAuthEvent(orgId, actorId, enc.contact_id, "CLINIC_ATTACHMENT_ADDED", {
      attachmentId: id, encounterId, kind: spec.kind, sizeBytes: input.buffer.length,
    });
    return this.getRaw(orgId, id)!;
  }

  /**
   * Devolve buffer + mime + filename pra rota de download.
   * Fase 19: `this.get` já gata consent SENSITIVE — leitura de anexo cai
   * na mesma regra que `getPrescription`/`getCertificate`.
   */
  static read(orgId: string, id: string): { buffer: Buffer; mime: string; filename: string } {
    const att = this.get(orgId, id);
    if (!att) throw new Error("Anexo não encontrado.");
    const storageKey = safeStorageKey(att.storageKey);
    const filePath = path.join(PRIVATE_CLINICAL_DIR, att.organizationId, att.encounterId, storageKey);
    if (!fs.existsSync(filePath)) throw new Error("Arquivo do anexo não está mais disponível.");
    const buffer = fs.readFileSync(filePath);
    return {
      buffer,
      mime: att.mimeType,
      filename: att.originalFilename || att.storageKey,
    };
  }

  /**
   * Remove anexo. BLOQUEADO se encounter já foi assinado — não se apaga
   * anexo de prontuário signed (mesma lógica de integridade dos docs
   * emitidos). Se por retenção LGPD precisar remover, faz por job dedicado.
   */
  static remove(orgId: string, id: string, actorId: string | null): void {
    // Fase 19: usa raw pra evitar erro duplo — o `requireConsent` abaixo
    // faz o gate único, mesmo antes de decidir se pode remover.
    const att = this.getRaw(orgId, id);
    if (!att) throw new Error("Anexo não encontrado.");
    const enc = db.prepare(`SELECT status FROM clinical_encounters WHERE organization_id = ? AND id = ?`)
      .get(orgId, att.encounterId) as any;
    if (enc?.status === "signed") {
      const e: any = new Error("Prontuário já assinado — anexo não pode ser removido.");
      e.code = "ATTACHMENT_FROZEN";
      throw e;
    }
    requireConsent(orgId, att.contactId);

    db.prepare(`DELETE FROM clinical_encounter_attachments WHERE id = ? AND organization_id = ?`).run(id, orgId);
    // Best-effort no arquivo: banco é a fonte de verdade.
    try {
      const storageKey = safeStorageKey(att.storageKey);
      const filePath = path.join(PRIVATE_CLINICAL_DIR, orgId, att.encounterId, storageKey);
      fs.rmSync(filePath, { force: true });
    } catch { /* noop */ }

    logAuthEvent(orgId, actorId, att.contactId, "CLINIC_ATTACHMENT_REMOVED", { attachmentId: id, encounterId: att.encounterId });
  }

  /**
   * Compartilhar/desmarcar anexo com o Portal do Paciente (ADR-080 Fase L).
   * Não é bloqueado por encounter signed — visibilidade não é achado clínico.
   */
  static setSharedWithPatient(orgId: string, id: string, share: boolean, actorId: string | null): Attachment {
    // Fase 19: usa raw — decisão de compartilhar não muda com revoke do
    // paciente (o Portal já revalida consent em cada acesso após Fatia 18).
    const att = this.getRaw(orgId, id);
    if (!att) throw new Error("Anexo não encontrado.");
    db.prepare(`UPDATE clinical_encounter_attachments SET share_with_patient = ? WHERE id = ? AND organization_id = ?`)
      .run(share ? 1 : 0, id, orgId);
    logAuthEvent(orgId, actorId, att.contactId, "CLINIC_ATTACHMENT_SHARE_CHANGED", { attachmentId: id, share });
    return this.getRaw(orgId, id)!;
  }
}

export default ClinicAttachmentService;
