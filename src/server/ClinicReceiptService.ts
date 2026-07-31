/**
 * Módulo Clínica — RECIBO PARTICULAR (ADR-080 Fase 27).
 *
 * Consulta particular (fora de convênio) precisa gerar recibo pra o
 * paciente comprovar pagamento e usar em imposto de renda / plano privado.
 * Hoje o produto para em prescription/certificate e o financeiro é
 * WhatsApp-com-a-secretária (papelzinho ou nada). Esta fatia fecha o loop
 * atendimento → cobrança → recibo pronto no celular do paciente.
 *
 * Molde: `ClinicDocumentsService` (mesma UX de draft/issue/PDF/envio).
 *
 * - Valor em CENTAVOS (INTEGER) — nunca float. Evita erro clássico de
 *   arredondamento em dinheiro (0.1 + 0.2 !== 0.3).
 * - `payment_method` whitelist fechada.
 * - Ciclo `draft` → `issued` (imutável após issued — mesmo padrão H).
 * - LGPD Art.11 obrigatório: recibo diz que aquele CPF pagou consulta
 *   médica com aquele profissional — dado sensível pleno.
 * - Snapshot no momento do issue: nome+registro+conselho do profissional,
 *   nome do negócio, documento do negócio, nome do paciente. Alterar
 *   cadastro depois NÃO afeta recibo emitido (auditoria fiscal).
 * - PIN opcional (reusa `verifyPin` da Fase T) — se profissional tem PIN
 *   configurado, exige; sem PIN cadastrado, emite compat sem PIN.
 * - Hash SHA-256 + timestamp do payload canônico no rodapé (padrão Fase 16)
 *   quando emitido com PIN. Permite conferência offline do impresso.
 *
 * Determinístico, isolado por `organization_id`.
 */
import { randomUUID } from "node:crypto";
import PDFDocument from "pdfkit";
import db from "./db.js";
import { logAuthEvent } from "./auditLog.js";
import { LgpdService } from "./LgpdService.js";
import {
  verifyPin,
  drawSignatureBlock,
  drawElectronicSignatureFooter,
  computeDocumentHash,
  longDateBR,
} from "./ClinicDocumentsService.js";

export type ReceiptStatus = "draft" | "issued";
export type PaymentMethod = "pix" | "debit" | "credit" | "cash" | "transfer" | "other";
export type DocumentType = "cpf" | "cnpj";

const ALLOWED_METHODS: PaymentMethod[] = ["pix", "debit", "credit", "cash", "transfer", "other"];
const ALLOWED_DOCUMENT_TYPES: DocumentType[] = ["cpf", "cnpj"];
const SENSITIVE_CONSENT = "dados_sensiveis";

const PAYMENT_LABEL_PT: Record<PaymentMethod, string> = {
  pix: "Pix",
  debit: "Cartão de débito",
  credit: "Cartão de crédito",
  cash: "Dinheiro",
  transfer: "Transferência bancária",
  other: "Outra forma",
};

export interface Receipt {
  id: string;
  organizationId: string;
  encounterId: string;
  appointmentId: string | null;
  contactId: string;
  professionalId: string | null;
  professionalNameSnapshot: string | null;
  professionalRegistrationSnapshot: string | null;
  professionalCouncilSnapshot: string | null;
  businessNameSnapshot: string | null;
  businessDocumentSnapshot: string | null;
  businessDocumentTypeSnapshot: DocumentType | null;
  patientNameSnapshot: string | null;
  patientDocument: string | null;
  patientDocumentType: DocumentType | null;
  amountCents: number;
  paymentMethod: PaymentMethod;
  description: string | null;
  notes: string | null;
  status: ReceiptStatus;
  signedWithPin: boolean;
  signatureHash: string | null;
  signatureTimestamp: string | null;
  issuedBy: string | null;
  issuedAt: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

function requireConsent(orgId: string, contactId: string) {
  if (!LgpdService.hasConsent(orgId, contactId, SENSITIVE_CONSENT)) {
    const e: any = new Error("Consentimento LGPD para dados sensíveis (saúde) é obrigatório.");
    e.code = "LGPD_CONSENT_REQUIRED";
    throw e;
  }
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

function loadOrgProfile(orgId: string): { businessName: string | null; doc: string | null; docType: DocumentType | null } {
  const r = db.prepare(
    `SELECT business_name AS bn,
            clinic_receipt_business_document AS d,
            clinic_receipt_business_document_type AS dt
       FROM organization_settings WHERE organization_id = ?`
  ).get(orgId) as any;
  const docType = r?.dt && ALLOWED_DOCUMENT_TYPES.includes(r.dt) ? (r.dt as DocumentType) : null;
  return {
    businessName: r?.bn ?? null,
    doc: r?.d ?? null,
    docType,
  };
}

function patientNameOf(orgId: string, contactId: string): string | null {
  const c = db.prepare(`SELECT name FROM contacts WHERE organization_id = ? AND id = ?`).get(orgId, contactId) as any;
  return c?.name ?? null;
}

function hydrate(r: any): Receipt | null {
  if (!r) return null;
  const docType = r.patient_document_type && ALLOWED_DOCUMENT_TYPES.includes(r.patient_document_type)
    ? (r.patient_document_type as DocumentType) : null;
  const bizDocType = r.business_document_type_snapshot && ALLOWED_DOCUMENT_TYPES.includes(r.business_document_type_snapshot)
    ? (r.business_document_type_snapshot as DocumentType) : null;
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
    businessNameSnapshot: r.business_name_snapshot ?? null,
    businessDocumentSnapshot: r.business_document_snapshot ?? null,
    businessDocumentTypeSnapshot: bizDocType,
    patientNameSnapshot: r.patient_name_snapshot ?? null,
    patientDocument: r.patient_document ?? null,
    patientDocumentType: docType,
    amountCents: Number(r.amount_cents || 0),
    paymentMethod: r.payment_method,
    description: r.description ?? null,
    notes: r.notes ?? null,
    status: r.status,
    signedWithPin: Number(r.signed_with_pin || 0) === 1,
    signatureHash: r.signature_hash ?? null,
    signatureTimestamp: r.signature_timestamp ?? null,
    issuedBy: r.issued_by ?? null,
    issuedAt: r.issued_at ?? null,
    createdBy: r.created_by ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function normalizeAmountCents(input: any): number {
  const n = Math.floor(Number(input));
  if (!Number.isFinite(n) || n <= 0) {
    const e: any = new Error("Valor precisa ser um número inteiro em centavos maior que zero.");
    e.code = "RECEIPT_INVALID_AMOUNT"; throw e;
  }
  return n;
}

function normalizeMethod(input: any): PaymentMethod {
  const m = String(input || "").trim() as PaymentMethod;
  if (!ALLOWED_METHODS.includes(m)) {
    const e: any = new Error(`Forma de pagamento inválida. Use: ${ALLOWED_METHODS.join(", ")}.`);
    e.code = "RECEIPT_INVALID_PAYMENT_METHOD"; throw e;
  }
  return m;
}

function normalizeDocumentType(input: any): DocumentType | null {
  if (input == null || input === "") return null;
  const t = String(input || "").trim().toLowerCase() as DocumentType;
  if (!ALLOWED_DOCUMENT_TYPES.includes(t)) {
    const e: any = new Error(`Tipo de documento inválido. Use: ${ALLOWED_DOCUMENT_TYPES.join(", ")}.`);
    e.code = "RECEIPT_INVALID_DOCUMENT_TYPE"; throw e;
  }
  return t;
}

function formatBRL(cents: number): string {
  const value = cents / 100;
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(value);
}

export class ClinicReceiptService {
  static get(orgId: string, id: string): Receipt | null {
    const r = db.prepare(`SELECT * FROM clinical_receipts WHERE organization_id = ? AND id = ?`).get(orgId, id) as any;
    if (!r) return null;
    requireConsent(orgId, r.contact_id);
    return hydrate(r);
  }

  private static getRaw(orgId: string, id: string): Receipt | null {
    const r = db.prepare(`SELECT * FROM clinical_receipts WHERE organization_id = ? AND id = ?`).get(orgId, id);
    return hydrate(r);
  }

  static listByEncounter(orgId: string, encounterId: string): Receipt[] {
    // Gate via encounter (fase 19 pattern) — sem row do encounter, nada a expor.
    const enc = db.prepare(`SELECT contact_id FROM clinical_encounters WHERE organization_id = ? AND id = ?`).get(orgId, encounterId) as any;
    if (!enc) return [];
    requireConsent(orgId, enc.contact_id);
    const rows = db.prepare(
      `SELECT * FROM clinical_receipts
        WHERE organization_id = ? AND encounter_id = ?
        ORDER BY created_at DESC, rowid DESC`
    ).all(orgId, encounterId) as any[];
    return rows.map((r) => hydrate(r)!).filter(Boolean);
  }

  static create(orgId: string, encounterId: string, input: {
    amountCents: number;
    paymentMethod: PaymentMethod;
    description?: string | null;
    notes?: string | null;
    patientDocument?: string | null;
    patientDocumentType?: DocumentType | null;
  }, actorId: string | null): Receipt {
    const enc = loadEncounter(orgId, encounterId);
    requireConsent(orgId, enc.contact_id);

    const amountCents = normalizeAmountCents(input.amountCents);
    const method = normalizeMethod(input.paymentMethod);
    const patientDocType = normalizeDocumentType(input.patientDocumentType);
    const patientDoc = input.patientDocument ? String(input.patientDocument).trim().slice(0, 32) || null : null;

    const id = randomUUID();
    db.prepare(
      `INSERT INTO clinical_receipts
         (id, organization_id, encounter_id, appointment_id, contact_id, professional_id,
          amount_cents, payment_method, description, notes,
          patient_document, patient_document_type, status, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?)`
    ).run(
      id, orgId, encounterId, enc.appointment_id, enc.contact_id, enc.professional_id || null,
      amountCents, method,
      input.description ? String(input.description).trim().slice(0, 500) : null,
      input.notes ? String(input.notes).trim().slice(0, 1000) : null,
      patientDoc,
      patientDocType,
      actorId
    );

    logAuthEvent(orgId, actorId, enc.contact_id, "CLINIC_RECEIPT_CREATED", {
      receiptId: id, encounterId, amountCents, paymentMethod: method,
    });
    return this.getRaw(orgId, id)!;
  }

  static update(orgId: string, id: string, actorId: string | null, patch: {
    amountCents?: number;
    paymentMethod?: PaymentMethod;
    description?: string | null;
    notes?: string | null;
    patientDocument?: string | null;
    patientDocumentType?: DocumentType | null;
  }): Receipt {
    const before = this.getRaw(orgId, id);
    if (!before) throw new Error("Recibo não encontrado.");
    if (before.status === "issued") {
      const e: any = new Error("Recibo já emitido — não pode ser editado.");
      e.code = "DOCUMENT_ISSUED"; throw e;
    }
    requireConsent(orgId, before.contactId);

    const fields: string[] = [], params: any[] = [];
    if (patch.amountCents !== undefined) {
      fields.push("amount_cents = ?"); params.push(normalizeAmountCents(patch.amountCents));
    }
    if (patch.paymentMethod !== undefined) {
      fields.push("payment_method = ?"); params.push(normalizeMethod(patch.paymentMethod));
    }
    if (patch.description !== undefined) {
      fields.push("description = ?");
      params.push(patch.description ? String(patch.description).trim().slice(0, 500) || null : null);
    }
    if (patch.notes !== undefined) {
      fields.push("notes = ?");
      params.push(patch.notes ? String(patch.notes).trim().slice(0, 1000) || null : null);
    }
    if (patch.patientDocument !== undefined) {
      fields.push("patient_document = ?");
      params.push(patch.patientDocument ? String(patch.patientDocument).trim().slice(0, 32) || null : null);
    }
    if (patch.patientDocumentType !== undefined) {
      fields.push("patient_document_type = ?");
      params.push(normalizeDocumentType(patch.patientDocumentType));
    }
    if (!fields.length) return before;

    fields.push("updated_at = CURRENT_TIMESTAMP");
    db.prepare(`UPDATE clinical_receipts SET ${fields.join(", ")} WHERE id = ? AND organization_id = ?`).run(...params, id, orgId);
    logAuthEvent(orgId, actorId, before.contactId, "CLINIC_RECEIPT_UPDATED", {
      receiptId: id, changed: Object.keys(patch),
    });
    return this.getRaw(orgId, id)!;
  }

  static issue(orgId: string, id: string, actorId: string | null, opts: { pin?: string } = {}): Receipt {
    const before = this.getRaw(orgId, id);
    if (!before) throw new Error("Recibo não encontrado.");
    if (before.status === "issued") return before;
    requireConsent(orgId, before.contactId);

    const signedWithPin = verifyPin(orgId, before.professionalId, opts.pin);

    const prof = loadProfessional(orgId, before.professionalId);
    const profNameSnap = prof?.name || before.professionalNameSnapshot || null;
    const profRegSnap = prof?.registration_number || null;
    const profCouncilSnap = prof?.council || null;

    const orgProfile = loadOrgProfile(orgId);
    const patientSnap = patientNameOf(orgId, before.contactId);

    const signedAt = new Date().toISOString();
    const signatureHash = signedWithPin ? computeDocumentHash({
      kind: "receipt",
      id,
      orgId,
      contactId: before.contactId,
      amountCents: before.amountCents,
      paymentMethod: before.paymentMethod,
      description: before.description,
      businessName: orgProfile.businessName,
      businessDocument: orgProfile.doc,
      businessDocumentType: orgProfile.docType,
      patientName: patientSnap,
      patientDocument: before.patientDocument,
      patientDocumentType: before.patientDocumentType,
      professionalName: profNameSnap,
      professionalRegistration: profRegSnap,
      professionalCouncil: profCouncilSnap,
      signedAt,
    }) : null;

    db.prepare(
      `UPDATE clinical_receipts
         SET status = 'issued',
             issued_by = ?, issued_at = CURRENT_TIMESTAMP,
             professional_name_snapshot = ?,
             professional_registration_snapshot = ?,
             professional_council_snapshot = ?,
             business_name_snapshot = ?,
             business_document_snapshot = ?,
             business_document_type_snapshot = ?,
             patient_name_snapshot = ?,
             signed_with_pin = ?,
             signature_hash = ?,
             signature_timestamp = ?,
             updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND organization_id = ?`
    ).run(
      actorId,
      profNameSnap, profRegSnap, profCouncilSnap,
      orgProfile.businessName, orgProfile.doc, orgProfile.docType,
      patientSnap,
      signedWithPin ? 1 : 0,
      signatureHash,
      signedWithPin ? signedAt : null,
      id, orgId
    );
    logAuthEvent(orgId, actorId, before.contactId, "CLINIC_RECEIPT_ISSUED", {
      receiptId: id, signedWithPin, signatureHash, amountCents: before.amountCents,
    });
    return this.getRaw(orgId, id)!;
  }

  /**
   * PDF do recibo. Cabeçalho verde teal (padrão Fase H), valor em destaque,
   * bloco "Recebi de", forma de pagamento, dados fiscais quando presentes,
   * bloco de assinatura do profissional, rodapé de assinatura eletrônica
   * quando `signedWithPin` (padrão Fase 16).
   * Rascunho ganha faixa vermelha "RASCUNHO — não vale como emitido".
   */
  static async renderPdf(orgId: string, id: string): Promise<Buffer> {
    const receipt = this.get(orgId, id); // gata consent
    if (!receipt) throw new Error("Recibo não encontrado.");

    const chunks: Buffer[] = [];
    const doc = new PDFDocument({ size: "A4", margins: { top: 48, bottom: 48, left: 48, right: 48 } });
    doc.on("data", (c: Buffer) => chunks.push(c));
    const finished = new Promise<void>((resolve) => doc.on("end", () => resolve()));

    // Header
    doc.rect(0, 0, doc.page.width, 60).fill("#0f766e");
    doc.fill("#ffffff").font("Helvetica-Bold").fontSize(18)
      .text(receipt.businessNameSnapshot || "Recibo de Consulta", 48, 20, { align: "left" });
    doc.moveDown(2);
    doc.fillColor("#111827");

    // Rascunho watermark
    if (receipt.status !== "issued") {
      doc.moveDown(0.5);
      doc.rect(48, doc.y, doc.page.width - 96, 24).fill("#dc2626");
      doc.fill("#ffffff").font("Helvetica-Bold").fontSize(11)
        .text("RASCUNHO — este documento não vale como recibo emitido", 48, doc.y - 20, { align: "center", width: doc.page.width - 96 });
      doc.moveDown(1.5);
      doc.fillColor("#111827");
    }

    // Título
    doc.font("Helvetica-Bold").fontSize(20).text("RECIBO", { align: "center" });
    doc.moveDown(0.6);

    // Valor em destaque
    doc.font("Helvetica-Bold").fontSize(26).fillColor("#0f766e")
      .text(formatBRL(receipt.amountCents), { align: "center" });
    doc.moveDown(0.8);
    doc.fillColor("#111827");

    // Corpo — "Recebi de …"
    const patientName = receipt.patientNameSnapshot || "paciente";
    const patientDocLine = receipt.patientDocument
      ? ` (${(receipt.patientDocumentType || "CPF").toUpperCase()} ${receipt.patientDocument})`
      : "";
    const businessLine = receipt.businessNameSnapshot
      ? (receipt.businessDocumentSnapshot
          ? `${receipt.businessNameSnapshot} (${(receipt.businessDocumentTypeSnapshot || "").toUpperCase()} ${receipt.businessDocumentSnapshot})`
          : receipt.businessNameSnapshot)
      : "prestador";
    const descLine = receipt.description || "Consulta clínica particular";
    doc.font("Helvetica").fontSize(11).text(
      `Recebi de ${patientName}${patientDocLine} a quantia de ${formatBRL(receipt.amountCents)} referente a "${descLine}", pago via ${PAYMENT_LABEL_PT[receipt.paymentMethod]}.`,
      { align: "justify" }
    );
    doc.moveDown(0.6);
    doc.font("Helvetica").fontSize(11).text(
      `Emitido por ${businessLine}.`
    );
    doc.moveDown(0.4);

    if (receipt.notes) {
      doc.font("Helvetica-Oblique").fontSize(10).fillColor("#374151").text(receipt.notes);
      doc.fillColor("#111827");
      doc.moveDown(0.6);
    }

    // Data legível
    const issuedIso = receipt.issuedAt || receipt.createdAt;
    doc.moveDown(0.8);
    doc.font("Helvetica").fontSize(11).text(`Data: ${longDateBR(issuedIso)}`, { align: "left" });

    // Bloco de assinatura do profissional (papel)
    drawSignatureBlock(doc, receipt.professionalNameSnapshot, receipt.professionalCouncilSnapshot, receipt.professionalRegistrationSnapshot);

    // Rodapé eletrônico (só se signedWithPin)
    drawElectronicSignatureFooter(doc, receipt.signatureHash, receipt.signatureTimestamp);

    doc.end();
    await finished;
    return Buffer.concat(chunks);
  }
}

export default ClinicReceiptService;
