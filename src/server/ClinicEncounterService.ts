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
import { verifyPin } from "./ClinicDocumentsService.js";

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

export interface EncounterAddendum {
  id: string;
  organizationId: string;
  encounterId: string;
  contactId: string;
  authorId: string | null;
  authorNameSnapshot: string | null;
  note: string;
  signedWithPin: boolean;
  createdAt: string;
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
  /**
   * Pega o encounter de uma consulta (ou null se ainda não foi aberto).
   *
   * Fase 19: leitura de prontuário exige consent LGPD Art.11 ATIVO. Antes,
   * `open()` já bloqueava a criação, mas `getByAppointment` seguia devolvendo
   * dado sensível mesmo quando o paciente havia revogado — o titular
   * revogava e o profissional continuava lendo. Se o encounter não existe
   * (retorno null), NÃO gata — pode ser lookup pra saber se precisa abrir.
   */
  static getByAppointment(orgId: string, appointmentId: string): Encounter | null {
    const r = db.prepare(
      `SELECT * FROM clinical_encounters WHERE organization_id = ? AND appointment_id = ?`
    ).get(orgId, appointmentId) as any;
    if (!r) return null;
    requireConsent(orgId, r.contact_id);
    return hydrate(r);
  }

  /** Pega o encounter pelo id (validando org). */
  static get(orgId: string, encounterId: string): Encounter | null {
    const r = db.prepare(
      `SELECT * FROM clinical_encounters WHERE organization_id = ? AND id = ?`
    ).get(orgId, encounterId) as any;
    if (!r) return null;
    requireConsent(orgId, r.contact_id);
    return hydrate(r);
  }

  /**
   * Fase 19: variante `get` que NÃO exige consent — uso interno por chamadas
   * do próprio service (`update`/`finalize`/`setFollowUpRecommendation`/
   * `open` retornando o recém-criado) que já validam consent explicitamente
   * ou são writes sem gate histórico. Mantém a semântica original sem
   * duplicar checagem. Nunca exportar por rota HTTP.
   */
  private static getRaw(orgId: string, encounterId: string): Encounter | null {
    const r = db.prepare(
      `SELECT * FROM clinical_encounters WHERE organization_id = ? AND id = ?`
    ).get(orgId, encounterId);
    return hydrate(r);
  }

  /** Fase 19: irmã da `getRaw`, mas por `appointment_id`. Só `open()` usa
   *  — pra checar idempotência antes de criar o encounter novo. */
  private static getByAppointmentRaw(orgId: string, appointmentId: string): Encounter | null {
    const r = db.prepare(
      `SELECT * FROM clinical_encounters WHERE organization_id = ? AND appointment_id = ?`
    ).get(orgId, appointmentId);
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

    const existing = this.getByAppointmentRaw(orgId, appointmentId);
    if (existing) {
      // Fase 19: retorno via idempotência ainda precisa gatear leitura.
      requireConsent(orgId, existing.contactId);
      return existing;
    }

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
    return this.getRaw(orgId, id)!;
  }

  /**
   * Atualiza campos SOAP e/ou form_data (extensível). Não pode alterar
   * encounter `signed` — a próxima fatia lida com addendum pós-assinatura.
   * Cada UPDATE registra diff em `clinical_encounter_history`.
   */
  static update(orgId: string, encounterId: string, actorId: string | null, patch: EncounterPatch): Encounter {
    // Fase 19: usa raw pra a checagem explícita de consent abaixo ser a
    // única — evita duplicar erro se `get` também gatear.
    const before = this.getRaw(orgId, encounterId);
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
    return this.getRaw(orgId, encounterId)!;
  }

  /**
   * Finaliza (assina) o prontuário. Idempotente: chamar novamente em um
   * já assinado devolve o mesmo estado sem alterar `signed_by`/`signed_at`.
   * A partir daqui, `update()` é bloqueado.
   */
  static finalize(orgId: string, encounterId: string, actorId: string | null): Encounter {
    const before = this.getRaw(orgId, encounterId);
    if (!before) throw new Error("Prontuário não encontrado.");
    if (before.status === "signed") return before;

    db.prepare(
      `UPDATE clinical_encounters
         SET status = 'signed', signed_by = ?, signed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND organization_id = ?`
    ).run(actorId, encounterId, orgId);

    logAuthEvent(orgId, actorId, before.contactId, "CLINIC_ENCOUNTER_FINALIZED", { encounterId });
    return this.getRaw(orgId, encounterId)!;
  }

  /**
   * Histórico clínico do paciente — todos os encounters, mais recente primeiro.
   *
   * Fase 19: exige consent LGPD do próprio paciente cujo histórico está sendo
   * pedido. `contactId` vem do caller, então o gate protege consulta pontual;
   * quando o paciente revoga, o profissional perde acesso ao histórico até
   * novo grant. Retenção CFM continua guardando as rows — só o TRATAMENTO
   * (leitura) é bloqueado, alinhado a LGPD Art.8 §5.
   */
  static listByPatient(orgId: string, contactId: string, limit = 50): Encounter[] {
    requireConsent(orgId, contactId);
    const rows = db.prepare(
      `SELECT * FROM clinical_encounters
        WHERE organization_id = ? AND contact_id = ?
        ORDER BY created_at DESC, rowid DESC
        LIMIT ?`
    ).all(orgId, contactId, Math.max(1, Math.min(200, limit))) as any[];
    return rows.map((r) => hydrate(r)!).filter(Boolean);
  }

  /**
   * Diff versionado de um encounter (best-effort — nunca joga erro pra fora).
   *
   * Fase 19: o histórico é dado sensível — cada versão é uma foto do SOAP.
   * Deriva `contactId` do próprio encounter pra checar consent. Se o encounter
   * não existe (id inválido / cross-tenant), devolve `[]` (comportamento
   * histórico) — nada a esconder.
   */
  static history(orgId: string, encounterId: string) {
    const r = db.prepare(
      `SELECT contact_id FROM clinical_encounters WHERE organization_id = ? AND id = ?`
    ).get(orgId, encounterId) as any;
    if (!r) return [];
    requireConsent(orgId, r.contact_id);
    return ClinicEncounterHistoryService.list(orgId, encounterId);
  }

  /**
   * Marca (ou apaga) a recomendação de retorno do profissional (ADR-080
   * Fase I). Diferente dos campos SOAP, NÃO é bloqueado por `signed` — a
   * recomendação é intenção clínica e pode ser ajustada mesmo com prontuário
   * assinado sem gerar addendum (não altera achado clínico, altera plano
   * agendado). Passar `null` limpa.
   */
  /**
   * Fase 20 — Addendum ao prontuário assinado (CFM 1.821/2007).
   *
   * O prontuário original NÃO é modificado depois de `signed` (`update` fica
   * bloqueado). Mas o profissional precisa poder acrescentar informação
   * relevante que apareceu depois — resultado de exame, correção de erro
   * material, evolução tardia. Solução: addendum APPEND-ONLY, cada linha
   * com autoria e timestamp próprios. Nunca UPDATE nem DELETE de row de
   * addendum — histórico clínico é imutável.
   *
   * Só permitido em encounter `signed` — em `draft` o profissional edita
   * direto (`update`) e o diff cai em `clinical_encounter_history`.
   *
   * PIN é OPCIONAL (mesma regra da Fase T): se o profissional tem PIN
   * cadastrado, precisa fornecer (401 PIN_REQUIRED / PIN_INVALID). Se não
   * tem, addendum sai sem PIN (compat legado). Autoria fica gravada com
   * `authorId` + snapshot de nome ainda que sem PIN.
   *
   * LGPD Art.11: addendum é dado sensível, exige consent ativo.
   */
  static addAddendum(orgId: string, encounterId: string, actorId: string | null, opts: { note: string; actorName?: string | null; pin?: string }): EncounterAddendum {
    const enc = this.getRaw(orgId, encounterId);
    if (!enc) throw new Error("Prontuário não encontrado.");
    if (enc.status !== "signed") {
      const e: any = new Error("Addendum só é permitido em prontuário assinado. Em rascunho, edite o SOAP diretamente.");
      e.code = "ENCOUNTER_NOT_SIGNED";
      throw e;
    }
    requireConsent(orgId, enc.contactId);

    const note = String(opts.note || "").trim();
    if (!note) {
      const e: any = new Error("Texto do addendum é obrigatório.");
      e.code = "ADDENDUM_EMPTY";
      throw e;
    }
    if (note.length > 4000) {
      const e: any = new Error("Texto do addendum excede 4000 caracteres.");
      e.code = "ADDENDUM_TOO_LONG";
      throw e;
    }

    // Reusa verifyPin da Fase T — mesma semântica de compat legado:
    // profissional sem PIN cadastrado retorna false e addendum vai sem PIN.
    // Com PIN cadastrado, lança PIN_REQUIRED/PIN_INVALID (401 na rota).
    const signedWithPin = verifyPin(orgId, enc.professionalId, opts.pin);

    const id = randomUUID();
    db.prepare(
      `INSERT INTO clinical_encounter_addendums
         (id, organization_id, encounter_id, contact_id, author_id, author_name_snapshot, note, signed_with_pin)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id, orgId, encounterId, enc.contactId,
      actorId, opts.actorName ?? null,
      note, signedWithPin ? 1 : 0
    );

    logAuthEvent(orgId, actorId, enc.contactId, "CLINIC_ENCOUNTER_ADDENDUM_ADDED", {
      encounterId,
      addendumId: id,
      signedWithPin,
      length: note.length,
    });

    return {
      id,
      organizationId: orgId,
      encounterId,
      contactId: enc.contactId,
      authorId: actorId,
      authorNameSnapshot: opts.actorName ?? null,
      note,
      signedWithPin,
      createdAt: new Date().toISOString(),
    };
  }

  /**
   * Fase 20 — Lista os addendums de um encounter (mais recente primeiro).
   * Consent LGPD gate: addendum contém observação clínica sensível.
   * Encounter inexistente devolve `[]` — mesma semântica de `history`.
   */
  static listAddendums(orgId: string, encounterId: string): EncounterAddendum[] {
    const enc = db.prepare(
      `SELECT contact_id FROM clinical_encounters WHERE organization_id = ? AND id = ?`
    ).get(orgId, encounterId) as any;
    if (!enc) return [];
    requireConsent(orgId, enc.contact_id);

    const rows = db.prepare(
      `SELECT * FROM clinical_encounter_addendums
        WHERE organization_id = ? AND encounter_id = ?
        ORDER BY created_at DESC, rowid DESC`
    ).all(orgId, encounterId) as any[];

    return rows.map((r) => ({
      id: r.id,
      organizationId: r.organization_id,
      encounterId: r.encounter_id,
      contactId: r.contact_id,
      authorId: r.author_id ?? null,
      authorNameSnapshot: r.author_name_snapshot ?? null,
      note: r.note,
      signedWithPin: r.signed_with_pin === 1,
      createdAt: r.created_at,
    }));
  }

  static setFollowUpRecommendation(orgId: string, encounterId: string, actorId: string | null, days: number | null): Encounter {
    const before = this.getRaw(orgId, encounterId);
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
    return this.getRaw(orgId, encounterId)!;
  }
}

export default ClinicEncounterService;
