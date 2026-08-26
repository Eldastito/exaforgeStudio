/**
 * ClinicPetHistoryService — Petshop F6: histórico de saúde do PET (timeline).
 *
 * Consolida READ-ONLY, por PET, os eventos que já existem em outras tabelas —
 * vacinas (F3), internações (F5), cirurgias (F5) e atendimentos/banho&tosa (F4,
 * appointments com pet_id). Sem tabela nova (agregação); isolado por org; nunca
 * inventa (só o que está registrado).
 */
import db from "./db.js";

export type PetHistoryKind = "vaccination" | "treatment" | "hospitalization" | "surgery" | "appointment" | "grooming";
export interface PetHistoryEvent {
  kind: PetHistoryKind;
  at: string | null;      // ISO — chave de ordenação (mais recente primeiro)
  title: string;          // linha curta pra UI
  detail: string | null;  // complemento (motivo/dose/status)
  status: string | null;  // status do evento quando aplicável
  refId: string;          // id do registro de origem
}

export class ClinicPetHistoryService {
  /** Histórico consolidado do pet (mais recente primeiro). `limit` 1..500 (default 200). */
  static history(orgId: string, petId: string, opts?: { limit?: number; kinds?: PetHistoryKind[] }): PetHistoryEvent[] {
    const pet = db.prepare(`SELECT id FROM clinic_pets WHERE organization_id = ? AND id = ?`).get(orgId, String(petId || ""));
    if (!pet) return [];
    const want = (k: PetHistoryKind) => !opts?.kinds || opts.kinds.includes(k);
    const events: PetHistoryEvent[] = [];

    if (want("vaccination")) {
      const rows = db.prepare(`SELECT id, vaccine, dose, applied_at, next_due_at, status, created_at FROM clinic_pet_vaccinations WHERE organization_id = ? AND pet_id = ?`).all(orgId, petId) as any[];
      for (const r of rows) {
        events.push({
          kind: "vaccination", at: r.applied_at || r.created_at || null,
          title: `Vacina ${r.vaccine}`,
          detail: [r.dose, r.next_due_at ? `próxima ${r.next_due_at}` : null].filter(Boolean).join(" · ") || null,
          status: r.status || null, refId: r.id,
        });
      }
    }
    if (want("treatment")) {
      const LABEL: Record<string, string> = { vermifugo: "Vermífugo", antipulga: "Antipulgas", carrapaticida: "Carrapaticida", outro: "Tratamento" };
      const rows = db.prepare(`SELECT id, treatment_type, product, applied_at, next_due_at, status, created_at FROM clinic_pet_preventive_treatments WHERE organization_id = ? AND pet_id = ?`).all(orgId, petId) as any[];
      for (const r of rows) {
        events.push({
          kind: "treatment", at: r.applied_at || r.created_at || null,
          title: LABEL[r.treatment_type] || "Tratamento",
          detail: [r.product, r.next_due_at ? `próxima ${r.next_due_at}` : null].filter(Boolean).join(" · ") || null,
          status: r.status || null, refId: r.id,
        });
      }
    }
    if (want("hospitalization")) {
      const rows = db.prepare(`SELECT id, reason, admitted_at, discharged_at, status FROM clinic_pet_hospitalizations WHERE organization_id = ? AND pet_id = ?`).all(orgId, petId) as any[];
      for (const r of rows) {
        events.push({
          kind: "hospitalization", at: r.admitted_at || null,
          title: "Internação",
          detail: [r.reason, r.discharged_at ? `alta ${r.discharged_at}` : "internado"].filter(Boolean).join(" · ") || null,
          status: r.status || null, refId: r.id,
        });
      }
    }
    if (want("surgery")) {
      const rows = db.prepare(`SELECT id, procedure_name, scheduled_at, performed_at, status FROM clinic_pet_surgeries WHERE organization_id = ? AND pet_id = ?`).all(orgId, petId) as any[];
      for (const r of rows) {
        events.push({
          kind: "surgery", at: r.performed_at || r.scheduled_at || null,
          title: `Cirurgia: ${r.procedure_name}`,
          detail: r.performed_at ? `realizada ${r.performed_at}` : r.scheduled_at ? `prevista ${r.scheduled_at}` : null,
          status: r.status || null, refId: r.id,
        });
      }
    }
    if (want("appointment") || want("grooming")) {
      const rows = db.prepare(`
        SELECT a.id, a.title, a.scheduled_start, a.status, a.professional_name_snapshot, a.grooming_service_id, g.name AS grooming_name
        FROM appointments a LEFT JOIN clinic_grooming_services g ON g.id = a.grooming_service_id AND g.organization_id = a.organization_id
        WHERE a.organization_id = ? AND a.pet_id = ?
      `).all(orgId, petId) as any[];
      for (const r of rows) {
        const isGrooming = !!r.grooming_service_id;
        if (isGrooming ? !want("grooming") : !want("appointment")) continue;
        events.push({
          kind: isGrooming ? "grooming" : "appointment",
          at: r.scheduled_start || null,
          title: isGrooming ? `Banho & tosa: ${r.grooming_name || r.title || "serviço"}` : `Atendimento: ${r.title || "consulta"}`,
          detail: r.professional_name_snapshot || null,
          status: r.status || null, refId: r.id,
        });
      }
    }

    events.sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")));
    const limit = Math.min(Math.max(Number(opts?.limit) || 200, 1), 500);
    return events.slice(0, limit);
  }
}

export default ClinicPetHistoryService;
