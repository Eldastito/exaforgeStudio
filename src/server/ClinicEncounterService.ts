/**
 * Módulo Clínica — PRONTUÁRIO/SOAP (ADR-080 Fase G).
 *
 * Uma consulta = um encounter. Cria em rascunho quando o profissional inicia
 * o atendimento (ou logo após `complete()` da agenda, pra não perder), o
 * profissional preenche SOAP durante/após a consulta e finaliza (`signed`)
 * quando termina. Depois de assinar, updates novos são bloqueados aqui — a
 * próxima fatia (adendo/errata) libera pós-assinatura com trilha.
 *
 * LGPD Art. 11 (dado sensível de saúde) é OBRIGATÓRIO — sem consentimento
 * do paciente para `dados_sensiveis` (mapeado no vertical `saude` em
 * `verticals.ts:23-32`), o encounter não abre. Isso NÃO é policy do cliente:
 * é policy do produto. O gestor tem uma rota pra registrar o consentimento
 * quando ele acontece (verbal, em papel, digital).
 *
 * Determinístico, zero-token. Isolado por `organization_id`.
 */
import { randomUUID } from "node:crypto";
import db from "./db.js";
import { logAuthEvent } from "./auditLog.js";
import { LgpdService } from "./LgpdService.js";
import { ClinicEncounterHistoryService } from "./ClinicEncounterHistoryService.js";

export type EncounterStatus = "draft" | "signed";

export interface Encounter {
  id: string;
  organizationId: string;
  appointmentId: string;
  contactId: string;
  professionalId: string | null;
  professionalNameSnapshot: string | null;
  status: EncounterStatus;
  subjective: string | null;
  objective: string | null;
  assessment: string | null;
  plan: string | null;
  formData: any | null;
  createdBy: string | null;
  signedBy: string | null;
  signedAt: string | null;
  followUpRecommendedDays: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface EncounterPatch {
  subjective?: string | null;
  objective?: string | null;
  assessment?: string | null;
  plan?: string | null;
  formData?: any | null;
}

const SENSITIVE_CONSENT = "dados_sensiveis";

function requireConsent(orgId: string, contactId: string) {
  if (!LgpdService.hasConsent(orgId, contactId, SENSITIVE_CONSENT)) {
    const e: any = new Error(
      "Consentimento LGPD para dados sensíveis (saúde) é obrigatório antes de abrir o prontuário."
    );
    e.code = "LGPD_CONSENT_REQUIRED";
    throw e;
  }
}

function hydrate(r: any): Encounter | null {
  if (!r) return null;
  let formData: any = null;
  try { formData = r.form_data ? JSON.parse(r.form_data) : null; } catch { /* ignora */ }
  return {
    id: r.id,
    organizationId: r.organization_id,
    appointmentId: r.appointment_id,
    contactId: r.contact_id,
    professionalId: r.professional_id ?? null,
    professionalNameSnapshot: r.professional_name_snapshot ?? null,
    status: r.status,
    subjective: r.subjective ?? null,
    objective: r.objective ?? null,
    assessment: r.assessment ?? null,
    plan: r.plan ?? null,
    formData,
    createdBy: r.created_by ?? null,
    signedBy: r.signed_by ?? null,
    signedAt: r.signed_at ?? null,
    followUpRecommendedDays: r.follow_up_recommended_days ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export class ClinicEncounterService {
  /** Pega o encounter de uma consulta (ou null se ainda não foi aberto). */
  static getByAppointment(orgId: string, appointmentId: string): Encounter | null {
    const r = db.prepare(
      `SELECT * FROM clinical_encounters WHERE organization_id = ? AND appointment_id = ?`
    ).get(orgId, appointmentId);
    return hydrate(r);
  }

  /** Pega o encounter pelo id (validando org). */
  static get(orgId: string, encounterId: string): Encounter | null {
    const r = db.prepare(
      `SELECT * FROM clinical_encounters WHERE organization_id = ? AND id = ?`
    ).get(orgId, encounterId);
    return hydrate(r);
  }

  /**
   * Abre encounter da consulta em rascunho. IDEMPOTENTE — se já existe,
   * devolve o existente sem duplicar (UNIQUE(org, appointment_id) protege
   * também no nível DB).
   */
  static open(orgId: string, appointmentId: string, actorId: string | null): Encounter {
    const apt = db.prepare(
      `SELECT * FROM appointments WHERE organization_id = ? AND id = ?`
    ).get(orgId, appointmentId) as any;
    if (!apt) throw new Error("Agendamento não encontrado.");
    if (!apt.contact_id) throw new Error("Agendamento sem paciente associado.");

    const existing = this.getByAppointment(orgId, appointmentId);
    if (existing) return existing;

    // LGPD Art.11 — dado sensível exige consentimento explícito antes de abrir.
    requireConsent(orgId, apt.contact_id);

    const id = randomUUID();
    db.prepare(
      `INSERT INTO clinical_encounters
         (id, organization_id, appointment_id, contact_id, professional_id, professional_name_snapshot, status, created_by)
       VALUES (?, ?, ?, ?, ?, ?, 'draft', ?)`
    ).run(
      id, orgId, appointmentId, apt.contact_id,
      apt.professional_id || null, apt.professional_name_snapshot || null,
      actorId
    );

    logAuthEvent(orgId, actorId, apt.contact_id, "CLINIC_ENCOUNTER_OPENED", { encounterId: id, appointmentId });
    return this.get(orgId, id)!;
  }

  /**
   * Atualiza campos SOAP e/ou form_data (extensível). Não pode alterar
   * encounter `signed` — a próxima fatia lida com addendum pós-assinatura.
   * Cada UPDATE registra diff em `clinical_encounter_history`.
   */
  static update(orgId: string, encounterId: string, actorId: string | null, patch: EncounterPatch): Encounter {
    const before = this.get(orgId, encounterId);
    if (!before) throw new Error("Prontuário não encontrado.");
    if (before.status === "signed") {
      const e: any = new Error("Prontuário já assinado — não pode ser editado (use addendum).");
      e.code = "ENCOUNTER_SIGNED";
      throw e;
    }
    requireConsent(orgId, before.contactId);

    const fields: string[] = [];
    const params: any[] = [];
    const historyAfter: Record<string, any> = {};
    const historyBefore: Record<string, any> = {};

    if (patch.subjective !== undefined) { fields.push("subjective = ?"); params.push(patch.subjective); historyAfter.subjective = patch.subjective; historyBefore.subjective = before.subjective; }
    if (patch.objective !== undefined) { fields.push("objective = ?"); params.push(patch.objective); historyAfter.objective = patch.objective; historyBefore.objective = before.objective; }
    if (patch.assessment !== undefined) { fields.push("assessment = ?"); params.push(patch.assessment); historyAfter.assessment = patch.assessment; historyBefore.assessment = before.assessment; }
    if (patch.plan !== undefined) { fields.push("plan = ?"); params.push(patch.plan); historyAfter.plan = patch.plan; historyBefore.plan = before.plan; }
    if (patch.formData !== undefined) {
      const serialized = patch.formData == null ? null : JSON.stringify(patch.formData);
      fields.push("form_data = ?");
      params.push(serialized);
      historyAfter.formData = serialized;
      historyBefore.formData = before.formData == null ? null : JSON.stringify(before.formData);
    }

    if (!fields.length) return before;
    fields.push("updated_at = CURRENT_TIMESTAMP");
    db.prepare(
      `UPDATE clinical_encounters SET ${fields.join(", ")} WHERE id = ? AND organization_id = ?`
    ).run(...params, encounterId, orgId);

    ClinicEncounterHistoryService.record(orgId, encounterId, actorId, historyBefore, historyAfter);
    logAuthEvent(orgId, actorId, before.contactId, "CLINIC_ENCOUNTER_UPDATED", {
      encounterId,
      changedFields: Object.keys(historyAfter),
    });
    return this.get(orgId, encounterId)!;
  }

  /**
   * Finaliza (assina) o prontuário. Idempotente: chamar novamente em um
   * já assinado devolve o mesmo estado sem alterar `signed_by`/`signed_at`.
   * A partir daqui, `update()` é bloqueado.
   */
  static finalize(orgId: string, encounterId: string, actorId: string | null): Encounter {
    const before = this.get(orgId, encounterId);
    if (!before) throw new Error("Prontuário não encontrado.");
    if (before.status === "signed") return before;

    db.prepare(
      `UPDATE clinical_encounters
         SET status = 'signed', signed_by = ?, signed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND organization_id = ?`
    ).run(actorId, encounterId, orgId);

    logAuthEvent(orgId, actorId, before.contactId, "CLINIC_ENCOUNTER_FINALIZED", { encounterId });
    return this.get(orgId, encounterId)!;
  }

  /** Histórico clínico do paciente — todos os encounters, mais recente primeiro. */
  static listByPatient(orgId: string, contactId: string, limit = 50): Encounter[] {
    const rows = db.prepare(
      `SELECT * FROM clinical_encounters
        WHERE organization_id = ? AND contact_id = ?
        ORDER BY created_at DESC, rowid DESC
        LIMIT ?`
    ).all(orgId, contactId, Math.max(1, Math.min(200, limit))) as any[];
    return rows.map((r) => hydrate(r)!).filter(Boolean);
  }

  /** Diff versionado de um encounter (best-effort — nunca joga erro pra fora). */
  static history(orgId: string, encounterId: string) {
    return ClinicEncounterHistoryService.list(orgId, encounterId);
  }

  /**
   * Marca (ou apaga) a recomendação de retorno do profissional (ADR-080
   * Fase I). Diferente dos campos SOAP, NÃO é bloqueado por `signed` — a
   * recomendação é intenção clínica e pode ser ajustada mesmo com prontuário
   * assinado sem gerar addendum (não altera achado clínico, altera plano
   * agendado). Passar `null` limpa.
   */
  static setFollowUpRecommendation(orgId: string, encounterId: string, actorId: string | null, days: number | null): Encounter {
    const before = this.get(orgId, encounterId);
    if (!before) throw new Error("Prontuário não encontrado.");
    let value: number | null = null;
    if (days !== null && days !== undefined) {
      const d = Math.floor(Number(days));
      if (!Number.isFinite(d) || d < 1) throw new Error("Recomendação: informe ao menos 1 dia (ou null pra limpar).");
      value = d;
    }
    db.prepare(
      `UPDATE clinical_encounters SET follow_up_recommended_days = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND organization_id = ?`
    ).run(value, encounterId, orgId);
    logAuthEvent(orgId, actorId, before.contactId, "CLINIC_ENCOUNTER_FOLLOWUP_SET", { encounterId, days: value });
    return this.get(orgId, encounterId)!;
  }
}

export default ClinicEncounterService;
