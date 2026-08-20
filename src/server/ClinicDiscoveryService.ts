/**
 * ClinicDiscoveryService — ADR-180 F10.2: clínica DESCOBRÍVEL na rede/marketplace.
 *
 * O lado-clínica da descoberta cross-org: um opt-in de visibilidade (`network_discoverable`,
 * default OFF — RN-PN-9) + a projeção publicável do que a clínica PROCURA, derivada dos
 * `demand_gap` de pressão ALTA (F9.2). A projeção é o tier PÚBLICO (espelha o
 * SupplyNetworkService): business_name + cidade/estado + especialidades procuradas. NUNCA
 * carrega contagem crua de demanda, dado de paciente, receita nem o grafo de vínculos
 * (RN-PN-10). Isolado por org (convenção nº 1). Determinístico.
 */
import db from "./db.js";
import { ProfessionalDemandService } from "./ProfessionalDemandService.js";

export interface ClinicDiscoverySettings {
  discoverable: boolean;
  businessName: string | null;
  city: string | null;
  state: string | null;
  lat: number | null;
  lng: number | null;
}

/** Projeção PÚBLICA da clínica na descoberta (só quando descobrível). Sem nada privado. */
export interface ClinicDiscoveryProfile {
  organizationId: string;
  businessName: string | null;
  city: string | null;
  state: string | null;
  soughtSpecialties: string[];   // nomes dos serviços com demanda ALTA — sem contagem
}

export class ClinicDiscoveryService {
  static settings(orgId: string): ClinicDiscoverySettings {
    const r = db.prepare(
      `SELECT network_discoverable AS disc, business_name, address_city, address_state, address_lat, address_lng
       FROM organization_settings WHERE organization_id = ?`
    ).get(orgId) as any;
    return {
      discoverable: !!(r && r.disc),
      businessName: r?.business_name ?? null,
      city: r?.address_city ?? null, state: r?.address_state ?? null,
      lat: r?.address_lat ?? null, lng: r?.address_lng ?? null,
    };
  }

  /** Liga/desliga a visibilidade da clínica na descoberta (RN-PN-9). Só UPDATE (a linha existe). */
  static setDiscoverable(orgId: string, discoverable: boolean): ClinicDiscoverySettings {
    db.prepare(`UPDATE organization_settings SET network_discoverable = ? WHERE organization_id = ?`).run(discoverable ? 1 : 0, orgId);
    return this.settings(orgId);
  }

  /**
   * Especialidades PROCURADAS pela clínica — os nomes dos serviços com `demand_gap` de
   * pressão ALTA (F9.2). Sem contagem, sem paciente (RN-PN-10). Vazio quando não há gap.
   */
  static soughtSpecialties(orgId: string): string[] {
    const d = ProfessionalDemandService.demand(orgId);
    const names = d.byService.filter((s) => s.pressure === "high" && s.serviceName).map((s) => s.serviceName as string);
    return [...new Set(names)];
  }

  /**
   * Projeção PÚBLICA da clínica pra descoberta — só quando descobrível (RN-PN-9). null se
   * a clínica não optou. Carrega SÓ o tier público (identidade + região + procura); nunca
   * o privado (RN-PN-10).
   */
  static publicProfile(orgId: string): ClinicDiscoveryProfile | null {
    const s = this.settings(orgId);
    if (!s.discoverable) return null;
    return {
      organizationId: orgId,
      businessName: s.businessName, city: s.city, state: s.state,
      soughtSpecialties: this.soughtSpecialties(orgId),
    };
  }
}

export default ClinicDiscoveryService;
