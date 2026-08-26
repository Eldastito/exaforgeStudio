import { LegalProfessionalFederationService } from "./LegalProfessionalFederationService.js";
import { ProfessionalScheduleConfigService, type OfferingInput, type WindowInput } from "./ProfessionalScheduleConfigService.js";

/**
 * Legal Professional Schedule (ADR-191 OAB-F2) — ofertas + janelas do advogado FEDERADO.
 *
 * COMPOSIÇÃO PURA sobre a ADR-180 (§184 — sem motor novo): o Advocacia só traduz
 * `lawyerId` (o `clinic_professional` da vertical) para o `relationshipId` do vínculo
 * federado (via OAB-F1) e DELEGA a configuração ao `ProfessionalScheduleConfigService`.
 *
 * As "ofertas" são serviços jurídicos do catálogo (`products_services type='service'`, o
 * MESMO gate da ADR-180 — não inventa serviço) que o advogado presta neste escritório;
 * as "janelas" são a disponibilidade semanal + buffer. Exige o advogado FEDERADO
 * (OAB-F1) — sem vínculo aceito não há o que configurar (RN-PN-8/2). Isolado por org.
 */

export class LegalProfessionalScheduleService {
  /** Resolve o vínculo federado do advogado. Exige federação ativa (OAB-F1). */
  private static requireRelationship(orgId: string, lawyerId: string): string {
    const st = LegalProfessionalFederationService.status(orgId, lawyerId);
    if (!st.federated || !st.relationshipId) {
      throw new Error("Advogado não federado — federe pela OAB antes de configurar a agenda.");
    }
    return st.relationshipId;
  }

  // ── Ofertas (serviços jurídicos prestados no vínculo) ──
  static listOfferings(orgId: string, lawyerId: string, opts?: { includeInactive?: boolean }) {
    return ProfessionalScheduleConfigService.listOfferings(orgId, this.requireRelationship(orgId, lawyerId), opts);
  }
  static setOffering(orgId: string, lawyerId: string, input: OfferingInput, actorId?: string) {
    return ProfessionalScheduleConfigService.setOffering(orgId, this.requireRelationship(orgId, lawyerId), input, actorId);
  }
  static removeOffering(orgId: string, lawyerId: string, offeringId: string, actorId?: string) {
    // valida que a oferta é do vínculo deste advogado (isolamento) antes de remover.
    this.requireRelationship(orgId, lawyerId);
    return ProfessionalScheduleConfigService.removeOffering(orgId, offeringId, actorId);
  }

  // ── Janelas (disponibilidade semanal + buffer) ──
  static listWindows(orgId: string, lawyerId: string) {
    return ProfessionalScheduleConfigService.listWindows(orgId, this.requireRelationship(orgId, lawyerId));
  }
  static setWindows(orgId: string, lawyerId: string, windows: WindowInput[], actorId?: string) {
    return ProfessionalScheduleConfigService.setWindows(orgId, this.requireRelationship(orgId, lawyerId), windows, actorId);
  }
}

export default LegalProfessionalScheduleService;
