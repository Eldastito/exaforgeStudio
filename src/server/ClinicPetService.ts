/**
 * ClinicPetService — Petshop F3: Ficha do PET + carteira de vacinação.
 *
 * O `contact` é a PESSOA (tutor). O PET é entidade própria que pertence a um tutor
 * (1 tutor → N pets). Este service dá CRUD do pet, a carteira de vacinação e a
 * detecção de doses vencidas/a vencer que alimenta os lembretes (business_signals —
 * conv. nº 12, nunca tabela de alerta paralela).
 *
 * Guardrails: isolamento multi-tenant (orgId 1º arg em toda query); idade DERIVADA
 * de birth_date (RN-004, sem contador mutável); nunca inventa dado (campos vazios
 * ficam null); valida que o tutor existe na org antes de criar o pet. Determinístico
 * (datas passáveis como `nowISO` p/ testar sem relógio).
 */
import { randomUUID } from "crypto";
import db from "./db.js";
import { logAuthEvent } from "./auditLog.js";

const SPECIES = new Set(["cachorro", "gato", "ave", "roedor", "reptil", "outro"]);
const SEX = new Set(["male", "female", "unknown"]);
const SIZE = new Set(["small", "medium", "large", "giant"]);

export interface PetInput {
  tutorContactId?: string; name?: string; species?: string | null; breed?: string | null;
  sex?: string | null; size?: string | null; weightKg?: number | null; birthDate?: string | null;
  color?: string | null; microchip?: string | null; neutered?: boolean; notes?: string | null;
}
export interface VaccinationInput {
  vaccine?: string; dose?: string | null; appliedAt?: string | null; nextDueAt?: string | null;
  professionalId?: string | null; lote?: string | null; notes?: string | null;
}

export class ClinicPetService {
  /** Idade DERIVADA (anos/meses) a partir de birth_date. null sem data (não inventa). */
  static computeAge(birthDate?: string | null, nowISO?: string): { years: number; months: number; label: string } | null {
    if (!birthDate) return null;
    const b = new Date(birthDate + (birthDate.length <= 10 ? "T00:00:00Z" : ""));
    if (isNaN(b.getTime())) return null;
    const now = nowISO ? new Date(nowISO) : new Date();
    if (now.getTime() < b.getTime()) return null;
    let months = (now.getUTCFullYear() - b.getUTCFullYear()) * 12 + (now.getUTCMonth() - b.getUTCMonth());
    if (now.getUTCDate() < b.getUTCDate()) months -= 1;
    if (months < 0) months = 0;
    const years = Math.floor(months / 12); const rem = months % 12;
    const label = years > 0 ? `${years} ano${years > 1 ? "s" : ""}${rem ? ` e ${rem} m${rem > 1 ? "eses" : "ês"}` : ""}` : `${rem} m${rem === 1 ? "ês" : "eses"}`;
    return { years, months: rem, label };
  }

  private static mapPet(r: any, nowISO?: string) {
    return {
      id: r.id, tutorContactId: r.tutor_contact_id, name: r.name,
      species: r.species ?? null, breed: r.breed ?? null, sex: r.sex ?? null, size: r.size ?? null,
      weightKg: r.weight_kg ?? null, birthDate: r.birth_date ?? null, color: r.color ?? null,
      microchip: r.microchip ?? null, neutered: !!r.neutered, notes: r.notes ?? null, status: r.status,
      age: this.computeAge(r.birth_date, nowISO),
      createdAt: r.created_at, updatedAt: r.updated_at,
    };
  }

  static get(orgId: string, petId: string, nowISO?: string): any | null {
    const r = db.prepare(`SELECT * FROM clinic_pets WHERE organization_id = ? AND id = ?`).get(orgId, petId) as any;
    return r ? this.mapPet(r, nowISO) : null;
  }

  /** Pets de um tutor (default só ativos). */
  static listByTutor(orgId: string, tutorContactId: string, opts?: { includeInactive?: boolean; nowISO?: string }): any[] {
    const rows = opts?.includeInactive
      ? db.prepare(`SELECT * FROM clinic_pets WHERE organization_id = ? AND tutor_contact_id = ? ORDER BY name`).all(orgId, tutorContactId) as any[]
      : db.prepare(`SELECT * FROM clinic_pets WHERE organization_id = ? AND tutor_contact_id = ? AND status = 'active' ORDER BY name`).all(orgId, tutorContactId) as any[];
    return rows.map((r) => this.mapPet(r, opts?.nowISO));
  }

  static create(orgId: string, input: PetInput, actorId?: string): { id: string } {
    const tutor = String(input.tutorContactId || "").trim();
    const name = String(input.name || "").trim();
    if (!tutor) throw new Error("tutorContactId é obrigatório.");
    if (!name) throw new Error("name é obrigatório.");
    // Valida que o tutor existe NA ORG (não inventa dono).
    const exists = db.prepare(`SELECT 1 FROM contacts WHERE organization_id = ? AND id = ?`).get(orgId, tutor);
    if (!exists) throw new Error("tutor (contato) não encontrado nesta organização.");
    if (input.species != null && input.species !== "" && !SPECIES.has(String(input.species))) throw new Error("species inválida.");
    if (input.sex != null && input.sex !== "" && !SEX.has(String(input.sex))) throw new Error("sex inválido.");
    if (input.size != null && input.size !== "" && !SIZE.has(String(input.size))) throw new Error("size (porte) inválido.");
    const id = randomUUID();
    db.prepare(`
      INSERT INTO clinic_pets (id, organization_id, tutor_contact_id, name, species, breed, sex, size, weight_kg, birth_date, color, microchip, neutered, notes, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, orgId, tutor, name.slice(0, 120),
      input.species || null, input.breed ? String(input.breed).slice(0, 120) : null,
      input.sex || null, input.size || null,
      typeof input.weightKg === "number" ? input.weightKg : null,
      input.birthDate || null, input.color ? String(input.color).slice(0, 60) : null,
      input.microchip ? String(input.microchip).slice(0, 60) : null,
      input.neutered ? 1 : 0, input.notes ? String(input.notes).slice(0, 2000) : null, actorId || null);
    try { logAuthEvent(orgId, actorId || "system", orgId, "CLINIC_PET_CREATE", { id, tutor }); } catch { /* noop */ }
    return { id };
  }

  static update(orgId: string, petId: string, patch: PetInput & { status?: string }, actorId?: string): { updated: boolean } {
    const cur = db.prepare(`SELECT * FROM clinic_pets WHERE organization_id = ? AND id = ?`).get(orgId, petId) as any;
    if (!cur) throw new Error("pet não encontrado.");
    if (patch.species != null && patch.species !== "" && !SPECIES.has(String(patch.species))) throw new Error("species inválida.");
    if (patch.sex != null && patch.sex !== "" && !SEX.has(String(patch.sex))) throw new Error("sex inválido.");
    if (patch.size != null && patch.size !== "" && !SIZE.has(String(patch.size))) throw new Error("size (porte) inválido.");
    const pick = <T>(v: T | undefined, cur: any) => (v === undefined ? cur : v);
    const next = {
      name: patch.name !== undefined ? String(patch.name).trim().slice(0, 120) : cur.name,
      species: pick(patch.species, cur.species) || null,
      breed: patch.breed !== undefined ? (patch.breed ? String(patch.breed).slice(0, 120) : null) : cur.breed,
      sex: pick(patch.sex, cur.sex) || null,
      size: pick(patch.size, cur.size) || null,
      weight_kg: patch.weightKg !== undefined ? (typeof patch.weightKg === "number" ? patch.weightKg : null) : cur.weight_kg,
      birth_date: patch.birthDate !== undefined ? (patch.birthDate || null) : cur.birth_date,
      color: patch.color !== undefined ? (patch.color ? String(patch.color).slice(0, 60) : null) : cur.color,
      microchip: patch.microchip !== undefined ? (patch.microchip ? String(patch.microchip).slice(0, 60) : null) : cur.microchip,
      neutered: patch.neutered !== undefined ? (patch.neutered ? 1 : 0) : cur.neutered,
      notes: patch.notes !== undefined ? (patch.notes ? String(patch.notes).slice(0, 2000) : null) : cur.notes,
      status: patch.status !== undefined ? String(patch.status) : cur.status,
    };
    if (!next.name) throw new Error("name é obrigatório.");
    if (!["active", "inactive", "deceased"].includes(next.status)) throw new Error("status inválido.");
    db.prepare(`
      UPDATE clinic_pets SET name=@name, species=@species, breed=@breed, sex=@sex, size=@size, weight_kg=@weight_kg,
        birth_date=@birth_date, color=@color, microchip=@microchip, neutered=@neutered, notes=@notes, status=@status,
        updated_at=CURRENT_TIMESTAMP WHERE organization_id=@org AND id=@id
    `).run({ ...next, org: orgId, id: petId });
    try { logAuthEvent(orgId, actorId || "system", orgId, "CLINIC_PET_UPDATE", { id: petId }); } catch { /* noop */ }
    return { updated: true };
  }

  // ── Carteira de vacinação ──────────────────────────────────────────────────

  private static mapVax(r: any) {
    return {
      id: r.id, petId: r.pet_id, vaccine: r.vaccine, dose: r.dose ?? null,
      appliedAt: r.applied_at ?? null, nextDueAt: r.next_due_at ?? null,
      professionalId: r.professional_id ?? null, lote: r.lote ?? null, notes: r.notes ?? null,
      status: r.status, createdAt: r.created_at,
    };
  }

  static listVaccinations(orgId: string, petId: string): any[] {
    const rows = db.prepare(`SELECT * FROM clinic_pet_vaccinations WHERE organization_id = ? AND pet_id = ? ORDER BY COALESCE(applied_at, next_due_at) DESC, created_at DESC`).all(orgId, petId) as any[];
    return rows.map((r) => this.mapVax(r));
  }

  static addVaccination(orgId: string, petId: string, input: VaccinationInput, actorId?: string): { id: string } {
    const pet = db.prepare(`SELECT 1 FROM clinic_pets WHERE organization_id = ? AND id = ?`).get(orgId, petId);
    if (!pet) throw new Error("pet não encontrado.");
    const vaccine = String(input.vaccine || "").trim();
    if (!vaccine) throw new Error("vaccine é obrigatório.");
    const id = randomUUID();
    db.prepare(`
      INSERT INTO clinic_pet_vaccinations (id, organization_id, pet_id, vaccine, dose, applied_at, next_due_at, professional_id, lote, notes, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, orgId, petId, vaccine.slice(0, 80), input.dose ? String(input.dose).slice(0, 40) : null,
      input.appliedAt || null, input.nextDueAt || null, input.professionalId || null,
      input.lote ? String(input.lote).slice(0, 60) : null, input.notes ? String(input.notes).slice(0, 1000) : null, actorId || null);
    try { logAuthEvent(orgId, actorId || "system", orgId, "CLINIC_PET_VACCINATION_ADD", { id, petId, vaccine }); } catch { /* noop */ }
    return { id };
  }

  /** Situação de uma dose vs uma data de referência: due (a vencer) / overdue / ok. */
  static vaccinationStatus(nextDueAt?: string | null, nowISO?: string, dueWindowDays = 30): "no_due" | "ok" | "due" | "overdue" {
    if (!nextDueAt) return "no_due";
    const due = new Date(nextDueAt + (nextDueAt.length <= 10 ? "T00:00:00Z" : ""));
    if (isNaN(due.getTime())) return "no_due";
    const now = nowISO ? new Date(nowISO) : new Date();
    const diffDays = Math.floor((due.getTime() - now.getTime()) / 86400000);
    if (diffDays < 0) return "overdue";
    if (diffDays <= dueWindowDays) return "due";
    return "ok";
  }

  /**
   * Doses vencidas/a vencer da org (para lembrete). Só pets ativos, doses `applied`
   * com `next_due_at` dentro da janela (ou já vencidas). Determinístico (nowISO).
   */
  static dueVaccinations(orgId: string, opts?: { withinDays?: number; nowISO?: string }): Array<{ vaccinationId: string; petId: string; petName: string; tutorContactId: string; vaccine: string; nextDueAt: string; status: "due" | "overdue" }> {
    const within = opts?.withinDays ?? 30;
    const rows = db.prepare(`
      SELECT v.id vid, v.pet_id, v.vaccine, v.next_due_at, p.name pet_name, p.tutor_contact_id
      FROM clinic_pet_vaccinations v JOIN clinic_pets p ON p.id = v.pet_id AND p.organization_id = v.organization_id
      WHERE v.organization_id = ? AND v.status = 'applied' AND v.next_due_at IS NOT NULL AND p.status = 'active'
    `).all(orgId) as any[];
    const out: any[] = [];
    for (const r of rows) {
      const st = this.vaccinationStatus(r.next_due_at, opts?.nowISO, within);
      if (st === "due" || st === "overdue") {
        out.push({ vaccinationId: r.vid, petId: r.pet_id, petName: r.pet_name, tutorContactId: r.tutor_contact_id, vaccine: r.vaccine, nextDueAt: r.next_due_at, status: st });
      }
    }
    return out.sort((a, b) => a.nextDueAt.localeCompare(b.nextDueAt));
  }

  /**
   * Publica lembretes de vacina no ledger `business_signals` (conv. nº 12 — sem
   * tabela de alerta paralela). Idempotente por dedupe `clinic:pet_vaccine_due:<vid>`.
   * Best-effort; nunca inventa (só o que está na carteira). Retorna quantos publicou.
   */
  static async publishVaccinationReminders(orgId: string, opts?: { withinDays?: number; nowISO?: string }): Promise<{ published: number }> {
    const due = this.dueVaccinations(orgId, opts);
    if (due.length === 0) return { published: 0 };
    let published = 0;
    try {
      const { BusinessSignalService } = await import("./BusinessSignalService.js");
      for (const d of due) {
        BusinessSignalService.publish(orgId, {
          domain: "clinic", signalType: "pet_vaccination_due", severity: d.status === "overdue" ? "attention" : "info",
          basis: "fact", confidence: 1, sourceService: "ClinicPetService", sourceEntityType: "clinic_pet_vaccination", sourceEntityId: d.vaccinationId,
          subjectType: "pet", subjectId: d.petId,
          evidence: { petName: d.petName, vaccine: d.vaccine, nextDueAt: d.nextDueAt, status: d.status, tutorContactId: d.tutorContactId, note: `Vacina ${d.vaccine} de ${d.petName} ${d.status === "overdue" ? "venceu" : "vence em breve"} (${d.nextDueAt}).` },
          dedupeKey: `clinic:pet_vaccine_due:${d.vaccinationId}`,
        });
        published++;
      }
    } catch { /* best-effort */ }
    return { published };
  }

  /** Passe do Scheduler: lembretes de vacina por org com pets (best-effort). */
  static async passVaccinationReminders(): Promise<void> {
    const orgs = db.prepare(`SELECT DISTINCT organization_id AS org FROM clinic_pets WHERE status = 'active'`).all() as any[];
    for (const o of orgs) { try { await this.publishVaccinationReminders(o.org); } catch { /* noop */ } }
  }
}

export default ClinicPetService;
