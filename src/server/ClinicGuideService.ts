/**
 * Módulo Clínica — GUIA DA RECEPÇÃO (ADR-145 D7, Fatia 44).
 *
 * Documento administrativo polimorfo emitido pela recepção. Cliente
 * confirmou 2026-07: 3 tipos suportados na mesma tabela:
 *
 *   - tiss_authorization: guia TISS de autorização de procedimento
 *     (operadora + TUSS + total_sessions + autorização + validade).
 *     Alimenta faturamento do convênio (a Fatia 46 liga com
 *     procedure_authorization_requests).
 *
 *   - referral: encaminhamento pra outro especialista (specialty destino,
 *     CRM médico solicitante, motivo, urgência opcional).
 *
 *   - medical_order: pedido médico de exames/procedimentos (items[],
 *     justificativa clínica, CID via Fatia 23, validade).
 *
 * Campos específicos por tipo vão em `snapshot_json` — cada tipo tem seu
 * schema mínimo validado aqui (JSON, não coluna, evita ALTER futuro por
 * variação de campo).
 *
 * Estados: draft → issued → (submitted → approved | denied) | expired
 * | cancelled. Emitida vira IMUTÁVEL nos campos congelados (snapshot +
 * document_hash canônico da Fase 29). Rascunho editável.
 *
 * Numeração `internal_number` UNIQUE por (org, guide_type) — cada tipo
 * tem sua própria série (ex.: TISS-000123, REF-000045, PM-000078).
 *
 * Sem PDF nem envio ainda (Fatia 45). Sem integração com autorização/
 * ciclo (Fatia 46). Isolamento por organization_id. Audit no padrão
 * das Fases 26/27/33 (`logAuthEvent`).
 */
import { randomUUID } from "node:crypto";
import PDFDocument from "pdfkit";
import db from "./db.js";
import { logAuthEvent } from "./auditLog.js";
import { canonicalize, computeDocumentHash } from "./ClinicDocumentsService.js";

export type GuideType = "tiss_authorization" | "referral" | "medical_order";
export type GuideStatus = "draft" | "issued" | "submitted" | "approved" | "denied" | "expired" | "cancelled";

const GUIDE_TYPES: GuideType[] = ["tiss_authorization", "referral", "medical_order"];

/** Prefixo de numeração por tipo (ex.: TISS-000123). */
const GUIDE_NUMBER_PREFIX: Record<GuideType, string> = {
  tiss_authorization: "TISS",
  referral: "REF",
  medical_order: "PM",
};

export interface ClinicalGuide {
  id: string;
  organizationId: string;
  internalNumber: string;
  guideType: GuideType;
  contactId: string;
  episodeId: string | null;
  cycleId: string | null;
  authorizationId: string | null;
  operatorId: string | null;
  procedureId: string | null;
  professionalId: string | null;
  totalSessions: number | null;
  validFrom: string | null;
  validUntil: string | null;
  status: GuideStatus;
  snapshotJson: any | null;
  pdfStorageKey: string | null;
  documentHash: string | null;
  connectorType: string | null;
  cancelledReason: string | null;
  cancelledAt: string | null;
  issuedBy: string | null;
  issuedAt: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface GuideCreateInput {
  guideType: GuideType;
  contactId: string;
  episodeId?: string | null;
  cycleId?: string | null;
  authorizationId?: string | null;
  operatorId?: string | null;
  procedureId?: string | null;
  professionalId?: string | null;
  totalSessions?: number | null;
  validFrom?: string | null;
  validUntil?: string | null;
  /** Campos específicos por tipo — vão em snapshot_json. */
  fields?: Record<string, any>;
}

export interface GuidePatch {
  operatorId?: string | null;
  procedureId?: string | null;
  professionalId?: string | null;
  totalSessions?: number | null;
  validFrom?: string | null;
  validUntil?: string | null;
  authorizationId?: string | null;
  fields?: Record<string, any>;
}

function hydrate(r: any): ClinicalGuide | null {
  if (!r) return null;
  let snapshot: any = null;
  if (r.snapshot_json) {
    try { snapshot = JSON.parse(r.snapshot_json); } catch { snapshot = null; }
  }
  return {
    id: r.id,
    organizationId: r.organization_id,
    internalNumber: r.internal_number,
    guideType: r.guide_type,
    contactId: r.contact_id,
    episodeId: r.episode_id ?? null,
    cycleId: r.cycle_id ?? null,
    authorizationId: r.authorization_id ?? null,
    operatorId: r.operator_id ?? null,
    procedureId: r.procedure_id ?? null,
    professionalId: r.professional_id ?? null,
    totalSessions: r.total_sessions != null ? Number(r.total_sessions) : null,
    validFrom: r.valid_from ?? null,
    validUntil: r.valid_until ?? null,
    status: r.status,
    snapshotJson: snapshot,
    pdfStorageKey: r.pdf_storage_key ?? null,
    documentHash: r.document_hash ?? null,
    connectorType: r.connector_type ?? null,
    cancelledReason: r.cancelled_reason ?? null,
    cancelledAt: r.cancelled_at ?? null,
    issuedBy: r.issued_by ?? null,
    issuedAt: r.issued_at ?? null,
    createdBy: r.created_by ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** Validação polimorfa mínima por tipo. Lança com msg clara. */
function validateFieldsForType(guideType: GuideType, input: GuideCreateInput, requireIssueFields = false): void {
  const f = input.fields || {};
  if (guideType === "tiss_authorization") {
    if (requireIssueFields) {
      if (!input.operatorId) throw new Error("operatorId é obrigatório na emissão de guia TISS.");
      if (!input.procedureId) throw new Error("procedureId é obrigatório na emissão de guia TISS.");
      const total = Number(input.totalSessions);
      if (!Number.isFinite(total) || total < 1) throw new Error("totalSessions ≥ 1 é obrigatório na emissão de guia TISS.");
    }
    return;
  }
  if (guideType === "referral") {
    if (requireIssueFields) {
      const specName = String(f.referralSpecialty || "").trim();
      const reason = String(f.referralReason || "").trim();
      if (!specName) throw new Error("fields.referralSpecialty é obrigatório na emissão de encaminhamento.");
      if (reason.length < 3) throw new Error("fields.referralReason (min 3 chars) é obrigatório na emissão de encaminhamento.");
    }
    return;
  }
  if (guideType === "medical_order") {
    if (requireIssueFields) {
      const items = Array.isArray(f.items) ? f.items : [];
      if (items.length < 1) throw new Error("fields.items (≥1) é obrigatório na emissão de pedido médico.");
      const bad = items.find((it: any) => !String(it?.description || "").trim());
      if (bad) throw new Error("fields.items[*].description é obrigatório em cada item.");
    }
    return;
  }
  throw new Error(`guideType inválido: ${guideType}. Aceitos: ${GUIDE_TYPES.join(", ")}.`);
}

function nextSequenceNumber(orgId: string, guideType: GuideType): string {
  // Conta atuais desse tipo pra atribuir o próximo N (base 1). O UNIQUE
  // constraint em (org, internal_number) protege contra race — create
  // captura SQLITE_CONSTRAINT_UNIQUE e retenta.
  const row = db.prepare(
    `SELECT COUNT(*) AS c FROM clinical_guides
      WHERE organization_id = ? AND guide_type = ?`
  ).get(orgId, guideType) as any;
  const next = Number(row?.c || 0) + 1;
  const prefix = GUIDE_NUMBER_PREFIX[guideType];
  return `${prefix}-${String(next).padStart(6, "0")}`;
}

function loadContactOrThrow(orgId: string, contactId: string): { id: string; name: string | null } {
  const row = db.prepare(`SELECT id, name FROM contacts WHERE organization_id = ? AND id = ?`).get(orgId, contactId) as any;
  if (!row) throw new Error("Paciente não encontrado.");
  return { id: row.id, name: row.name ?? null };
}

function loadOptionalEpisode(orgId: string, episodeId?: string | null): { id: string; contact_id: string; specialty_id: string } | null {
  if (!episodeId) return null;
  const row = db.prepare(
    `SELECT id, contact_id, specialty_id, status FROM clinic_care_episodes
      WHERE organization_id = ? AND id = ?`
  ).get(orgId, episodeId) as any;
  if (!row) throw new Error("Episódio de cuidado não encontrado.");
  return { id: row.id, contact_id: row.contact_id, specialty_id: row.specialty_id };
}

function loadOptionalCycle(orgId: string, cycleId?: string | null): { id: string; episode_id: string } | null {
  if (!cycleId) return null;
  const row = db.prepare(
    `SELECT id, episode_id FROM clinic_treatment_cycles
      WHERE organization_id = ? AND id = ?`
  ).get(orgId, cycleId) as any;
  if (!row) throw new Error("Ciclo não encontrado.");
  return { id: row.id, episode_id: row.episode_id };
}

export class ClinicGuideService {
  // ── Leitura ────────────────────────────────────────────────────────────

  static get(orgId: string, id: string): ClinicalGuide | null {
    const r = db.prepare(`SELECT * FROM clinical_guides WHERE organization_id = ? AND id = ?`).get(orgId, id) as any;
    return hydrate(r);
  }

  static list(orgId: string, opts: { contactId?: string; status?: GuideStatus; guideType?: GuideType; limit?: number } = {}): ClinicalGuide[] {
    const where: string[] = ["organization_id = ?"];
    const params: any[] = [orgId];
    if (opts.contactId) { where.push("contact_id = ?"); params.push(opts.contactId); }
    if (opts.status) { where.push("status = ?"); params.push(opts.status); }
    if (opts.guideType) { where.push("guide_type = ?"); params.push(opts.guideType); }
    const limit = Math.max(1, Math.min(500, Number(opts.limit) || 100));
    const rows = db.prepare(
      `SELECT * FROM clinical_guides WHERE ${where.join(" AND ")}
        ORDER BY created_at DESC, rowid DESC LIMIT ?`
    ).all(...params, limit) as any[];
    return rows.map((r) => hydrate(r)!).filter(Boolean);
  }

  // ── Create (draft) ─────────────────────────────────────────────────────

  static create(orgId: string, input: GuideCreateInput, actorId: string | null = null): ClinicalGuide {
    if (!GUIDE_TYPES.includes(input.guideType)) {
      throw new Error(`guideType inválido. Aceitos: ${GUIDE_TYPES.join(", ")}.`);
    }
    if (!input.contactId) throw new Error("contactId é obrigatório.");
    loadContactOrThrow(orgId, input.contactId);

    // Episódio/ciclo, se vieram, precisam ser da mesma org + pertencer ao contact
    const episode = loadOptionalEpisode(orgId, input.episodeId);
    if (episode && episode.contact_id !== input.contactId) {
      throw new Error("Episódio pertence a outro paciente.");
    }
    const cycle = loadOptionalCycle(orgId, input.cycleId);
    if (cycle && episode && cycle.episode_id !== episode.id) {
      throw new Error("Ciclo pertence a outro episódio.");
    }

    // Validação polimorfa "leve" no draft (só formatos, não obrigatoriedade).
    validateFieldsForType(input.guideType, input, false);

    // Numeração: atribui um internal_number provisório aqui (será usado se
    // for emitida). Como o UNIQUE é (org, internal_number), dois drafts do
    // mesmo tipo tentam mesmo N — o retry captura e re-atribui.
    let internalNumber = nextSequenceNumber(orgId, input.guideType);
    const id = randomUUID();
    const snapshotJson = input.fields ? JSON.stringify(canonicalize(input.fields)) : null;

    // Retry simples: 5 tentativas cobre 5 drafts simultâneos do mesmo tipo
    // sendo criados (raríssimo). Além disso a Fatia 46 pode usar SELECT MAX
    // + increment como fallback.
    let saved = false;
    for (let attempt = 0; attempt < 5 && !saved; attempt++) {
      try {
        db.prepare(
          `INSERT INTO clinical_guides
             (id, organization_id, internal_number, guide_type, contact_id,
              episode_id, cycle_id, authorization_id, operator_id, procedure_id,
              professional_id, total_sessions, valid_from, valid_until,
              status, snapshot_json, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`
        ).run(
          id, orgId, internalNumber, input.guideType, input.contactId,
          input.episodeId || null, input.cycleId || null,
          input.authorizationId || null, input.operatorId || null,
          input.procedureId || null, input.professionalId || null,
          input.totalSessions ?? null, input.validFrom || null, input.validUntil || null,
          snapshotJson, actorId
        );
        saved = true;
      } catch (e: any) {
        if (String(e?.message || "").includes("UNIQUE") || e?.code === "SQLITE_CONSTRAINT_UNIQUE") {
          internalNumber = nextSequenceNumber(orgId, input.guideType);
          continue;
        }
        throw e;
      }
    }
    if (!saved) throw new Error("Não foi possível atribuir número interno único após 5 tentativas.");

    logAuthEvent(orgId, actorId, input.contactId, "CLINIC_GUIDE_CREATED", {
      guideId: id, guideType: input.guideType, internalNumber,
      episodeId: input.episodeId || null, cycleId: input.cycleId || null,
    });
    return this.get(orgId, id)!;
  }

  // ── Update (só draft) ──────────────────────────────────────────────────

  static update(orgId: string, id: string, patch: GuidePatch, actorId: string | null = null): ClinicalGuide {
    const cur = this.get(orgId, id);
    if (!cur) throw new Error("Guia não encontrada.");
    if (cur.status !== "draft") {
      const e: any = new Error("Guia emitida — não pode ser editada. Cancele e crie uma nova.");
      e.code = "GUIDE_NOT_EDITABLE"; throw e;
    }

    const patches: string[] = [];
    const params: any[] = [];
    if (patch.operatorId !== undefined) { patches.push("operator_id = ?"); params.push(patch.operatorId || null); }
    if (patch.procedureId !== undefined) { patches.push("procedure_id = ?"); params.push(patch.procedureId || null); }
    if (patch.professionalId !== undefined) { patches.push("professional_id = ?"); params.push(patch.professionalId || null); }
    if (patch.totalSessions !== undefined) {
      const n = patch.totalSessions == null ? null : Number(patch.totalSessions);
      if (n != null && (!Number.isFinite(n) || n < 1 || n > 200)) {
        throw new Error("totalSessions deve estar entre 1 e 200.");
      }
      patches.push("total_sessions = ?"); params.push(n);
    }
    if (patch.validFrom !== undefined) { patches.push("valid_from = ?"); params.push(patch.validFrom || null); }
    if (patch.validUntil !== undefined) { patches.push("valid_until = ?"); params.push(patch.validUntil || null); }
    if (patch.authorizationId !== undefined) { patches.push("authorization_id = ?"); params.push(patch.authorizationId || null); }
    if (patch.fields !== undefined) {
      const snap = patch.fields ? JSON.stringify(canonicalize(patch.fields)) : null;
      patches.push("snapshot_json = ?"); params.push(snap);
    }
    if (!patches.length) return cur;
    patches.push("updated_at = CURRENT_TIMESTAMP");
    db.prepare(`UPDATE clinical_guides SET ${patches.join(", ")} WHERE organization_id = ? AND id = ?`)
      .run(...params, orgId, id);
    logAuthEvent(orgId, actorId, cur.contactId, "CLINIC_GUIDE_UPDATED", {
      guideId: id, changes: Object.keys(patch),
    });
    return this.get(orgId, id)!;
  }

  // ── Issue (draft → issued, congela snapshot + hash) ────────────────────

  /**
   * Emite a guia. Regras:
   *   - Status atual precisa ser 'draft'.
   *   - Validação polimorfa por tipo em modo "issue" (mais rígida).
   *   - Congela snapshot rico: paciente/negócio/profissional/plano + campos
   *     específicos por tipo (fields). Nome do paciente/negócio no snapshot
   *     → PDF (Fatia 45) usa o congelado, não faz lookup live (imutável).
   *   - Calcula document_hash canônico (padrão Fase 29).
   *   - status='issued', issued_at=now, issued_by=actorId.
   *   - Audit CLINIC_GUIDE_ISSUED com internalNumber + hash truncado.
   */
  static issue(orgId: string, id: string, actorId: string | null = null): ClinicalGuide {
    const cur = this.get(orgId, id);
    if (!cur) throw new Error("Guia não encontrada.");
    if (cur.status !== "draft") {
      const e: any = new Error(`Guia com status ${cur.status} não pode ser emitida.`);
      e.code = "GUIDE_NOT_ISSUABLE"; e.status = cur.status; throw e;
    }
    validateFieldsForType(cur.guideType, {
      guideType: cur.guideType,
      contactId: cur.contactId,
      operatorId: cur.operatorId,
      procedureId: cur.procedureId,
      totalSessions: cur.totalSessions,
      fields: cur.snapshotJson || {},
    }, true);

    // Snapshot rico congelado. Nomes puxados AGORA (issue) — depois de
    // emitida, renomear contact/business/professional NÃO afeta guia.
    const contact = db.prepare(`SELECT name FROM contacts WHERE organization_id = ? AND id = ?`).get(orgId, cur.contactId) as any;
    const org = db.prepare(`SELECT business_name FROM organization_settings WHERE organization_id = ?`).get(orgId) as any;
    const prof = cur.professionalId
      ? db.prepare(`SELECT name, council, registration_number FROM clinic_professionals WHERE organization_id = ? AND id = ?`).get(orgId, cur.professionalId) as any
      : null;
    const patientProfile = db.prepare(`SELECT cpf, insurance_card_number FROM patient_profiles WHERE organization_id = ? AND contact_id = ?`).get(orgId, cur.contactId) as any;

    const snapshot = {
      guideType: cur.guideType,
      internalNumber: cur.internalNumber,
      patient: {
        name: contact?.name || null,
        cpf: patientProfile?.cpf || null,
        insuranceCardNumber: patientProfile?.insurance_card_number || null,
      },
      business: { name: org?.business_name || "Clínica" },
      professional: prof ? {
        name: prof.name || null,
        council: prof.council || null,
        registrationNumber: prof.registration_number || null,
      } : null,
      operatorId: cur.operatorId,
      procedureId: cur.procedureId,
      totalSessions: cur.totalSessions,
      validFrom: cur.validFrom,
      validUntil: cur.validUntil,
      fields: cur.snapshotJson || {},
    };
    const documentHash = computeDocumentHash(snapshot);

    db.prepare(
      `UPDATE clinical_guides
          SET status='issued', snapshot_json=?, document_hash=?,
              issued_by=?, issued_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
        WHERE id=? AND organization_id=?`
    ).run(JSON.stringify(canonicalize(snapshot)), documentHash, actorId, id, orgId);

    logAuthEvent(orgId, actorId, cur.contactId, "CLINIC_GUIDE_ISSUED", {
      guideId: id, guideType: cur.guideType, internalNumber: cur.internalNumber,
      documentHashPrefix: documentHash.slice(0, 12),
    });

    // Fatia 46 hook (ADR-145 RN-005 §8): se a guia sendo emitida tem
    // cycle_id preenchido e o ciclo está pending_authorization, ativa o
    // ciclo automaticamente. Import dinâmico evita ciclo de import
    // (TreatmentCycleService → GuideService pra linkGuide).
    if (cur.cycleId) {
      import("./ClinicTreatmentCycleService.js").then((m) => {
        try { m.ClinicTreatmentCycleService.transitionOnGuideIssued(orgId, id); }
        catch (err) { console.error("[Clínica] transition on guide issued falhou", id, err); }
      });
    }

    return this.get(orgId, id)!;
  }

  // ── Cancel ─────────────────────────────────────────────────────────────

  /**
   * Cancela draft ou issued. Cancelamento de issued preserva o snapshot
   * imutável — a linha continua no banco (retenção CFM 20 anos + evita
   * quebrar histórico). Idempotente.
   */
  static cancel(orgId: string, id: string, input: { reason: string }, actorId: string | null = null): ClinicalGuide {
    const cur = this.get(orgId, id);
    if (!cur) throw new Error("Guia não encontrada.");
    if (cur.status === "cancelled") return cur;
    if (cur.status !== "draft" && cur.status !== "issued") {
      const e: any = new Error(`Guia com status ${cur.status} não pode ser cancelada.`);
      e.code = "GUIDE_NOT_CANCELLABLE"; throw e;
    }
    const reason = String(input.reason || "").trim();
    if (!reason) throw new Error("Motivo do cancelamento é obrigatório.");

    db.prepare(
      `UPDATE clinical_guides
          SET status='cancelled', cancelled_at=CURRENT_TIMESTAMP, cancelled_reason=?, updated_at=CURRENT_TIMESTAMP
        WHERE id=? AND organization_id=?`
    ).run(reason, id, orgId);
    logAuthEvent(orgId, actorId, cur.contactId, "CLINIC_GUIDE_CANCELLED", {
      guideId: id, guideType: cur.guideType, previousStatus: cur.status,
    });
    return this.get(orgId, id)!;
  }

  // ── PDF polimorfo (ADR-145 Fatia 45) ───────────────────────────────────

  /**
   * Renderiza o PDF da guia. Só emite quando issued (rascunho falha).
   * O PDF sempre é IGUAL após emissão (usa snapshot congelado — Fase 29).
   * Layout diferente por guide_type:
   *   - tiss_authorization: cabeçalho operadora + carteirinha + TUSS +
   *     total_sessions + validade + CRM prof.
   *   - referral: especialidade destino + motivo + CRM médico solicitante.
   *   - medical_order: lista items[] + CID (via snapshot.fields) +
   *     justificativa clínica + validade.
   * Todos: cabeçalho comum (business_name + internal_number + data
   * emissão) + rodapé (document_hash truncado 12 chars pra auditoria).
   */
  static renderPdf(orgId: string, guideId: string): Promise<Buffer> {
    const guide = this.get(orgId, guideId);
    if (!guide) throw new Error("Guia não encontrada.");
    if (guide.status !== "issued" && guide.status !== "submitted" &&
        guide.status !== "approved" && guide.status !== "denied" &&
        guide.status !== "expired") {
      const e: any = new Error(`Guia com status ${guide.status} não tem PDF disponível.`);
      e.code = "GUIDE_NOT_ISSUED"; throw e;
    }
    const snap = guide.snapshotJson || {};
    const fields = snap.fields || {};
    const patient = snap.patient || {};
    const business = snap.business || { name: "Clínica" };
    const professional = snap.professional || null;

    return new Promise<Buffer>((resolve, reject) => {
      try {
        const doc = new PDFDocument({ size: "A4", margin: 48 });
        const chunks: Buffer[] = [];
        doc.on("data", (b: Buffer) => chunks.push(b));
        doc.on("end", () => resolve(Buffer.concat(chunks)));
        doc.on("error", reject);

        // ── Cabeçalho comum ─────────────────────────────────────────────
        doc.font("Helvetica-Bold").fontSize(16).fillColor("#0f766e").text(business.name || "Clínica", { align: "left" });
        doc.moveDown(0.1);
        const titleByType = {
          tiss_authorization: "Guia de Autorização (Convênio)",
          referral: "Encaminhamento Médico",
          medical_order: "Pedido Médico",
        } as const;
        doc.font("Helvetica-Bold").fontSize(13).fillColor("#111827")
          .text(titleByType[guide.guideType] || "Guia");
        doc.moveDown(0.1);
        doc.font("Helvetica").fontSize(9).fillColor("#6b7280")
          .text(`Nº ${guide.internalNumber} · Emitida em ${(guide.issuedAt || "").slice(0, 10)}`);
        doc.moveDown(0.8);

        // ── Bloco Paciente (comum) ──────────────────────────────────────
        writeSectionTitle(doc, "Paciente");
        writeKV(doc, [
          ["Nome", patient.name || "—"],
          ...(patient.cpf ? [["CPF", patient.cpf] as [string, string]] : []),
          ...(patient.insuranceCardNumber ? [["Carteirinha", patient.insuranceCardNumber] as [string, string]] : []),
        ]);

        // ── Bloco Profissional (comum, se veio) ─────────────────────────
        if (professional) {
          writeSectionTitle(doc, "Profissional solicitante");
          const profReg = [professional.council, professional.registrationNumber].filter(Boolean).join(" ");
          writeKV(doc, [
            ["Nome", professional.name || "—"],
            ...(profReg ? [["Registro", profReg] as [string, string]] : []),
          ]);
        }

        // ── Bloco específico por tipo ───────────────────────────────────
        if (guide.guideType === "tiss_authorization") {
          writeSectionTitle(doc, "Autorização de convênio");
          writeKV(doc, [
            ...(snap.operatorId ? [["Operadora (ID)", snap.operatorId] as [string, string]] : []),
            ...(snap.procedureId ? [["Procedimento (ID)", snap.procedureId] as [string, string]] : []),
            ...(snap.totalSessions ? [["Sessões autorizadas", String(snap.totalSessions)] as [string, string]] : []),
            ...(snap.validFrom ? [["Válida de", snap.validFrom.slice(0, 10)] as [string, string]] : []),
            ...(snap.validUntil ? [["Válida até", snap.validUntil.slice(0, 10)] as [string, string]] : []),
            ...(fields.authorizationNumber ? [["Nº autorização", String(fields.authorizationNumber)] as [string, string]] : []),
          ]);
        } else if (guide.guideType === "referral") {
          writeSectionTitle(doc, "Encaminhamento");
          writeKV(doc, [
            ["Especialidade destino", String(fields.referralSpecialty || "—")],
            ...(fields.urgency ? [["Urgência", String(fields.urgency)] as [string, string]] : []),
          ]);
          if (fields.referralReason) {
            doc.moveDown(0.4);
            doc.font("Helvetica-Bold").fontSize(10).fillColor("#374151").text("Motivo do encaminhamento:");
            doc.font("Helvetica").fontSize(10).fillColor("#111827").text(String(fields.referralReason), { align: "justify" });
          }
        } else if (guide.guideType === "medical_order") {
          writeSectionTitle(doc, "Pedido médico");
          const items = Array.isArray(fields.items) ? fields.items : [];
          for (let i = 0; i < items.length; i++) {
            const it = items[i];
            const y = doc.y;
            doc.font("Helvetica-Bold").fontSize(10).fillColor("#374151").text(`${i + 1}.`, 48, y, { width: 20 });
            doc.font("Helvetica").fontSize(10).fillColor("#111827")
              .text(String(it?.description || "—"), 72, y, { width: 470 });
            if (it?.quantity || it?.notes) {
              const extra: string[] = [];
              if (it.quantity) extra.push(`Qtd: ${it.quantity}`);
              if (it.notes) extra.push(String(it.notes));
              doc.font("Helvetica-Oblique").fontSize(9).fillColor("#6b7280")
                .text(extra.join(" · "), 72, doc.y, { width: 470 });
            }
            doc.moveDown(0.3);
          }
          if (fields.cid || fields.clinicalJustification) {
            doc.moveDown(0.4);
            if (fields.cid) writeKV(doc, [["CID", String(fields.cid)]]);
            if (fields.clinicalJustification) {
              doc.font("Helvetica-Bold").fontSize(10).fillColor("#374151").text("Justificativa clínica:");
              doc.font("Helvetica").fontSize(10).fillColor("#111827")
                .text(String(fields.clinicalJustification), { align: "justify" });
            }
          }
          if (snap.validUntil) writeKV(doc, [["Válida até", snap.validUntil.slice(0, 10)]]);
        }

        // ── Rodapé (document_hash truncado) ─────────────────────────────
        doc.moveDown(1.5);
        doc.font("Helvetica-Oblique").fontSize(8).fillColor("#6b7280")
          .text(`Documento emitido por ${business.name} · Verificação: ${(guide.documentHash || "").slice(0, 12)}`, { align: "center" });

        doc.end();
      } catch (e) { reject(e); }
    });
  }

  // ── Rascunho pré-preenchido (ADR-145 Fase 5 §F48) ──────────────────────

  /**
   * Devolve um "rascunho" de guia — objeto EM MEMÓRIA, NÃO persiste — com
   * campos preenchidos a partir de fontes existentes (patient_profiles,
   * plano corrente, guia anterior do mesmo episódio, ciclo). Campos sem
   * fonte viram `{value:null, missing:true, reason:"..."}` — a UI mostra
   * o que falta e a recepção decide se preenche à mão antes de chamar
   * `create()` (Fatia 44).
   *
   * GUARDRAILS (RN-014 §Fase 5) — IA NUNCA fabrica:
   *   - TUSS: só puxa de `procedure_authorization_requests.tuss_code` ou
   *     de guia anterior do mesmo episódio. Sem fonte → missing.
   *   - Carteirinha: só de `patient_profiles.insurance_card_number`.
   *   - Número de autorização: só de authorization existente. Sem →
   *     missing (o convênio precisa emitir; IA não gera).
   *   - Data de validade: nunca chuta. Sem fonte → missing.
   *   - Operadora: só se paciente tem plano; sem plano → missing.
   *
   * O objeto retornado NÃO é uma guia — é uma "sugestão" que a UI usa
   * pra pré-popular o formulário. `create()` continua exigindo os campos
   * obrigatórios; se algum vier missing, a UI bloqueia o submit.
   */
  static draft(orgId: string, input: {
    guideType: GuideType;
    contactId: string;
    professionalId?: string | null;
    episodeId?: string | null;
    cycleId?: string | null;
  }): {
    guideType: GuideType;
    contactId: string;
    contactName: string | null;
    professionalId: string | null;
    episodeId: string | null;
    cycleId: string | null;
    fields: Record<string, { value: any; missing: boolean; source?: string; reason?: string }>;
    warnings: string[];
  } {
    if (!GUIDE_TYPES.includes(input.guideType)) {
      throw new Error(`guideType inválido. Aceitos: ${GUIDE_TYPES.join(", ")}.`);
    }
    const contact = loadContactOrThrow(orgId, input.contactId);
    const episode = loadOptionalEpisode(orgId, input.episodeId);
    const cycle = loadOptionalCycle(orgId, input.cycleId);
    if (cycle && episode && cycle.episode_id !== episode.id) {
      throw new Error("Ciclo pertence a outro episódio.");
    }
    // Se cycleId vier sem episodeId, deriva episodeId do ciclo pra consultar histórico.
    const episodeIdEff = episode?.id || cycle?.episode_id || null;

    // Valida professionalId cross-tenant (se veio)
    let professionalId: string | null = input.professionalId || null;
    if (professionalId) {
      const prof = db.prepare(
        `SELECT id FROM clinic_professionals WHERE organization_id = ? AND id = ?`
      ).get(orgId, professionalId) as any;
      if (!prof) throw new Error("Profissional não encontrado.");
    }

    // Perfil do paciente (pode ser null se paciente novo sem convênio)
    const profile = db.prepare(
      `SELECT cpf, insurance_card_number, insurance_name, current_plan_name
         FROM patient_profiles WHERE organization_id = ? AND contact_id = ?`
    ).get(orgId, input.contactId) as any;

    // Última guia emitida do MESMO tipo pra este paciente/episódio — molde da vez anterior.
    // Só puxa TUSS/procedureId/operatorId; nunca copia número, validade ou autorização.
    let lastSameType: any = null;
    if (episodeIdEff) {
      lastSameType = db.prepare(
        `SELECT id, operator_id, procedure_id, total_sessions, snapshot_json
           FROM clinical_guides
          WHERE organization_id = ? AND contact_id = ? AND guide_type = ?
            AND episode_id = ? AND status IN ('issued','submitted','approved')
          ORDER BY created_at DESC LIMIT 1`
      ).get(orgId, input.contactId, input.guideType, episodeIdEff) as any;
    }
    if (!lastSameType) {
      lastSameType = db.prepare(
        `SELECT id, operator_id, procedure_id, total_sessions, snapshot_json
           FROM clinical_guides
          WHERE organization_id = ? AND contact_id = ? AND guide_type = ?
            AND status IN ('issued','submitted','approved')
          ORDER BY created_at DESC LIMIT 1`
      ).get(orgId, input.contactId, input.guideType) as any;
    }
    let lastSnapshot: any = null;
    if (lastSameType?.snapshot_json) {
      try { lastSnapshot = JSON.parse(lastSameType.snapshot_json); } catch {}
    }

    // Autorização anterior (procedure_authorization_requests) só se aprovada.
    // Sem autorização aprovada → authorizationNumber missing (IA não inventa).
    const authRow = db.prepare(
      `SELECT id, operator_id, procedure_id, tuss_code, authorization_number,
              status, approved_at, expires_at
         FROM procedure_authorization_requests
        WHERE organization_id = ? AND contact_id = ? AND status = 'approved'
        ORDER BY approved_at DESC LIMIT 1`
    ).get(orgId, input.contactId) as any;

    const warnings: string[] = [];
    const fields: Record<string, { value: any; missing: boolean; source?: string; reason?: string }> = {};

    const set = (k: string, value: any, source?: string, reason?: string) => {
      if (value == null || value === "") {
        fields[k] = { value: null, missing: true, reason: reason || "sem fonte disponível" };
      } else {
        fields[k] = { value, missing: false, source };
      }
    };

    // Campos comuns a todos os tipos
    set("patientName", contact.name, contact.name ? "contacts" : undefined,
      contact.name ? undefined : "contato sem nome cadastrado");
    set("cpf", profile?.cpf, profile?.cpf ? "patient_profiles" : undefined,
      profile?.cpf ? undefined : "paciente sem CPF cadastrado");

    // ── Campos específicos por tipo ───────────────────────────────────
    if (input.guideType === "tiss_authorization") {
      // Operadora + carteirinha vêm do plano; TUSS/procedure vêm de authorization aprovada
      // OU da guia anterior do mesmo episódio. Se ambos ausentes → missing.
      const operatorId = authRow?.operator_id || lastSameType?.operator_id || null;
      set("operatorId", operatorId,
        authRow ? "procedure_authorization_requests" : (lastSameType ? "clinical_guides (guia anterior)" : undefined),
        operatorId ? undefined : "paciente sem autorização aprovada nem guia anterior");
      set("insuranceName", profile?.insurance_name,
        profile?.insurance_name ? "patient_profiles" : undefined,
        profile?.insurance_name ? undefined : "paciente sem plano cadastrado");
      set("insuranceCardNumber", profile?.insurance_card_number,
        profile?.insurance_card_number ? "patient_profiles" : undefined,
        profile?.insurance_card_number ? undefined : "carteirinha não cadastrada — recepção precisa preencher");
      const procedureId = authRow?.procedure_id || lastSameType?.procedure_id || null;
      set("procedureId", procedureId,
        authRow ? "procedure_authorization_requests" : (lastSameType ? "clinical_guides (guia anterior)" : undefined),
        procedureId ? undefined : "procedimento não informado — recepção precisa selecionar");
      set("tussCode", authRow?.tuss_code,
        authRow?.tuss_code ? "procedure_authorization_requests" : undefined,
        authRow?.tuss_code ? undefined : "TUSS sem fonte — IA não inventa código; recepção precisa consultar tabela TUSS");
      set("totalSessions", lastSameType?.total_sessions,
        lastSameType?.total_sessions ? "clinical_guides (guia anterior)" : undefined,
        lastSameType?.total_sessions ? undefined : "sem guia anterior — recepção define quantidade a solicitar");
      // authorizationNumber: só vem de autorização APROVADA (não de guia anterior).
      // Se paciente vai submeter guia nova, autorização vem depois — jamais copiar.
      set("authorizationNumber", authRow?.authorization_number,
        authRow?.authorization_number ? "procedure_authorization_requests" : undefined,
        authRow?.authorization_number ? undefined : "autorização precisa ser obtida do convênio — IA não gera número");
      // Validade: nunca chutar; o convênio define.
      set("validUntil", authRow?.expires_at,
        authRow?.expires_at ? "procedure_authorization_requests" : undefined,
        authRow?.expires_at ? undefined : "validade é definida pelo convênio; deixe em branco até receber autorização");

      if (fields.tussCode.missing || fields.operatorId.missing) {
        warnings.push("Dados de convênio incompletos — TUSS/operadora precisam ser preenchidos antes de emitir.");
      }
    }

    if (input.guideType === "referral") {
      // Especialidade destino e motivo vêm da UI (recepção/médico digita).
      // Puxamos só o que faz sentido: do último referral do paciente, sugerimos
      // a especialidade destino (se houver) — mas jamais copiamos o "motivo".
      const lastReferralSpec = lastSnapshot?.fields?.referralSpecialty || null;
      set("referralSpecialty", lastReferralSpec,
        lastReferralSpec ? "clinical_guides (encaminhamento anterior)" : undefined,
        lastReferralSpec ? undefined : "especialidade destino precisa ser selecionada pelo médico solicitante");
      // referralReason NUNCA copia — cada encaminhamento tem motivo próprio
      set("referralReason", null, undefined,
        "motivo do encaminhamento não é herdado — médico solicitante precisa descrever o caso atual");
    }

    if (input.guideType === "medical_order") {
      // Items é lista aberta — jamais fabricar. Devolvemos vazio pra UI preencher.
      set("items", null, undefined,
        "pedido médico exige lista de exames/procedimentos — médico solicitante preenche");
      // CID sugerido a partir do último atestado emitido do paciente (se houver).
      // NÃO puxa de assessment do prontuário livre — muito impreciso pra virar
      // sugestão. Se médico ainda não emitiu atestado com CID, deixa missing.
      const lastCid = db.prepare(
        `SELECT cid FROM clinical_medical_certificates
          WHERE organization_id = ? AND contact_id = ? AND cid IS NOT NULL AND cid != ''
          ORDER BY created_at DESC LIMIT 1`
      ).get(orgId, input.contactId) as any;
      set("cidCode", lastCid?.cid,
        lastCid?.cid ? "clinical_medical_certificates (último atestado)" : undefined,
        lastCid?.cid ? undefined : "CID sem histórico prévio — médico solicitante define");
    }

    return {
      guideType: input.guideType,
      contactId: input.contactId,
      contactName: contact.name,
      professionalId,
      episodeId: episodeIdEff,
      cycleId: cycle?.id || null,
      fields,
      warnings,
    };
  }
}

function writeSectionTitle(doc: any, title: string) {
  doc.moveDown(0.6);
  doc.font("Helvetica-Bold").fontSize(11).fillColor("#0f766e").text(title);
  doc.moveTo(48, doc.y + 1).lineTo(547, doc.y + 1).strokeColor("#0f766e").lineWidth(0.5).stroke();
  doc.moveDown(0.35);
}

function writeKV(doc: any, rows: [string, string][]) {
  for (const [k, v] of rows) {
    const y = doc.y;
    doc.font("Helvetica").fontSize(10).fillColor("#374151").text(k, 48, y, { width: 160 });
    doc.font("Helvetica").fontSize(10).fillColor("#111827").text(v, 208, y, { width: 340 });
    doc.moveDown(0.2);
  }
}

export default ClinicGuideService;
