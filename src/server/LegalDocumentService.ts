import { randomUUID } from "crypto";
import PDFDocument from "pdfkit";
import db from "./db.js";
import { logAuthEvent } from "./auditLog.js";
import {
  verifyPin, computeDocumentHash, longDateBR,
  drawSignatureBlock, drawElectronicSignatureFooter,
} from "./ClinicDocumentsService.js";

/**
 * Legal Document (ADR-191 F7) — DOCUMENTOS jurídicos (petição/contrato/procuração).
 *
 * COMPÕE a infra documental da clínica (D5), sem reescrever o motor: snapshot canônico
 * + hash SHA-256 (`computeDocumentHash`), assinatura por PIN (`verifyPin`) e rodapé de
 * assinatura eletrônica (`drawElectronicSignatureFooter`) são REUSADOS. Tabela própria
 * `legal_documents`, polimórfica por `doc_type` (o vocabulário jurídico difere do clínico).
 *
 * RN-ADV-06 (documento congelado): ao EMITIR, o doc congela os snapshots de nome do
 * cliente/negócio/advogado + hash — renomear qualquer um depois NÃO altera o documento
 * nem quebra a conferência. Emitido é IMUTÁVEL (update só em rascunho). Retenção: nunca
 * DELETE; cancelar é UPDATE status='cancelled'. Isolado por organization_id.
 */

const nowISO = () => new Date().toISOString();
const DOC_TYPES = new Set(["peticao", "contrato", "procuracao"]);
const DOC_LABEL: Record<string, string> = { peticao: "Petição", contrato: "Contrato", procuracao: "Procuração" };

function businessName(orgId: string): string {
  try { const o = db.prepare(`SELECT business_name FROM organization_settings WHERE organization_id = ?`).get(orgId) as any; return o?.business_name || "Meu escritório"; }
  catch { return "Meu escritório"; }
}
function clientName(orgId: string, contactId: string): string {
  const c = db.prepare(`SELECT name FROM contacts WHERE organization_id = ? AND id = ?`).get(orgId, contactId) as any;
  return c?.name || "Cliente";
}
function loadLawyer(orgId: string, id: string | null): any {
  if (!id) return null;
  return db.prepare(`SELECT id, name, council, registration_number FROM clinic_professionals WHERE organization_id = ? AND id = ?`).get(orgId, id) || null;
}

export interface LegalDocInput {
  caseId?: string | null;
  contactId?: string | null;
  professionalId?: string | null;
  docType: string;
  title: string;
  body?: string | null;
}

export class LegalDocumentService {
  static get(orgId: string, id: string): any {
    return db.prepare(`SELECT * FROM legal_documents WHERE organization_id = ? AND id = ?`).get(orgId, id) || null;
  }

  static list(orgId: string, opts: { caseId?: string; contactId?: string; docType?: string; status?: string } = {}): any[] {
    const clauses = [`organization_id = ?`]; const args: any[] = [orgId];
    if (opts.caseId) { clauses.push(`case_id = ?`); args.push(opts.caseId); }
    if (opts.contactId) { clauses.push(`contact_id = ?`); args.push(opts.contactId); }
    if (opts.docType) { clauses.push(`doc_type = ?`); args.push(opts.docType); }
    if (opts.status) { clauses.push(`status = ?`); args.push(opts.status); }
    return db.prepare(`SELECT * FROM legal_documents WHERE ${clauses.join(" AND ")} ORDER BY (status = 'cancelled') ASC, created_at DESC`).all(...args) as any[];
  }

  /** Cria um documento em RASCUNHO. Cliente vem do processo (se houver) ou do contactId. */
  static createDraft(orgId: string, input: LegalDocInput, actorId: string | null = null): any {
    const docType = String(input?.docType || "");
    if (!DOC_TYPES.has(docType)) throw new Error(`Tipo de documento inválido: ${docType}.`);
    const title = String(input?.title || "").trim();
    if (!title) throw new Error("Dê um título ao documento.");

    let contactId = input.contactId || null;
    let caseRow: any = null;
    if (input.caseId) {
      caseRow = db.prepare(`SELECT id, contact_id, responsible_lawyer_id FROM legal_cases WHERE organization_id = ? AND id = ?`).get(orgId, input.caseId) as any;
      if (!caseRow) throw new Error("Processo não encontrado.");
      contactId = caseRow.contact_id; // cliente do documento é sempre o do processo (nunca inventado)
    }
    if (!contactId) throw new Error("Informe o cliente (contactId) ou um processo.");
    const contact = db.prepare(`SELECT id FROM contacts WHERE organization_id = ? AND id = ?`).get(orgId, contactId) as any;
    if (!contact) throw new Error("Cliente não encontrado.");

    const professionalId = input.professionalId || caseRow?.responsible_lawyer_id || null;
    if (professionalId && !loadLawyer(orgId, professionalId)) throw new Error("Advogado não encontrado.");

    const id = randomUUID();
    db.prepare(
      `INSERT INTO legal_documents (id, organization_id, case_id, contact_id, professional_id, doc_type, title, body, status, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?)`
    ).run(id, orgId, input.caseId || null, contactId, professionalId, docType, title, input.body ? String(input.body) : null, actorId);
    logAuthEvent(orgId, actorId, contactId, "LEGAL_DOCUMENT_CREATED", { documentId: id, docType, caseId: input.caseId || null });
    return this.get(orgId, id);
  }

  /** Edita o RASCUNHO. RN-ADV-06: documento emitido é imutável. */
  static update(orgId: string, id: string, patch: { title?: string; body?: string | null; professionalId?: string | null }, actorId: string | null = null): any {
    const d = this.get(orgId, id);
    if (!d) throw new Error("Documento não encontrado.");
    if (d.status !== "draft") throw new Error("Documento emitido é imutável — só rascunho pode ser editado.");
    const title = patch.title !== undefined ? String(patch.title || "").trim() : d.title;
    if (!title) throw new Error("Título não pode ficar vazio.");
    let professionalId = d.professional_id;
    if (patch.professionalId !== undefined) {
      professionalId = patch.professionalId || null;
      if (professionalId && !loadLawyer(orgId, professionalId)) throw new Error("Advogado não encontrado.");
    }
    db.prepare(`UPDATE legal_documents SET title = ?, body = ?, professional_id = ?, updated_at = ? WHERE organization_id = ? AND id = ?`)
      .run(title, patch.body !== undefined ? (patch.body ? String(patch.body) : null) : d.body, professionalId, nowISO(), orgId, id);
    return this.get(orgId, id);
  }

  /** EMITE o documento: congela snapshots + hash canônico + assinatura por PIN (RN-ADV-06). */
  static issue(orgId: string, id: string, actorId: string | null = null, opts: { pin?: string } = {}): any {
    const d = this.get(orgId, id);
    if (!d) throw new Error("Documento não encontrado.");
    if (d.status === "issued") return d;
    if (d.status === "cancelled") throw new Error("Documento cancelado não pode ser emitido.");
    if (!String(d.body || "").trim()) throw new Error("Documento sem conteúdo — não pode ser emitido.");

    const lawyer = loadLawyer(orgId, d.professional_id);
    const nameSnap = lawyer?.name || null;
    const regSnap = lawyer?.registration_number || null;
    const councilSnap = lawyer?.council || null;
    const clientSnap = clientName(orgId, d.contact_id);
    const bizSnap = businessName(orgId);

    const signedWithPin = verifyPin(orgId, d.professional_id, opts.pin);
    const signedAt = nowISO();
    // Hash canônico da assinatura eletrônica — só quando o PIN foi conferido (compat sem PIN).
    const signatureHash = signedWithPin ? computeDocumentHash({
      kind: "legal_document", docType: d.doc_type, id, orgId,
      contactId: d.contact_id, clientName: clientSnap, businessName: bizSnap,
      professionalName: nameSnap, professionalRegistration: regSnap, professionalCouncil: councilSnap,
      title: d.title, body: d.body, signedAt,
    }) : null;

    db.prepare(
      `UPDATE legal_documents SET status = 'issued', issued_by = ?, issued_at = ?,
         client_name_snapshot = ?, business_name_snapshot = ?, professional_name_snapshot = ?,
         professional_registration_snapshot = ?, professional_council_snapshot = ?,
         signed_with_pin = ?, signature_hash = ?, signature_timestamp = ?, updated_at = ?
       WHERE organization_id = ? AND id = ?`
    ).run(actorId, signedAt, clientSnap, bizSnap, nameSnap, regSnap, councilSnap,
      signedWithPin ? 1 : 0, signatureHash, signedWithPin ? signedAt : null, signedAt, orgId, id);
    logAuthEvent(orgId, actorId, d.contact_id, "LEGAL_DOCUMENT_ISSUED", { documentId: id, docType: d.doc_type, signedWithPin, signatureHash });
    return this.get(orgId, id);
  }

  /** Cancela (retenção: nunca DELETE). */
  static cancel(orgId: string, id: string, reason: string | null = null, actorId: string | null = null): any {
    const d = this.get(orgId, id);
    if (!d) throw new Error("Documento não encontrado.");
    if (d.status === "cancelled") return d;
    db.prepare(`UPDATE legal_documents SET status = 'cancelled', cancelled_at = ?, cancelled_reason = ?, updated_at = ? WHERE organization_id = ? AND id = ?`)
      .run(nowISO(), reason || null, nowISO(), orgId, id);
    logAuthEvent(orgId, actorId, d.contact_id, "LEGAL_DOCUMENT_CANCELLED", { documentId: id, reason });
    return this.get(orgId, id);
  }

  /** PDF do documento. Emitido re-lê snapshots imutáveis; rascunho usa dados live + marca-d'água. */
  static renderPdf(orgId: string, id: string): Promise<Buffer> {
    const d = this.get(orgId, id);
    if (!d) throw new Error("Documento não encontrado.");
    const issued = d.status === "issued";
    const biz = issued && d.business_name_snapshot ? d.business_name_snapshot : businessName(orgId);
    const client = issued && d.client_name_snapshot ? d.client_name_snapshot : clientName(orgId, d.contact_id);
    const dateStr = issued && d.issued_at ? longDateBR(d.issued_at) : longDateBR();
    const label = DOC_LABEL[d.doc_type] || "Documento";

    return new Promise((resolve, reject) => {
      try {
        const doc = new PDFDocument({ size: "A4", margin: 48 });
        const chunks: Buffer[] = [];
        doc.on("data", (c: Buffer) => chunks.push(c));
        doc.on("end", () => resolve(Buffer.concat(chunks)));
        doc.on("error", reject);

        doc.fillColor("#3730a3").font("Helvetica-Bold").fontSize(20).text(biz);
        doc.fillColor("#111827").fontSize(15).text(label);
        doc.fillColor("#6b7280").font("Helvetica").fontSize(9).text(dateStr);
        if (!issued) doc.fillColor("#b91c1c").font("Helvetica-Bold").fontSize(10).text(`RASCUNHO — não vale como documento emitido`);
        doc.moveDown(0.6);

        doc.fillColor("#111827").font("Helvetica-Bold").fontSize(13).text(d.title);
        doc.moveDown(0.3);
        doc.font("Helvetica-Bold").fontSize(11).text(`Cliente: `, { continued: true }).font("Helvetica").text(client);
        doc.moveDown(0.6);

        doc.font("Helvetica").fontSize(11).fillColor("#1f2937").text(String(d.body || ""), { align: "justify" });

        drawSignatureBlock(doc, d.professional_name_snapshot || null, d.professional_council_snapshot || null, d.professional_registration_snapshot || null);
        drawElectronicSignatureFooter(doc, d.signature_hash || null, d.signature_timestamp || null);
        doc.end();
      } catch (e) { reject(e as any); }
    });
  }
}

export default LegalDocumentService;
