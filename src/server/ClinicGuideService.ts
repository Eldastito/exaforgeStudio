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
}

export default ClinicGuideService;
