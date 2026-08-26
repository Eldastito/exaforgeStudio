import db from "./db.js";
import { logAuthEvent } from "./auditLog.js";
import { ProfessionalService } from "./ProfessionalService.js";
import { ClinicProfessionalRelationshipService } from "./ClinicProfessionalRelationshipService.js";

/**
 * Legal Professional Federation (ADR-191 OAB-F1) — a PONTE DE IDENTIDADE.
 *
 * Liga o advogado da Advocacia (um `clinic_professional` por-org, ADR-191 F3, com
 * `council='OAB'` + `registration_number`) à IDENTIDADE GLOBAL federada da Agenda
 * Federada (ADR-180). É a única peça nova da federação OAB — o resto é composição
 * das peças já provadas da ADR-180 (§184: nenhum motor/scheduler/policy novo).
 *
 * `federate` reusa `ClinicProfessionalRelationshipService.invite({identity})` (que já
 * faz o `ProfessionalService.upsertIdentity` idempotente — RN-PN-3, nunca sobrescreve)
 * + `accept`. `status` é DERIVADO por query (RN-004, sem coluna nova). `defederate`
 * revoga o VÍNCULO desta org, NUNCA apaga a identidade global (o advogado continua
 * existindo pro ecossistema e pros outros escritórios — RN-PN-3).
 *
 * Opt-in: exige `professional_network_enabled` (RN-PN-8, gate server-side). Isolado por org.
 */

function lawyerRow(orgId: string, lawyerId: string): any {
  return db.prepare(`SELECT id, name, council, registration_number FROM clinic_professionals WHERE organization_id = ? AND id = ?`).get(orgId, lawyerId) || null;
}

function networkEnabled(orgId: string): boolean {
  const o = db.prepare(`SELECT professional_network_enabled AS net FROM organization_settings WHERE organization_id = ?`).get(orgId) as any;
  return !!(o && Number(o.net) === 1);
}

function assertOab(lawyer: any): { council: string; registrationNumber: string; name: string } {
  const council = String(lawyer?.council || "").trim();
  const registrationNumber = String(lawyer?.registration_number || "").trim();
  if (council.toUpperCase() !== "OAB" || !registrationNumber) {
    throw new Error("Advogado sem OAB cadastrada — registre a OAB antes de federar.");
  }
  return { council: "OAB", registrationNumber, name: String(lawyer.name || "").trim() };
}

export class LegalProfessionalFederationService {
  /** Estado da federação de um advogado (DERIVADO — RN-004). */
  static status(orgId: string, lawyerId: string): { federated: boolean; hasOab: boolean; professionalId: string | null; relationshipId: string | null; relationshipStatus: string | null } {
    const lawyer = lawyerRow(orgId, lawyerId);
    if (!lawyer) throw new Error("Advogado não encontrado.");
    const council = String(lawyer.council || "").trim();
    const registration = String(lawyer.registration_number || "").trim();
    const hasOab = council.toUpperCase() === "OAB" && !!registration;
    if (!hasOab) return { federated: false, hasOab: false, professionalId: null, relationshipId: null, relationshipStatus: null };
    const prof = ProfessionalService.findByRegistration("OAB", registration);
    if (!prof) return { federated: false, hasOab: true, professionalId: null, relationshipId: null, relationshipStatus: null };
    const rel = ClinicProfessionalRelationshipService.getByProfessional(orgId, prof.id);
    return {
      federated: rel?.status === "accepted",
      hasOab: true,
      professionalId: prof.id,
      relationshipId: rel?.id || null,
      relationshipStatus: rel?.status || null,
    };
  }

  /** Federa o advogado: garante a identidade global + vínculo aceito desta org. Idempotente. */
  static federate(orgId: string, lawyerId: string, actorId: string | null = null): any {
    if (!networkEnabled(orgId)) throw new Error("Rede profissional desativada — ative a rede antes de federar.");
    const lawyer = lawyerRow(orgId, lawyerId);
    if (!lawyer) throw new Error("Advogado não encontrado.");
    const identity = assertOab(lawyer);

    // invite({identity}) faz o upsertIdentity (idempotente) + cria/reusa o bridge (pending|reativado).
    const rel = ClinicProfessionalRelationshipService.invite(orgId, { identity }, actorId || undefined);
    // aceita o vínculo (no-op se já accepted).
    const accepted = ClinicProfessionalRelationshipService.accept(orgId, rel.id, actorId || undefined);
    logAuthEvent(orgId, actorId, lawyerId, "LEGAL_PROFESSIONAL_FEDERATED", { professionalId: accepted.professionalId, relationshipId: accepted.id });
    return this.status(orgId, lawyerId);
  }

  /** Desfedera: revoga o VÍNCULO desta org. NUNCA apaga a identidade global (RN-PN-3). */
  static defederate(orgId: string, lawyerId: string, actorId: string | null = null): any {
    const lawyer = lawyerRow(orgId, lawyerId);
    if (!lawyer) throw new Error("Advogado não encontrado.");
    const registration = String(lawyer.registration_number || "").trim();
    const prof = registration ? ProfessionalService.findByRegistration("OAB", registration) : null;
    if (prof) {
      const rel = ClinicProfessionalRelationshipService.getByProfessional(orgId, prof.id);
      if (rel && rel.status !== "revoked") {
        ClinicProfessionalRelationshipService.revoke(orgId, rel.id, actorId || undefined);
        logAuthEvent(orgId, actorId, lawyerId, "LEGAL_PROFESSIONAL_DEFEDERATED", { professionalId: prof.id, relationshipId: rel.id });
      }
    }
    return this.status(orgId, lawyerId);
  }
}

export default LegalProfessionalFederationService;
