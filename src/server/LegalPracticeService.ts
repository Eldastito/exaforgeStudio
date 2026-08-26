import db from "./db.js";
import { ClinicSpecialtyService } from "./ClinicSpecialtyService.js";
import { ClinicAgendaService } from "./ClinicAgendaService.js";

/**
 * Legal Practice (ADR-191 F3) — áreas do direito + advogados.
 *
 * COMPOSIÇÃO PURA, zero tabela nova: áreas do direito reusam `clinic_specialties`
 * (via `ClinicSpecialtyService`) e advogados reusam `clinic_professionals` (via
 * `ClinicAgendaService`) — o modelo de profissional JÁ tem `council` +
 * `registration_number`, então a OAB cabe direto (`council='OAB'`,
 * `registration_number='SP 123456'`). O vínculo advogado↔área reusa o N:N
 * `clinic_professional_specialties`. Nada de motor novo.
 *
 * HONESTIDADE (RN-ADV-08 análogo): a OAB é VALIDADA no formato (UF + número),
 * nunca inventada — entrada malformada é rejeitada; ausente fica em branco.
 * Isolado por org.
 */

const UFS = new Set([
  "AC", "AL", "AP", "AM", "BA", "CE", "DF", "ES", "GO", "MA", "MT", "MS", "MG",
  "PA", "PB", "PR", "PE", "PI", "RJ", "RN", "RS", "RO", "RR", "SC", "SP", "SE", "TO",
]);

// Áreas do direito mais comuns (seed opcional; o escritório edita/adiciona depois).
const DEFAULT_AREAS = ["Cível", "Trabalhista", "Penal", "Família", "Tributário", "Empresarial", "Consumidor", "Previdenciário"];

export interface LawyerInput {
  name: string;
  oabUf?: string | null;
  oabNumber?: string | null;
  color?: string | null;
  userId?: string | null;
  areaIds?: string[];
}

export class LegalPracticeService {
  // ── Áreas do direito (reuso de clinic_specialties) ──

  static listAreas(orgId: string, opts: { includeInactive?: boolean } = {}) {
    return ClinicSpecialtyService.list(orgId, opts);
  }

  static createArea(orgId: string, input: { name: string; code?: string | null; color?: string | null }, actorId: string | null = null) {
    return ClinicSpecialtyService.create(orgId, { name: input.name, code: input.code ?? null, color: input.color ?? null }, actorId);
  }

  /** Semeia as áreas comuns (idempotente — não duplica as que já existem). */
  static seedDefaultAreas(orgId: string, actorId: string | null = null): { created: number } {
    const existing = new Set(this.listAreas(orgId, { includeInactive: true }).map((a: any) => String(a.name).toLowerCase()));
    let created = 0;
    for (const name of DEFAULT_AREAS) {
      if (existing.has(name.toLowerCase())) continue;
      try { this.createArea(orgId, { name }, actorId); created += 1; } catch { /* corrida/duplicata → ignora */ }
    }
    return { created };
  }

  // ── Advogados (reuso de clinic_professionals; OAB em council+registration) ──

  /** Valida + normaliza a OAB. Nunca inventa: formato inválido → lança; ausente → null. */
  static normalizeOab(uf?: string | null, number?: string | null): { registrationNumber: string | null } {
    const u = String(uf || "").trim().toUpperCase();
    const n = String(number || "").replace(/\D/g, "");
    if (!u && !n) return { registrationNumber: null }; // sem OAB → em branco (honesto)
    if (!UFS.has(u)) throw new Error(`UF da OAB inválida: "${uf}".`);
    if (!n || n.length < 3 || n.length > 7) throw new Error(`Número da OAB inválido: "${number}".`);
    return { registrationNumber: `${u} ${n}` };
  }

  static listLawyers(orgId: string, includeInactive = false): any[] {
    return ClinicAgendaService.listProfessionals(orgId, includeInactive);
  }

  static createLawyer(orgId: string, input: LawyerInput, actorId?: string): any {
    const name = String(input?.name || "").trim();
    if (!name) throw new Error("Dê um nome ao advogado.");
    const { registrationNumber } = this.normalizeOab(input.oabUf, input.oabNumber);
    const lawyer = ClinicAgendaService.createProfessional(
      orgId,
      { name, color: input.color ?? undefined, userId: input.userId ?? undefined, council: "OAB", registrationNumber: registrationNumber ?? undefined },
      actorId,
    );
    // Vincula às áreas do direito (reuso do N:N).
    if (Array.isArray(input.areaIds) && input.areaIds.length) {
      ClinicSpecialtyService.setProfessionalSpecialties(orgId, lawyer.id, input.areaIds.map((id, i) => ({ specialtyId: id, isPrimary: i === 0 })), actorId ?? null);
    }
    return db.prepare("SELECT * FROM clinic_professionals WHERE id = ?").get(lawyer.id);
  }

  /** Áreas do direito de um advogado (reuso do N:N). */
  static areasForLawyer(orgId: string, lawyerId: string) {
    return ClinicSpecialtyService.listSpecialtiesForProfessional(orgId, lawyerId);
  }

  static setLawyerAreas(orgId: string, lawyerId: string, areaIds: string[], actorId: string | null = null) {
    return ClinicSpecialtyService.setProfessionalSpecialties(orgId, lawyerId, areaIds.map((id, i) => ({ specialtyId: id, isPrimary: i === 0 })), actorId);
  }
}

export default LegalPracticeService;
