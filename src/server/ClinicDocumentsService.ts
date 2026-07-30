/**
 * Módulo Clínica — DOCUMENTOS (ADR-080 Fase H).
 *
 * Emissão de **Receita** e **Atestado médico** a partir de um `clinical_encounter`.
 * Ciclo: `draft` (editável) → `issued` (imutável). Depois de `issued`, o service
 * bloqueia `update` com código `DOCUMENT_ISSUED` — a próxima fatia trata
 * cancelamento/segunda-via se preciso.
 *
 * Snapshot próprio do profissional (nome + registro + conselho) é gravado
 * **no momento do `issue`**: um doc emitido tem que congelar seu próprio estado
 * independentemente do que aconteça depois no cadastro do profissional.
 *
 * LGPD Art.11 (dado sensível de saúde) — mesmo guardrail que
 * `ClinicEncounterService`: sem `hasConsent('dados_sensiveis')`, `create`/`update`
 * lançam `LGPD_CONSENT_REQUIRED`. É policy do produto, não do cliente.
 *
 * PDF é `Buffer` via `pdfkit` (padrão `ReportPdfService.generateGovernancePdf`).
 * Determinístico, zero-token, isolado por `organization_id`.
 */
import { randomUUID, createHash } from "node:crypto";
import PDFDocument from "pdfkit";
import db from "./db.js";
import { logAuthEvent } from "./auditLog.js";
import { LgpdService } from "./LgpdService.js";

export type DocStatus = "draft" | "issued";

export interface PrescriptionItem {
  drug: string;
  dosage?: string;
  quantity?: string;
  instructions?: string;
  tarja?: string; // livre / vermelha / preta …
}

export interface Prescription {
  id: string;
  organizationId: string;
  encounterId: string;
  appointmentId: string | null;
  contactId: string;
  professionalId: string | null;
  professionalNameSnapshot: string | null;
  professionalRegistrationSnapshot: string | null;
  professionalCouncilSnapshot: string | null;
  headerNotes: string | null;
  items: PrescriptionItem[];
  repeatsAllowed: number;
  validUntil: string | null;
  status: DocStatus;
  issuedBy: string | null;
  issuedAt: string | null;
  signedWithPin: boolean;
  signatureHash: string | null;
  signatureTimestamp: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Certificate {
  id: string;
  organizationId: string;
  encounterId: string;
  appointmentId: string | null;
  contactId: string;
  professionalId: string | null;
  professionalNameSnapshot: string | null;
  professionalRegistrationSnapshot: string | null;
  professionalCouncilSnapshot: string | null;
  cid: string | null;
  cidDescription: string | null;
  days: number;
  purpose: "rest" | "comparecimento" | "other";
  notes: string | null;
  status: DocStatus;
  issuedBy: string | null;
  issuedAt: string | null;
  signedWithPin: boolean;
  signatureHash: string | null;
  signatureTimestamp: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

const SENSITIVE_CONSENT = "dados_sensiveis";

function requireConsent(orgId: string, contactId: string) {
  if (!LgpdService.hasConsent(orgId, contactId, SENSITIVE_CONSENT)) {
    const e: any = new Error("Consentimento LGPD para dados sensíveis (saúde) é obrigatório.");
    e.code = "LGPD_CONSENT_REQUIRED";
    throw e;
  }
}

/**
 * Verifica PIN do profissional antes de emitir (ADR-080 Fase T).
 * - Se o profissional NÃO tem PIN cadastrado, retorna `false` (emitido
 *   sem PIN — compat com clínicas que ainda não adotaram).
 * - Se tem PIN e nenhum foi fornecido → PIN_REQUIRED.
 * - Se tem PIN e o fornecido não bate → PIN_INVALID.
 * - Se bate, retorna `true` (marcar `signed_with_pin=1`).
 * Hash = SHA-256 de `salt + pin`. `salt` é UUID gerado no set.
 */
function verifyPin(orgId: string, professionalId: string | null, providedPin: string | undefined): boolean {
  if (!professionalId) return false;
  const prof = db.prepare(`SELECT pin_hash, pin_salt FROM clinic_professionals WHERE id = ? AND organization_id = ?`)
    .get(professionalId, orgId) as any;
  if (!prof?.pin_hash || !prof?.pin_salt) return false; // não configurou — compat: emite sem PIN
  const pin = String(providedPin || "").trim();
  if (!pin) {
    const e: any = new Error("Este profissional exige PIN para emitir documentos clínicos.");
    e.code = "PIN_REQUIRED"; throw e;
  }
  const attemptHash = createHash("sha256").update(prof.pin_salt + pin).digest("hex");
  if (attemptHash !== prof.pin_hash) {
    const e: any = new Error("PIN incorreto.");
    e.code = "PIN_INVALID"; throw e;
  }
  return true;
}

function loadEncounter(orgId: string, encounterId: string): any {
  const enc = db.prepare(`SELECT * FROM clinical_encounters WHERE organization_id = ? AND id = ?`).get(orgId, encounterId) as any;
  if (!enc) throw new Error("Prontuário não encontrado.");
  return enc;
}

function loadProfessional(orgId: string, professionalId: string | null): any {
  if (!professionalId) return null;
  return db.prepare(`SELECT id, name, registration_number, council FROM clinic_professionals WHERE organization_id = ? AND id = ?`).get(orgId, professionalId) as any;
}

function hydratePrescription(r: any): Prescription | null {
  if (!r) return null;
  let items: PrescriptionItem[] = [];
  try { items = JSON.parse(r.items_json || "[]"); } catch { /* ignora */ }
  return {
    id: r.id,
    organizationId: r.organization_id,
    encounterId: r.encounter_id,
    appointmentId: r.appointment_id ?? null,
    contactId: r.contact_id,
    professionalId: r.professional_id ?? null,
    professionalNameSnapshot: r.professional_name_snapshot ?? null,
    professionalRegistrationSnapshot: r.professional_registration_snapshot ?? null,
    professionalCouncilSnapshot: r.professional_council_snapshot ?? null,
    headerNotes: r.header_notes ?? null,
    items,
    repeatsAllowed: Number(r.repeats_allowed || 0),
    validUntil: r.valid_until ?? null,
    status: r.status,
    issuedBy: r.issued_by ?? null,
    issuedAt: r.issued_at ?? null,
    signedWithPin: Number(r.signed_with_pin || 0) === 1,
    signatureHash: r.signature_hash ?? null,
    signatureTimestamp: r.signature_timestamp ?? null,
    createdBy: r.created_by ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function hydrateCertificate(r: any): Certificate | null {
  if (!r) return null;
  return {
    id: r.id,
    organizationId: r.organization_id,
    encounterId: r.encounter_id,
    appointmentId: r.appointment_id ?? null,
    contactId: r.contact_id,
    professionalId: r.professional_id ?? null,
    professionalNameSnapshot: r.professional_name_snapshot ?? null,
    professionalRegistrationSnapshot: r.professional_registration_snapshot ?? null,
    professionalCouncilSnapshot: r.professional_council_snapshot ?? null,
    cid: r.cid ?? null,
    cidDescription: r.cid_description ?? null,
    days: Number(r.days || 1),
    purpose: r.purpose || "rest",
    notes: r.notes ?? null,
    status: r.status,
    issuedBy: r.issued_by ?? null,
    issuedAt: r.issued_at ?? null,
    signedWithPin: Number(r.signed_with_pin || 0) === 1,
    signatureHash: r.signature_hash ?? null,
    signatureTimestamp: r.signature_timestamp ?? null,
    createdBy: r.created_by ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function normalizeItems(input: any): PrescriptionItem[] {
  if (!Array.isArray(input)) throw new Error("Itens da receita: envie uma lista.");
  return input
    .filter((i) => i && String(i.drug || "").trim())
    .map((i) => ({
      drug: String(i.drug).trim(),
      dosage: i.dosage ? String(i.dosage).trim() : undefined,
      quantity: i.quantity ? String(i.quantity).trim() : undefined,
      instructions: i.instructions ? String(i.instructions).trim() : undefined,
      tarja: i.tarja ? String(i.tarja).trim() : undefined,
    }));
}

function businessName(orgId: string): string {
  try {
    const o = db.prepare("SELECT business_name FROM organization_settings WHERE organization_id = ?").get(orgId) as any;
    return o?.business_name || "Meu negócio";
  } catch { return "Meu negócio"; }
}

function patientName(orgId: string, contactId: string): string {
  const c = db.prepare(`SELECT name FROM contacts WHERE organization_id = ? AND id = ?`).get(orgId, contactId) as any;
  return c?.name || "Paciente";
}

const PT_DAYS = ["domingo", "segunda-feira", "terça-feira", "quarta-feira", "quinta-feira", "sexta-feira", "sábado"];
const PT_MONTHS = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
function longDateBR(iso?: string | null): string {
  const d = iso ? new Date(iso) : new Date();
  return `${d.getDate()} de ${PT_MONTHS[d.getMonth()]} de ${d.getFullYear()}`;
}

// Escreve rodapé de assinatura ("________ / Nome / CRM/SP 12345"). Deixa espaço
// pra assinatura física (papel) — mesmo que o profissional imprima e assine.
function drawSignatureBlock(doc: any, name: string | null, council: string | null, registration: string | null) {
  doc.moveDown(3);
  const startX = 150, endX = 445, y = doc.y;
  doc.moveTo(startX, y).lineTo(endX, y).strokeColor("#111827").lineWidth(0.7).stroke();
  doc.moveDown(0.3);
  doc.fillColor("#111827").font("Helvetica-Bold").fontSize(11).text(name || "Profissional responsável", { align: "center" });
  if (registration) {
    const reg = council ? `${council} ${registration}` : registration;
    doc.font("Helvetica").fontSize(10).fillColor("#374151").text(reg, { align: "center" });
  }
}

// Rodapé de assinatura eletrônica (ADR-080 Fase 16). Só é renderizado
// quando o documento foi emitido com PIN — a validade legal vem do PIN
// (Fase T); o rodapé é a PROVA VISUAL de que ele foi usado. Hash cobre
// o conteúdo canônico (paciente + corpo + profissional + timestamp) —
// qualquer alteração posterior no PDF impresso quebra a conferência.
function longTimestampBR(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}
function drawElectronicSignatureFooter(doc: any, hash: string | null, timestamp: string | null) {
  if (!hash || !timestamp) return;
  doc.moveDown(1.2);
  const y = doc.y, startX = 48, endX = 547;
  doc.moveTo(startX, y).lineTo(endX, y).strokeColor("#9ca3af").lineWidth(0.4).dash(2, { space: 2 }).stroke().undash();
  doc.moveDown(0.4);
  doc.font("Helvetica-Bold").fontSize(8).fillColor("#0f766e")
    .text("Assinado eletronicamente com PIN pessoal (ADR-080 · LGPD Art. 11)", { align: "center" });
  doc.moveDown(0.15);
  doc.font("Helvetica").fontSize(7.5).fillColor("#374151")
    .text(`Emitido em: ${longTimestampBR(timestamp)}`, { align: "center" });
  doc.moveDown(0.1);
  doc.font("Courier").fontSize(7).fillColor("#4b5563")
    .text(`Hash SHA-256: ${hash}`, { align: "center" });
}

// Hash do conteúdo canônico. Reprodução determinística: mesma entrada,
// mesmo hash — permite conferência offline. Timestamp entra dentro pra
// que dois docs idênticos emitidos em momentos distintos gerem hashes
// distintos (senão colidem).
function computeDocumentHash(payload: object): string {
  const canonical = JSON.stringify(payload, Object.keys(payload).sort());
  return createHash("sha256").update(canonical).digest("hex");
}

export class ClinicDocumentsService {
  // ── Prescription ───────────────────────────────────────────────────────

  /**
   * Fase 19: leitura de receita exige consent LGPD Art.11 ATIVO. Doc é dado
   * sensível — se o paciente revoga, o profissional/gestor perde acesso ao
   * conteúdo até novo grant. Retorno `null` quando doc não existe NÃO gata
   * (não há dado a proteger).
   */
  static getPrescription(orgId: string, id: string): Prescription | null {
    const r = db.prepare(`SELECT * FROM clinical_prescriptions WHERE organization_id = ? AND id = ?`).get(orgId, id) as any;
    if (!r) return null;
    requireConsent(orgId, r.contact_id);
    return hydratePrescription(r);
  }

  /**
   * Fase 19: variante interna sem gate — uso exclusivo por `update/issue/
   * render*Pdf` que já validam consent no próprio caller ou têm razão
   * operacional (o `render*Pdf` já checa consent uma vez; internamente
   * repete lookup só pra pegar dados frescos após update). NÃO exportar.
   */
  private static getPrescriptionRaw(orgId: string, id: string): Prescription | null {
    const r = db.prepare(`SELECT * FROM clinical_prescriptions WHERE organization_id = ? AND id = ?`).get(orgId, id);
    return hydratePrescription(r);
  }

  static createPrescription(orgId: string, encounterId: string, input: {
    headerNotes?: string | null;
    items: PrescriptionItem[];
    repeatsAllowed?: number;
    validUntil?: string | null;
  }, actorId: string | null): Prescription {
    const enc = loadEncounter(orgId, encounterId);
    requireConsent(orgId, enc.contact_id);
    const items = normalizeItems(input?.items);
    if (!items.length) throw new Error("Receita precisa de pelo menos 1 item.");

    const id = randomUUID();
    db.prepare(
      `INSERT INTO clinical_prescriptions
         (id, organization_id, encounter_id, appointment_id, contact_id, professional_id,
          header_notes, items_json, repeats_allowed, valid_until, status, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?)`
    ).run(
      id, orgId, encounterId, enc.appointment_id, enc.contact_id, enc.professional_id || null,
      input?.headerNotes ? String(input.headerNotes) : null,
      JSON.stringify(items),
      Math.max(0, Math.floor(Number(input?.repeatsAllowed || 0))),
      input?.validUntil || null,
      actorId
    );

    logAuthEvent(orgId, actorId, enc.contact_id, "CLINIC_PRESCRIPTION_CREATED", { prescriptionId: id, encounterId });
    return this.getPrescriptionRaw(orgId, id)!;
  }

  static updatePrescription(orgId: string, id: string, actorId: string | null, patch: {
    headerNotes?: string | null;
    items?: PrescriptionItem[];
    repeatsAllowed?: number;
    validUntil?: string | null;
  }): Prescription {
    const before = this.getPrescriptionRaw(orgId, id);
    if (!before) throw new Error("Receita não encontrada.");
    if (before.status === "issued") {
      const e: any = new Error("Receita já emitida — não pode ser editada.");
      e.code = "DOCUMENT_ISSUED";
      throw e;
    }
    requireConsent(orgId, before.contactId);

    const fields: string[] = [], params: any[] = [];
    if (patch.headerNotes !== undefined) { fields.push("header_notes = ?"); params.push(patch.headerNotes ? String(patch.headerNotes) : null); }
    if (patch.items !== undefined) {
      const items = normalizeItems(patch.items);
      if (!items.length) throw new Error("Receita precisa de pelo menos 1 item.");
      fields.push("items_json = ?"); params.push(JSON.stringify(items));
    }
    if (patch.repeatsAllowed !== undefined) { fields.push("repeats_allowed = ?"); params.push(Math.max(0, Math.floor(Number(patch.repeatsAllowed)))); }
    if (patch.validUntil !== undefined) { fields.push("valid_until = ?"); params.push(patch.validUntil || null); }
    if (!fields.length) return before;

    fields.push("updated_at = CURRENT_TIMESTAMP");
    db.prepare(`UPDATE clinical_prescriptions SET ${fields.join(", ")} WHERE id = ? AND organization_id = ?`).run(...params, id, orgId);
    logAuthEvent(orgId, actorId, before.contactId, "CLINIC_PRESCRIPTION_UPDATED", { prescriptionId: id });
    return this.getPrescriptionRaw(orgId, id)!;
  }

  static issuePrescription(orgId: string, id: string, actorId: string | null, opts: { pin?: string } = {}): Prescription {
    const before = this.getPrescriptionRaw(orgId, id);
    if (!before) throw new Error("Receita não encontrada.");
    if (before.status === "issued") return before;
    if (!before.items.length) throw new Error("Receita sem itens — não pode ser emitida.");
    requireConsent(orgId, before.contactId);
    const signedWithPin = verifyPin(orgId, before.professionalId, opts.pin);

    const prof = loadProfessional(orgId, before.professionalId);
    const nameSnap = prof?.name || before.professionalNameSnapshot || null;
    const regSnap = prof?.registration_number || null;
    const councilSnap = prof?.council || null;
    // Hash+timestamp da assinatura eletrônica (ADR-080 Fase 16) — só gera
    // quando o PIN foi realmente conferido; sem PIN, ficam null e o rodapé
    // do PDF não é renderizado (mantém compat com clínicas sem PIN).
    const signedAt = new Date().toISOString();
    const signatureHash = signedWithPin ? computeDocumentHash({
      kind: "prescription",
      id,
      orgId,
      contactId: before.contactId,
      professionalName: nameSnap,
      professionalRegistration: regSnap,
      professionalCouncil: councilSnap,
      items: before.items,
      headerNotes: before.headerNotes,
      repeatsAllowed: before.repeatsAllowed,
      validUntil: before.validUntil,
      signedAt,
    }) : null;
    db.prepare(
      `UPDATE clinical_prescriptions
         SET status = 'issued',
             issued_by = ?, issued_at = CURRENT_TIMESTAMP,
             professional_name_snapshot = ?,
             professional_registration_snapshot = ?,
             professional_council_snapshot = ?,
             signed_with_pin = ?,
             signature_hash = ?,
             signature_timestamp = ?,
             updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND organization_id = ?`
    ).run(
      actorId,
      nameSnap, regSnap, councilSnap,
      signedWithPin ? 1 : 0,
      signatureHash,
      signedWithPin ? signedAt : null,
      id, orgId
    );
    logAuthEvent(orgId, actorId, before.contactId, "CLINIC_PRESCRIPTION_ISSUED", { prescriptionId: id, signedWithPin, signatureHash });
    return this.getPrescriptionRaw(orgId, id)!;
  }

  // ── Certificate ────────────────────────────────────────────────────────

  /** Fase 19: paralelo ao `getPrescription` — consent gate + hydrate. */
  static getCertificate(orgId: string, id: string): Certificate | null {
    const r = db.prepare(`SELECT * FROM clinical_medical_certificates WHERE organization_id = ? AND id = ?`).get(orgId, id) as any;
    if (!r) return null;
    requireConsent(orgId, r.contact_id);
    return hydrateCertificate(r);
  }

  /** Fase 19: irmã da `getCertificate` sem gate — uso interno. */
  private static getCertificateRaw(orgId: string, id: string): Certificate | null {
    const r = db.prepare(`SELECT * FROM clinical_medical_certificates WHERE organization_id = ? AND id = ?`).get(orgId, id);
    return hydrateCertificate(r);
  }

  static createCertificate(orgId: string, encounterId: string, input: {
    cid?: string | null;
    cidDescription?: string | null;
    days: number;
    purpose?: "rest" | "comparecimento" | "other";
    notes?: string | null;
  }, actorId: string | null): Certificate {
    const enc = loadEncounter(orgId, encounterId);
    requireConsent(orgId, enc.contact_id);
    const days = Math.floor(Number(input?.days));
    if (!Number.isFinite(days) || days < 1) throw new Error("Atestado precisa de ao menos 1 dia.");
    const purpose = ["rest", "comparecimento", "other"].includes(String(input?.purpose)) ? String(input!.purpose) : "rest";

    const id = randomUUID();
    db.prepare(
      `INSERT INTO clinical_medical_certificates
         (id, organization_id, encounter_id, appointment_id, contact_id, professional_id,
          cid, cid_description, days, purpose, notes, status, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?)`
    ).run(
      id, orgId, encounterId, enc.appointment_id, enc.contact_id, enc.professional_id || null,
      input?.cid ? String(input.cid).trim() : null,
      input?.cidDescription ? String(input.cidDescription).trim() : null,
      days, purpose,
      input?.notes ? String(input.notes) : null,
      actorId
    );

    logAuthEvent(orgId, actorId, enc.contact_id, "CLINIC_CERTIFICATE_CREATED", { certificateId: id, encounterId });
    return this.getCertificateRaw(orgId, id)!;
  }

  static updateCertificate(orgId: string, id: string, actorId: string | null, patch: {
    cid?: string | null;
    cidDescription?: string | null;
    days?: number;
    purpose?: "rest" | "comparecimento" | "other";
    notes?: string | null;
  }): Certificate {
    const before = this.getCertificateRaw(orgId, id);
    if (!before) throw new Error("Atestado não encontrado.");
    if (before.status === "issued") {
      const e: any = new Error("Atestado já emitido — não pode ser editado.");
      e.code = "DOCUMENT_ISSUED";
      throw e;
    }
    requireConsent(orgId, before.contactId);

    const fields: string[] = [], params: any[] = [];
    if (patch.cid !== undefined) { fields.push("cid = ?"); params.push(patch.cid ? String(patch.cid).trim() : null); }
    if (patch.cidDescription !== undefined) { fields.push("cid_description = ?"); params.push(patch.cidDescription ? String(patch.cidDescription).trim() : null); }
    if (patch.days !== undefined) {
      const days = Math.max(1, Math.floor(Number(patch.days)));
      if (!Number.isFinite(days) || days < 1) throw new Error("Atestado precisa de ao menos 1 dia.");
      fields.push("days = ?"); params.push(days);
    }
    if (patch.purpose !== undefined) {
      const p = String(patch.purpose);
      if (!["rest", "comparecimento", "other"].includes(p)) throw new Error("Motivo inválido.");
      fields.push("purpose = ?"); params.push(p);
    }
    if (patch.notes !== undefined) { fields.push("notes = ?"); params.push(patch.notes ? String(patch.notes) : null); }
    if (!fields.length) return before;

    fields.push("updated_at = CURRENT_TIMESTAMP");
    db.prepare(`UPDATE clinical_medical_certificates SET ${fields.join(", ")} WHERE id = ? AND organization_id = ?`).run(...params, id, orgId);
    logAuthEvent(orgId, actorId, before.contactId, "CLINIC_CERTIFICATE_UPDATED", { certificateId: id });
    return this.getCertificateRaw(orgId, id)!;
  }

  static issueCertificate(orgId: string, id: string, actorId: string | null, opts: { pin?: string } = {}): Certificate {
    const before = this.getCertificateRaw(orgId, id);
    if (!before) throw new Error("Atestado não encontrado.");
    if (before.status === "issued") return before;
    requireConsent(orgId, before.contactId);
    const signedWithPin = verifyPin(orgId, before.professionalId, opts.pin);

    const prof = loadProfessional(orgId, before.professionalId);
    const nameSnap = prof?.name || before.professionalNameSnapshot || null;
    const regSnap = prof?.registration_number || null;
    const councilSnap = prof?.council || null;
    const signedAt = new Date().toISOString();
    const signatureHash = signedWithPin ? computeDocumentHash({
      kind: "certificate",
      id,
      orgId,
      contactId: before.contactId,
      professionalName: nameSnap,
      professionalRegistration: regSnap,
      professionalCouncil: councilSnap,
      cid: before.cid,
      cidDescription: before.cidDescription,
      days: before.days,
      purpose: before.purpose,
      notes: before.notes,
      signedAt,
    }) : null;
    db.prepare(
      `UPDATE clinical_medical_certificates
         SET status = 'issued',
             issued_by = ?, issued_at = CURRENT_TIMESTAMP,
             professional_name_snapshot = ?,
             professional_registration_snapshot = ?,
             professional_council_snapshot = ?,
             signed_with_pin = ?,
             signature_hash = ?,
             signature_timestamp = ?,
             updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND organization_id = ?`
    ).run(
      actorId,
      nameSnap, regSnap, councilSnap,
      signedWithPin ? 1 : 0,
      signatureHash,
      signedWithPin ? signedAt : null,
      id, orgId
    );
    logAuthEvent(orgId, actorId, before.contactId, "CLINIC_CERTIFICATE_ISSUED", { certificateId: id, signedWithPin, signatureHash });
    return this.getCertificateRaw(orgId, id)!;
  }

  // ── Listagem consolidada ───────────────────────────────────────────────

  /**
   * Fase 19: listagem consolidada dos docs de um encounter. Consent LGPD
   * derivado do próprio encounter — sem encounter (id inválido / cross-
   * tenant), devolve listas vazias (nada a expor). Com encounter, exige
   * consent SENSITIVE ativo do paciente antes de qualquer row.
   */
  static listByEncounter(orgId: string, encounterId: string): { prescriptions: Prescription[]; certificates: Certificate[] } {
    const enc = db.prepare(`SELECT contact_id FROM clinical_encounters WHERE organization_id = ? AND id = ?`).get(orgId, encounterId) as any;
    if (!enc) return { prescriptions: [], certificates: [] };
    requireConsent(orgId, enc.contact_id);
    const rx = db.prepare(`SELECT * FROM clinical_prescriptions WHERE organization_id = ? AND encounter_id = ? ORDER BY created_at DESC, rowid DESC`)
      .all(orgId, encounterId) as any[];
    const cert = db.prepare(`SELECT * FROM clinical_medical_certificates WHERE organization_id = ? AND encounter_id = ? ORDER BY created_at DESC, rowid DESC`)
      .all(orgId, encounterId) as any[];
    return {
      prescriptions: rx.map((r) => hydratePrescription(r)!).filter(Boolean),
      certificates: cert.map((r) => hydrateCertificate(r)!).filter(Boolean),
    };
  }

  // ── PDFs ───────────────────────────────────────────────────────────────

  static renderPrescriptionPdf(orgId: string, id: string): Promise<Buffer> {
    const rx = this.getPrescription(orgId, id);
    if (!rx) throw new Error("Receita não encontrada.");
    const biz = businessName(orgId);
    const patient = patientName(orgId, rx.contactId);
    const issued = rx.status === "issued";
    const dateStr = issued && rx.issuedAt ? longDateBR(rx.issuedAt) : longDateBR();

    return new Promise((resolve, reject) => {
      try {
        const doc = new PDFDocument({ size: "A4", margin: 48 });
        const chunks: Buffer[] = [];
        doc.on("data", (c: Buffer) => chunks.push(c));
        doc.on("end", () => resolve(Buffer.concat(chunks)));
        doc.on("error", reject);

        // Cabeçalho
        doc.fillColor("#0f766e").font("Helvetica-Bold").fontSize(20).text(biz);
        doc.fillColor("#111827").fontSize(15).text("Receita");
        doc.fillColor("#6b7280").font("Helvetica").fontSize(9).text(dateStr);
        if (!issued) {
          doc.fillColor("#b91c1c").font("Helvetica-Bold").fontSize(10).text("RASCUNHO — não vale como receita emitida");
        }
        doc.moveDown(0.6);

        // Paciente
        doc.fillColor("#111827").font("Helvetica-Bold").fontSize(11).text(`Paciente: `, { continued: true }).font("Helvetica").text(patient);
        if (rx.headerNotes) {
          doc.moveDown(0.4);
          doc.font("Helvetica").fontSize(10).fillColor("#374151").text(rx.headerNotes);
        }
        doc.moveDown(0.6);

        // Itens
        doc.fillColor("#111827").font("Helvetica-Bold").fontSize(11).text("Prescrição:");
        doc.moveDown(0.2);
        rx.items.forEach((it, i) => {
          const line1 = `${i + 1}. ${it.drug}${it.dosage ? ` — ${it.dosage}` : ""}${it.quantity ? ` — ${it.quantity}` : ""}`;
          doc.font("Helvetica-Bold").fontSize(10.5).fillColor("#111827").text(line1);
          if (it.instructions) {
            doc.font("Helvetica").fontSize(10).fillColor("#374151").text(`   ${it.instructions}`);
          }
          if (it.tarja) {
            doc.font("Helvetica-Oblique").fontSize(9).fillColor("#b91c1c").text(`   Tarja: ${it.tarja}`);
          }
          doc.moveDown(0.2);
        });

        // Rodapé (repetição / validade)
        doc.moveDown(0.4);
        const footerBits: string[] = [];
        if (rx.repeatsAllowed > 0) footerBits.push(`Uso continuado: pode ser repetida ${rx.repeatsAllowed} vez(es).`);
        if (rx.validUntil) footerBits.push(`Válida até ${longDateBR(rx.validUntil)}.`);
        if (footerBits.length) doc.font("Helvetica-Oblique").fontSize(9).fillColor("#6b7280").text(footerBits.join(" "));

        drawSignatureBlock(doc, rx.professionalNameSnapshot, rx.professionalCouncilSnapshot, rx.professionalRegistrationSnapshot);
        drawElectronicSignatureFooter(doc, rx.signatureHash, rx.signatureTimestamp);
        doc.end();
      } catch (e) { reject(e as any); }
    });
  }

  static renderCertificatePdf(orgId: string, id: string): Promise<Buffer> {
    const cert = this.getCertificate(orgId, id);
    if (!cert) throw new Error("Atestado não encontrado.");
    const biz = businessName(orgId);
    const patient = patientName(orgId, cert.contactId);
    const issued = cert.status === "issued";
    const dateStr = issued && cert.issuedAt ? longDateBR(cert.issuedAt) : longDateBR();

    return new Promise((resolve, reject) => {
      try {
        const doc = new PDFDocument({ size: "A4", margin: 48 });
        const chunks: Buffer[] = [];
        doc.on("data", (c: Buffer) => chunks.push(c));
        doc.on("end", () => resolve(Buffer.concat(chunks)));
        doc.on("error", reject);

        doc.fillColor("#0f766e").font("Helvetica-Bold").fontSize(20).text(biz);
        doc.fillColor("#111827").fontSize(15).text("Atestado médico");
        doc.fillColor("#6b7280").font("Helvetica").fontSize(9).text(dateStr);
        if (!issued) {
          doc.fillColor("#b91c1c").font("Helvetica-Bold").fontSize(10).text("RASCUNHO — não vale como atestado emitido");
        }
        doc.moveDown(1);

        // Corpo do atestado
        const purposePhrase = cert.purpose === "comparecimento"
          ? `compareceu a consulta`
          : cert.purpose === "rest"
            ? `necessita de afastamento de suas atividades por ${cert.days} dia(s)`
            : `apresentou a condição descrita`;

        const paragraph = `Atesto para os devidos fins que ${patient} ${purposePhrase} a partir desta data.`;
        doc.fillColor("#111827").font("Helvetica").fontSize(12).text(paragraph, { align: "justify", lineGap: 3 });

        if (cert.cid) {
          doc.moveDown(0.6);
          const cidLine = cert.cidDescription ? `CID-10: ${cert.cid} — ${cert.cidDescription}` : `CID-10: ${cert.cid}`;
          doc.font("Helvetica-Bold").fontSize(10.5).fillColor("#111827").text(cidLine);
        }
        if (cert.notes) {
          doc.moveDown(0.4);
          doc.font("Helvetica").fontSize(10.5).fillColor("#374151").text(cert.notes, { align: "justify", lineGap: 2 });
        }

        drawSignatureBlock(doc, cert.professionalNameSnapshot, cert.professionalCouncilSnapshot, cert.professionalRegistrationSnapshot);
        drawElectronicSignatureFooter(doc, cert.signatureHash, cert.signatureTimestamp);
        doc.end();
      } catch (e) { reject(e as any); }
    });
  }
}

export default ClinicDocumentsService;
