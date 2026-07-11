import db from "./db.js";
import { randomUUID } from "node:crypto";
import { logAuthEvent } from "./auditLog.js";

/**
 * Módulo Clínica — Ficha do Paciente (ADR-080, Fase B).
 *
 * Ficha satélite 1:1 com `contacts` (o paciente É um contato do CRM; a ficha
 * guarda o dado sensível de saúde separado). Princípio central da dor da
 * clínica: TROCAR PLANO/CONVÊNIO NÃO APAGA o paciente nem o agendamento — a
 * troca atualiza a ficha (fonte da verdade) e registra o histórico. Tudo
 * escopado por organização e auditado.
 */
const onlyDigits = (s: any) => String(s || "").replace(/\D/g, "");

export class PatientService {
  /** Ficha de um paciente pelo contato (com histórico de plano). */
  static getByContact(orgId: string, contactId: string): any {
    const contact = db.prepare("SELECT id, name, identifier, email FROM contacts WHERE id = ? AND organization_id = ?").get(contactId, orgId) as any;
    if (!contact) throw new Error("Contato não encontrado.");
    const profile = db.prepare("SELECT * FROM patient_profiles WHERE contact_id = ? AND organization_id = ?").get(contactId, orgId) as any || null;
    const planHistory = db.prepare("SELECT * FROM patient_plan_history WHERE contact_id = ? AND organization_id = ? ORDER BY created_at DESC LIMIT 100").all(contactId, orgId) as any[];
    return { contact, profile, planHistory };
  }

  static list(orgId: string, opts: { q?: string } = {}): any[] {
    let sql = `
      SELECT p.*, c.name AS contact_name, c.identifier AS contact_identifier
      FROM patient_profiles p JOIN contacts c ON c.id = p.contact_id AND c.organization_id = p.organization_id
      WHERE p.organization_id = ?`;
    const params: any[] = [orgId];
    if (opts.q) { sql += " AND (p.full_name LIKE ? OR c.name LIKE ? OR p.cpf LIKE ? OR p.insurance_card_number LIKE ?)"; const t = `%${opts.q}%`; params.push(t, t, t, t); }
    sql += " ORDER BY p.updated_at DESC LIMIT 500";
    return db.prepare(sql).all(...params) as any[];
  }

  /**
   * Cria ou atualiza a ficha (upsert por contato). NÃO cuida da troca de plano
   * com histórico — isso é `changePlan` (dor específica da clínica). Aqui
   * atualizam-se dados cadastrais; se `insurance_*` mudar por aqui, também
   * registra histórico para não perder rastro.
   */
  static upsert(orgId: string, contactId: string, input: {
    fullName?: string; cpf?: string; birthDate?: string; insuranceName?: string;
    currentPlanName?: string; insuranceCardNumber?: string; insuranceValidUntil?: string; administrativeNotes?: string;
  }, actorId?: string): any {
    const contact = db.prepare("SELECT id FROM contacts WHERE id = ? AND organization_id = ?").get(contactId, orgId);
    if (!contact) throw new Error("Contato não encontrado.");
    const existing = db.prepare("SELECT * FROM patient_profiles WHERE contact_id = ? AND organization_id = ?").get(contactId, orgId) as any;

    if (!existing) {
      const id = randomUUID();
      db.prepare(`INSERT INTO patient_profiles (id, organization_id, contact_id, full_name, cpf, birth_date, insurance_name, current_plan_name, insurance_card_number, insurance_valid_until, administrative_notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, orgId, contactId, String(input?.fullName || "").trim() || null, onlyDigits(input?.cpf) || null,
          input?.birthDate || null, String(input?.insuranceName || "").trim() || null, String(input?.currentPlanName || "").trim() || null,
          String(input?.insuranceCardNumber || "").trim() || null, input?.insuranceValidUntil || null, String(input?.administrativeNotes || "").trim() || null);
      logAuthEvent(orgId, actorId, contactId, "PATIENT_PROFILE_CREATED", { profileId: id });
      return this.getByContact(orgId, contactId);
    }

    // Se o convênio/plano/carteirinha mudou por aqui, registra histórico (não
    // perde rastro), mas sem exigir motivo — a via "oficial" com motivo é changePlan.
    const insuranceChanged =
      (input.insuranceName !== undefined && String(input.insuranceName || "").trim() !== String(existing.insurance_name || "")) ||
      (input.currentPlanName !== undefined && String(input.currentPlanName || "").trim() !== String(existing.current_plan_name || "")) ||
      (input.insuranceCardNumber !== undefined && String(input.insuranceCardNumber || "").trim() !== String(existing.insurance_card_number || ""));
    if (insuranceChanged) {
      this.recordPlanHistory(orgId, contactId, existing, {
        insuranceName: input.insuranceName ?? existing.insurance_name,
        currentPlanName: input.currentPlanName ?? existing.current_plan_name,
        insuranceCardNumber: input.insuranceCardNumber ?? existing.insurance_card_number,
      }, "edição de cadastro", actorId);
    }

    const fields: string[] = [], params: any[] = [];
    const set = (col: string, val: any) => { fields.push(`${col} = ?`); params.push(val); };
    if (input.fullName !== undefined) set("full_name", String(input.fullName || "").trim() || null);
    if (input.cpf !== undefined) set("cpf", onlyDigits(input.cpf) || null);
    if (input.birthDate !== undefined) set("birth_date", input.birthDate || null);
    if (input.insuranceName !== undefined) set("insurance_name", String(input.insuranceName || "").trim() || null);
    if (input.currentPlanName !== undefined) set("current_plan_name", String(input.currentPlanName || "").trim() || null);
    if (input.insuranceCardNumber !== undefined) set("insurance_card_number", String(input.insuranceCardNumber || "").trim() || null);
    if (input.insuranceValidUntil !== undefined) set("insurance_valid_until", input.insuranceValidUntil || null);
    if (input.administrativeNotes !== undefined) set("administrative_notes", String(input.administrativeNotes || "").trim() || null);
    if (fields.length) {
      params.push(contactId, orgId);
      db.prepare(`UPDATE patient_profiles SET ${fields.join(", ")}, updated_at = CURRENT_TIMESTAMP WHERE contact_id = ? AND organization_id = ?`).run(...params);
      logAuthEvent(orgId, actorId, contactId, "PATIENT_PROFILE_UPDATED", { fields: fields.map(f => f.split(" ")[0]) });
    }
    return this.getByContact(orgId, contactId);
  }

  /**
   * Troca de plano/convênio COM histórico e motivo — a dor central da clínica.
   * NÃO apaga o paciente nem o agendamento; só atualiza a ficha e registra a
   * transição. Agendamentos futuros passam a ler o plano novo até serem
   * autorizados (quando o snapshot congela — ADR-080 D6, tratado na Fase E).
   */
  static changePlan(orgId: string, contactId: string, input: {
    insuranceName?: string; currentPlanName?: string; insuranceCardNumber?: string; insuranceValidUntil?: string; reason?: string;
  }, actorId?: string): any {
    const existing = db.prepare("SELECT * FROM patient_profiles WHERE contact_id = ? AND organization_id = ?").get(contactId, orgId) as any;
    if (!existing) throw new Error("Ficha do paciente não encontrada. Crie a ficha antes de trocar o plano.");
    const next = {
      insuranceName: input.insuranceName !== undefined ? String(input.insuranceName || "").trim() : existing.insurance_name,
      currentPlanName: input.currentPlanName !== undefined ? String(input.currentPlanName || "").trim() : existing.current_plan_name,
      insuranceCardNumber: input.insuranceCardNumber !== undefined ? String(input.insuranceCardNumber || "").trim() : existing.insurance_card_number,
    };
    this.recordPlanHistory(orgId, contactId, existing, next, String(input?.reason || "").trim() || "troca de plano", actorId);
    db.prepare(`UPDATE patient_profiles SET insurance_name = ?, current_plan_name = ?, insurance_card_number = ?, insurance_valid_until = ?, updated_at = CURRENT_TIMESTAMP WHERE contact_id = ? AND organization_id = ?`)
      .run(next.insuranceName || null, next.currentPlanName || null, next.insuranceCardNumber || null,
        input.insuranceValidUntil !== undefined ? (input.insuranceValidUntil || null) : existing.insurance_valid_until, contactId, orgId);
    logAuthEvent(orgId, actorId, contactId, "PATIENT_PLAN_CHANGED", { from: existing.insurance_name, to: next.insuranceName, plan: next.currentPlanName });
    return this.getByContact(orgId, contactId);
  }

  private static recordPlanHistory(orgId: string, contactId: string, prev: any, next: { insuranceName?: string; currentPlanName?: string; insuranceCardNumber?: string }, reason: string, actorId?: string): void {
    db.prepare(`INSERT INTO patient_plan_history (id, organization_id, contact_id, old_insurance_name, new_insurance_name, old_plan_name, new_plan_name, old_card_number, new_card_number, reason, changed_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(randomUUID(), orgId, contactId, prev.insurance_name || null, next.insuranceName || null,
        prev.current_plan_name || null, next.currentPlanName || null, prev.insurance_card_number || null, next.insuranceCardNumber || null, reason, actorId || null);
  }
}
