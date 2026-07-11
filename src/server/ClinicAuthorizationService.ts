import db from "./db.js";
import { randomUUID } from "node:crypto";
import { logAuthEvent } from "./auditLog.js";
import { EncryptionService } from "./EncryptionService.js";
import { CadenceService } from "./CadenceService.js";

/**
 * Módulo Clínica — Convênios e Autorização assistida (ADR-080, Fase E).
 *
 * MVP MANUAL (D4): registro + máquina de status + checklist + protocolo. Nada
 * de TISS XML/WebService/API (Fase F, ADR próprio). Guardrails (D7): o envio é
 * SEMPRE ação humana (submit a partir de 'ready_to_submit'); a IA nunca envia
 * sozinha, nunca inventa TUSS, nunca promete cobertura. Cada transição de
 * status dispara a cadência clínica correspondente (semeada na Fase A).
 * Credenciais da operadora ficam CIFRADAS (EncryptionService).
 */
const STATUSES = ["draft", "ready_to_submit", "submitted", "pending_documents", "pending_operator", "approved", "denied", "expired", "cancelled", "manual_required"];
// Status → gatilho de cadência clínica (Fase A). Só os que fazem sentido notificar.
const STATUS_TO_TRIGGER: Record<string, string> = {
  pending_documents: "documentacao_pendente",
  submitted: "autorizacao_pendente",
  pending_operator: "autorizacao_pendente",
  approved: "autorizacao_aprovada",
  denied: "autorizacao_negada",
};

export class ClinicAuthorizationService {
  // ── Operadoras ───────────────────────────────────────────────────────────
  static listOperators(orgId: string): any[] {
    return db.prepare("SELECT * FROM health_plan_operators WHERE organization_id = ? AND active = 1 ORDER BY name").all(orgId) as any[];
  }
  static createOperator(orgId: string, input: { name?: string; ansRegistry?: string; portalUrl?: string }, actorId?: string): any {
    const name = String(input?.name || "").trim();
    if (!name) throw new Error("Dê um nome à operadora.");
    const id = randomUUID();
    db.prepare("INSERT INTO health_plan_operators (id, organization_id, name, ans_registry, portal_url, connector_type) VALUES (?, ?, ?, ?, ?, 'manual')")
      .run(id, orgId, name, String(input?.ansRegistry || "").trim() || null, String(input?.portalUrl || "").trim() || null);
    logAuthEvent(orgId, actorId, null, "CLINIC_OPERATOR_CREATED", { operatorId: id, name });
    return db.prepare("SELECT * FROM health_plan_operators WHERE id = ?").get(id);
  }
  /** Credenciais da operadora: usuário/senha CIFRADOS em repouso. Nunca retorna o valor. */
  static setCredentials(orgId: string, operatorId: string, input: { providerCode?: string; username?: string; password?: string }, actorId?: string): { configured: boolean } {
    const op = db.prepare("SELECT id FROM health_plan_operators WHERE id = ? AND organization_id = ?").get(operatorId, orgId);
    if (!op) throw new Error("Operadora não encontrada.");
    const existing = db.prepare("SELECT id FROM health_plan_credentials WHERE organization_id = ? AND operator_id = ?").get(orgId, operatorId) as any;
    const userEnc = input?.username !== undefined ? EncryptionService.encrypt(input.username) : undefined;
    const passEnc = input?.password !== undefined ? EncryptionService.encrypt(input.password) : undefined;
    if (existing) {
      const fields: string[] = [], params: any[] = [];
      if (input.providerCode !== undefined) { fields.push("provider_code = ?"); params.push(String(input.providerCode || "").trim() || null); }
      if (userEnc !== undefined) { fields.push("username_encrypted = ?"); params.push(userEnc); }
      if (passEnc !== undefined) { fields.push("password_encrypted = ?"); params.push(passEnc); }
      if (fields.length) { fields.push("status = 'configured'"); params.push(orgId, operatorId); db.prepare(`UPDATE health_plan_credentials SET ${fields.join(", ")}, updated_at = CURRENT_TIMESTAMP WHERE organization_id = ? AND operator_id = ?`).run(...params); }
    } else {
      db.prepare("INSERT INTO health_plan_credentials (id, organization_id, operator_id, provider_code, username_encrypted, password_encrypted, status) VALUES (?, ?, ?, ?, ?, ?, 'configured')")
        .run(randomUUID(), orgId, operatorId, String(input?.providerCode || "").trim() || null, userEnc ?? null, passEnc ?? null);
    }
    logAuthEvent(orgId, actorId, null, "CLINIC_OPERATOR_CREDENTIALS_SET", { operatorId });
    return { configured: true };
  }
  /** Status das credenciais (sem expor segredo). */
  static credentialsStatus(orgId: string, operatorId: string): { configured: boolean; providerCode: string | null } {
    const row = db.prepare("SELECT provider_code, username_encrypted FROM health_plan_credentials WHERE organization_id = ? AND operator_id = ?").get(orgId, operatorId) as any;
    return { configured: !!row?.username_encrypted, providerCode: row?.provider_code || null };
  }

  // ── Procedimentos (TUSS cadastrado à mão — a IA nunca inventa) ───────────
  static listProcedures(orgId: string): any[] {
    return db.prepare("SELECT * FROM clinic_procedures WHERE organization_id = ? AND active = 1 ORDER BY name").all(orgId) as any[];
  }
  static createProcedure(orgId: string, input: { name?: string; tussCode?: string; defaultDurationMinutes?: number; requiresAuthorization?: boolean; requiresMedicalRequest?: boolean; preparationInstructions?: string }, actorId?: string): any {
    const name = String(input?.name || "").trim();
    if (!name) throw new Error("Dê um nome ao procedimento.");
    const id = randomUUID();
    db.prepare("INSERT INTO clinic_procedures (id, organization_id, name, tuss_code, default_duration_minutes, requires_authorization, requires_medical_request, preparation_instructions) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, orgId, name, String(input?.tussCode || "").trim() || null, Math.max(5, parseInt(String(input?.defaultDurationMinutes), 10) || 60),
        input?.requiresAuthorization ? 1 : 0, input?.requiresMedicalRequest ? 1 : 0, String(input?.preparationInstructions || "").trim() || null);
    logAuthEvent(orgId, actorId, null, "CLINIC_PROCEDURE_CREATED", { procedureId: id, name, tuss: String(input?.tussCode || "").trim() || null });
    return db.prepare("SELECT * FROM clinic_procedures WHERE id = ?").get(id);
  }

  // ── Solicitações de autorização ──────────────────────────────────────────
  static listAuthorizations(orgId: string, opts: { status?: string; contactId?: string } = {}): any[] {
    let sql = `
      SELECT a.*, c.name AS contact_name, o.name AS operator_name, p.name AS procedure_name
      FROM procedure_authorization_requests a
      LEFT JOIN contacts c ON c.id = a.contact_id AND c.organization_id = a.organization_id
      LEFT JOIN health_plan_operators o ON o.id = a.operator_id AND o.organization_id = a.organization_id
      LEFT JOIN clinic_procedures p ON p.id = a.procedure_id AND p.organization_id = a.organization_id
      WHERE a.organization_id = ?`;
    const params: any[] = [orgId];
    if (opts.status) { sql += " AND a.status = ?"; params.push(opts.status); }
    if (opts.contactId) { sql += " AND a.contact_id = ?"; params.push(opts.contactId); }
    sql += " ORDER BY a.updated_at DESC LIMIT 500";
    return db.prepare(sql).all(...params) as any[];
  }

  static getAuthorization(orgId: string, id: string): any {
    return db.prepare("SELECT * FROM procedure_authorization_requests WHERE id = ? AND organization_id = ?").get(id, orgId) as any || null;
  }

  /** Cria a solicitação (nasce em rascunho). Congela o plano do paciente (D6). */
  static createAuthorization(orgId: string, input: { contactId?: string; appointmentId?: string; operatorId?: string; procedureId?: string }, actorId?: string): any {
    const contactId = String(input?.contactId || "");
    const contact = db.prepare("SELECT id FROM contacts WHERE id = ? AND organization_id = ?").get(contactId, orgId);
    if (!contact) throw new Error("Paciente não encontrado.");
    let tuss: string | null = null;
    if (input?.procedureId) {
      const proc = db.prepare("SELECT tuss_code FROM clinic_procedures WHERE id = ? AND organization_id = ?").get(input.procedureId, orgId) as any;
      if (!proc) throw new Error("Procedimento não encontrado.");
      tuss = proc.tuss_code || null;
    }
    if (input?.operatorId) {
      const op = db.prepare("SELECT id FROM health_plan_operators WHERE id = ? AND organization_id = ?").get(input.operatorId, orgId);
      if (!op) throw new Error("Operadora não encontrada.");
    }
    // Snapshot IMUTÁVEL do plano no momento (D6).
    const profile = db.prepare("SELECT insurance_name, current_plan_name, insurance_card_number FROM patient_profiles WHERE contact_id = ? AND organization_id = ?").get(contactId, orgId) as any;
    const snapshot = profile ? JSON.stringify({ insurance: profile.insurance_name, plan: profile.current_plan_name, card: profile.insurance_card_number, at: new Date().toISOString() }) : null;
    const id = randomUUID();
    db.prepare("INSERT INTO procedure_authorization_requests (id, organization_id, contact_id, appointment_id, operator_id, procedure_id, tuss_code, requested_by, status, plan_snapshot) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?)")
      .run(id, orgId, contactId, input?.appointmentId || null, input?.operatorId || null, input?.procedureId || null, tuss, actorId || null, snapshot);
    if (input?.appointmentId) {
      db.prepare("UPDATE appointments SET authorization_id = ?, procedure_id = COALESCE(procedure_id, ?), patient_plan_snapshot = ? WHERE id = ? AND organization_id = ?")
        .run(id, input?.procedureId || null, snapshot, input.appointmentId, orgId);
    }
    logAuthEvent(orgId, actorId, contactId, "CLINIC_AUTHORIZATION_CREATED", { authorizationId: id, operatorId: input?.operatorId || null, procedureId: input?.procedureId || null });
    return this.getAuthorization(orgId, id);
  }

  /** Marca as pendências (checklist) e move para pending_documents ou ready_to_submit. */
  static prepare(orgId: string, id: string, input: { pendingRequirements?: string; ready?: boolean }, actorId?: string): any {
    const a = this.getAuthorization(orgId, id);
    if (!a) throw new Error("Solicitação não encontrada.");
    const pend = String(input?.pendingRequirements || "").trim();
    const status = input?.ready && !pend ? "ready_to_submit" : (pend ? "pending_documents" : a.status);
    this._transition(orgId, a, status, { pending_requirements: pend || null }, actorId, "CLINIC_AUTHORIZATION_PREPARED");
    return this.getAuthorization(orgId, id);
  }

  /** ENVIO (ação humana): só a partir de ready_to_submit. Registra protocolo. */
  static submit(orgId: string, id: string, input: { protocolNumber?: string }, actorId?: string): any {
    const a = this.getAuthorization(orgId, id);
    if (!a) throw new Error("Solicitação não encontrada.");
    if (a.status !== "ready_to_submit") throw new Error("Só é possível enviar uma solicitação pronta (ready_to_submit). Prepare-a antes.");
    this._transition(orgId, a, "submitted", { protocol_number: String(input?.protocolNumber || "").trim() || null, submitted_at: "CURRENT_TIMESTAMP" }, actorId, "CLINIC_AUTHORIZATION_SUBMITTED");
    return this.getAuthorization(orgId, id);
  }

  /** Retorno da operadora (registro manual do que voltou do convênio). */
  static setManualStatus(orgId: string, id: string, input: { status?: string; authorizationNumber?: string; denialReason?: string; protocolNumber?: string; expiresAt?: string }, actorId?: string): any {
    const a = this.getAuthorization(orgId, id);
    if (!a) throw new Error("Solicitação não encontrada.");
    const status = String(input?.status || "");
    if (!["pending_operator", "approved", "denied", "expired", "cancelled", "manual_required"].includes(status)) throw new Error("Status manual inválido.");
    const extra: Record<string, any> = {};
    if (input.protocolNumber !== undefined) extra.protocol_number = String(input.protocolNumber || "").trim() || null;
    if (status === "approved") { extra.authorization_number = String(input?.authorizationNumber || "").trim() || null; extra.approved_at = "CURRENT_TIMESTAMP"; if (input.expiresAt) extra.expires_at = input.expiresAt; }
    if (status === "denied") { extra.denial_reason = String(input?.denialReason || "").trim() || null; extra.denied_at = "CURRENT_TIMESTAMP"; }
    this._transition(orgId, a, status, extra, actorId, "CLINIC_AUTHORIZATION_STATUS");
    return this.getAuthorization(orgId, id);
  }

  /** Transição central: grava o status, campos extras, audita e dispara a cadência clínica. */
  private static _transition(orgId: string, a: any, status: string, extra: Record<string, any>, actorId: string | undefined, event: string): void {
    if (!STATUSES.includes(status)) throw new Error("Status inválido.");
    const sets = ["status = ?", "updated_at = CURRENT_TIMESTAMP"];
    const params: any[] = [status];
    for (const [k, v] of Object.entries(extra)) {
      if (v === "CURRENT_TIMESTAMP") { sets.push(`${k} = CURRENT_TIMESTAMP`); }
      else { sets.push(`${k} = ?`); params.push(v); }
    }
    params.push(a.id, orgId);
    db.prepare(`UPDATE procedure_authorization_requests SET ${sets.join(", ")} WHERE id = ? AND organization_id = ?`).run(...params);
    logAuthEvent(orgId, actorId, a.contact_id, event, { authorizationId: a.id, from: a.status, to: status });
    this._dispatchCadence(orgId, a.contact_id, status);
  }

  /** Dispara a cadência clínica correspondente ao novo status (best-effort). */
  private static _dispatchCadence(orgId: string, contactId: string, status: string): void {
    const trigger = STATUS_TO_TRIGGER[status];
    if (!trigger) return;
    try {
      const ticket = db.prepare("SELECT id FROM tickets WHERE contact_id = ? AND organization_id = ? AND status = 'open' ORDER BY created_at DESC LIMIT 1").get(contactId, orgId) as any;
      if (!ticket) return; // sem ticket aberto, não há a quem notificar via cadência
      CadenceService.startForTicket(orgId, ticket.id, contactId, trigger);
    } catch (e) { console.error("[ClinicAuth] Falha ao disparar cadência", trigger, e); }
  }
}
