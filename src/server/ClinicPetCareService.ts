/**
 * ClinicPetCareService — Petshop F5: internação, cirurgia (checklist) e plano de saúde.
 *
 * - Internação: entrada/alta do pet, com motivo e responsável.
 * - Cirurgia: registro do procedimento + checklist pré-operatório ({label, done}).
 * - Plano de saúde: ATRIBUTO do pet (o que está coberto). A COBRANÇA recorrente é do
 *   módulo Assinaturas (reuso — sem motor de billing paralelo); aqui só guardamos qual
 *   plano o pet tem.
 *
 * Guardrails: isolamento multi-tenant (orgId 1º arg); valida pet da MESMA org; nunca
 * inventa dado; read/write determinístico. Não cria alerta/scheduler novo.
 */
import { randomUUID } from "crypto";
import db from "./db.js";
import { logAuthEvent } from "./auditLog.js";

const CHECKLIST_DEFAULT = ["Jejum confirmado", "Exames pré-operatórios", "Avaliação anestésica", "Consentimento do tutor"];

export class ClinicPetCareService {
  private static assertPet(orgId: string, petId: string): any {
    const pet = db.prepare(`SELECT id, name, status FROM clinic_pets WHERE organization_id = ? AND id = ?`).get(orgId, String(petId || "")) as any;
    if (!pet) throw new Error("pet não encontrado.");
    return pet;
  }

  // ── Plano de saúde pet (atributo do pet) ────────────────────────────────────
  static setHealthPlan(orgId: string, petId: string, input: { name?: string | null; status?: string | null }, actorId?: string): { updated: boolean } {
    this.assertPet(orgId, petId);
    const name = input.name != null ? String(input.name).trim().slice(0, 120) : null;
    const status = name ? (input.status === "inactive" ? "inactive" : "active") : null; // sem nome = sem plano
    db.prepare(`UPDATE clinic_pets SET health_plan_name = ?, health_plan_status = ?, updated_at = CURRENT_TIMESTAMP WHERE organization_id = ? AND id = ?`)
      .run(name, status, orgId, petId);
    try { logAuthEvent(orgId, actorId || "system", orgId, "CLINIC_PET_HEALTH_PLAN_SET", { petId, name, status }); } catch { /* noop */ }
    return { updated: true };
  }

  // ── Internação ──────────────────────────────────────────────────────────────
  private static mapHosp(r: any) {
    return { id: r.id, petId: r.pet_id, reason: r.reason ?? null, professionalId: r.professional_id ?? null, admittedAt: r.admitted_at, dischargedAt: r.discharged_at ?? null, status: r.status, notes: r.notes ?? null, petName: r.pet_name ?? undefined };
  }

  static admit(orgId: string, petId: string, input: { reason?: string; professionalId?: string; notes?: string }, actorId?: string): { id: string } {
    this.assertPet(orgId, petId);
    // Não interna duas vezes o mesmo pet (uma internação ativa por vez).
    const open = db.prepare(`SELECT 1 FROM clinic_pet_hospitalizations WHERE organization_id = ? AND pet_id = ? AND status = 'admitted'`).get(orgId, petId);
    if (open) throw new Error("pet já está internado.");
    const id = randomUUID();
    db.prepare(`INSERT INTO clinic_pet_hospitalizations (id, organization_id, pet_id, reason, professional_id, notes, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(id, orgId, petId, input.reason ? String(input.reason).slice(0, 500) : null, input.professionalId || null, input.notes ? String(input.notes).slice(0, 2000) : null, actorId || null);
    try { logAuthEvent(orgId, actorId || "system", orgId, "CLINIC_PET_ADMIT", { id, petId }); } catch { /* noop */ }
    return { id };
  }

  static discharge(orgId: string, hospitalizationId: string, input?: { notes?: string }, actorId?: string): { discharged: boolean } {
    const cur = db.prepare(`SELECT * FROM clinic_pet_hospitalizations WHERE organization_id = ? AND id = ?`).get(orgId, hospitalizationId) as any;
    if (!cur) throw new Error("internação não encontrada.");
    if (cur.status === "discharged") throw new Error("internação já teve alta.");
    const notes = input?.notes != null ? String(input.notes).slice(0, 2000) : cur.notes;
    db.prepare(`UPDATE clinic_pet_hospitalizations SET status = 'discharged', discharged_at = CURRENT_TIMESTAMP, notes = ?, updated_at = CURRENT_TIMESTAMP WHERE organization_id = ? AND id = ?`)
      .run(notes, orgId, hospitalizationId);
    try { logAuthEvent(orgId, actorId || "system", orgId, "CLINIC_PET_DISCHARGE", { id: hospitalizationId }); } catch { /* noop */ }
    return { discharged: true };
  }

  static listHospitalizations(orgId: string, petId: string): any[] {
    const rows = db.prepare(`SELECT * FROM clinic_pet_hospitalizations WHERE organization_id = ? AND pet_id = ? ORDER BY admitted_at DESC`).all(orgId, petId) as any[];
    return rows.map((r) => this.mapHosp(r));
  }

  /** Internações ATIVAS da org (pets internados agora) — para o painel de internação. */
  static activeHospitalizations(orgId: string): any[] {
    const rows = db.prepare(`
      SELECT h.*, p.name AS pet_name FROM clinic_pet_hospitalizations h
      JOIN clinic_pets p ON p.id = h.pet_id AND p.organization_id = h.organization_id
      WHERE h.organization_id = ? AND h.status = 'admitted' ORDER BY h.admitted_at
    `).all(orgId) as any[];
    return rows.map((r) => this.mapHosp(r));
  }

  // ── Cirurgia + checklist pré-operatório ─────────────────────────────────────
  private static mapSurgery(r: any) {
    let checklist: Array<{ label: string; done: boolean }> = [];
    try { checklist = JSON.parse(r.checklist_json || "[]"); } catch { checklist = []; }
    return { id: r.id, petId: r.pet_id, procedureName: r.procedure_name, professionalId: r.professional_id ?? null, scheduledAt: r.scheduled_at ?? null, performedAt: r.performed_at ?? null, status: r.status, checklist, notes: r.notes ?? null };
  }

  static scheduleSurgery(orgId: string, petId: string, input: { procedureName?: string; professionalId?: string; scheduledAt?: string; checklist?: Array<{ label: string; done?: boolean }>; notes?: string }, actorId?: string): { id: string } {
    this.assertPet(orgId, petId);
    const name = String(input.procedureName || "").trim();
    if (!name) throw new Error("procedureName é obrigatório.");
    const checklist = (Array.isArray(input.checklist) && input.checklist.length ? input.checklist : CHECKLIST_DEFAULT.map((label) => ({ label })))
      .map((c: any) => ({ label: String(c.label || "").slice(0, 120), done: !!c.done })).filter((c) => c.label);
    const id = randomUUID();
    db.prepare(`INSERT INTO clinic_pet_surgeries (id, organization_id, pet_id, procedure_name, professional_id, scheduled_at, checklist_json, notes, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, orgId, petId, name.slice(0, 120), input.professionalId || null, input.scheduledAt || null, JSON.stringify(checklist), input.notes ? String(input.notes).slice(0, 2000) : null, actorId || null);
    try { logAuthEvent(orgId, actorId || "system", orgId, "CLINIC_PET_SURGERY_SCHEDULE", { id, petId, name }); } catch { /* noop */ }
    return { id };
  }

  /** Marca/desmarca um item do checklist pré-operatório. */
  static setChecklistItem(orgId: string, surgeryId: string, index: number, done: boolean, actorId?: string): { checklist: Array<{ label: string; done: boolean }> } {
    const cur = db.prepare(`SELECT * FROM clinic_pet_surgeries WHERE organization_id = ? AND id = ?`).get(orgId, surgeryId) as any;
    if (!cur) throw new Error("cirurgia não encontrada.");
    const s = this.mapSurgery(cur);
    if (index < 0 || index >= s.checklist.length) throw new Error("item do checklist inválido.");
    s.checklist[index].done = !!done;
    db.prepare(`UPDATE clinic_pet_surgeries SET checklist_json = ?, updated_at = CURRENT_TIMESTAMP WHERE organization_id = ? AND id = ?`).run(JSON.stringify(s.checklist), orgId, surgeryId);
    return { checklist: s.checklist };
  }

  /** Conclui/cancela a cirurgia. done exige checklist 100% (segurança pré-operatória). */
  static setSurgeryStatus(orgId: string, surgeryId: string, status: "done" | "cancelled", actorId?: string): { status: string } {
    const cur = db.prepare(`SELECT * FROM clinic_pet_surgeries WHERE organization_id = ? AND id = ?`).get(orgId, surgeryId) as any;
    if (!cur) throw new Error("cirurgia não encontrada.");
    if (!["done", "cancelled"].includes(status)) throw new Error("status inválido.");
    if (status === "done") {
      const s = this.mapSurgery(cur);
      if (s.checklist.length && s.checklist.some((c) => !c.done)) throw new Error("checklist pré-operatório incompleto — conclua todos os itens antes.");
      db.prepare(`UPDATE clinic_pet_surgeries SET status = 'done', performed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE organization_id = ? AND id = ?`).run(orgId, surgeryId);
    } else {
      db.prepare(`UPDATE clinic_pet_surgeries SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE organization_id = ? AND id = ?`).run(orgId, surgeryId);
    }
    try { logAuthEvent(orgId, actorId || "system", orgId, "CLINIC_PET_SURGERY_STATUS", { id: surgeryId, status }); } catch { /* noop */ }
    return { status };
  }

  static listSurgeries(orgId: string, petId: string): any[] {
    const rows = db.prepare(`SELECT * FROM clinic_pet_surgeries WHERE organization_id = ? AND pet_id = ? ORDER BY COALESCE(scheduled_at, created_at) DESC`).all(orgId, petId) as any[];
    return rows.map((r) => this.mapSurgery(r));
  }
}

export default ClinicPetCareService;
