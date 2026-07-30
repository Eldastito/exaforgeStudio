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
  static list(orgId: string, encounterId: string): Attachment[] {
    const rows = db.prepare(
      `SELECT * FROM clinical_encounter_attachments
        WHERE organization_id = ? AND encounter_id = ?
        ORDER BY uploaded_at DESC, rowid DESC`
    ).all(orgId, encounterId) as any[];
    return rows.map((r) => hydrate(r)!).filter(Boolean);
  }

  static get(orgId: string, id: string): Attachment | null {
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

    const spec = ALLOWED_MIME[input.mime];
    if (!spec) throw new Error("Formato não suportado (use PNG, JPG, WEBP ou PDF).");
    if (!input.buffer || input.buffer.length === 0) throw new Error("Arquivo vazio.");
    if (input.buffer.length > MAX_BYTES) throw new Error(`Arquivo maior que ${Math.floor(MAX_BYTES / 1024 / 1024)} MB.`);

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
      input.mime,
      input.originalFilename ? String(input.originalFilename).slice(0, 200) : null,
      storageKey,
      input.buffer.length,
      actorId
    );

    logAuthEvent(orgId, actorId, enc.contact_id, "CLINIC_ATTACHMENT_ADDED", {
      attachmentId: id, encounterId, kind: spec.kind, sizeBytes: input.buffer.length,
    });
    return this.get(orgId, id)!;
  }

  /** Devolve buffer + mime + filename pra rota de download. */
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
    const att = this.get(orgId, id);
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
}

export default ClinicAttachmentService;
