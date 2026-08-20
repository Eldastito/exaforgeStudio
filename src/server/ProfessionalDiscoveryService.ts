/**
 * ProfessionalDiscoveryService — ADR-180 F10.3: descoberta BIDIRECIONAL (rede/marketplace).
 *
 * O coração do marketplace, no molde `SupplyNetworkService.listSuppliers`: cruza os dois
 * lados que optaram por aparecer (profissional descobrível F10.1 × clínica descobrível F10.2)
 * por ESPECIALIDADE + REGIÃO grossa, excluindo quem já tem vínculo. Só surface — a conexão
 * segue pelo `invite→accept` (RN-PN-11, feito na F10.4). A projeção carrega SÓ o tier público
 * (identidade + região + match); nunca o privado (RN-PN-10 — paciente/financeiro/grafo).
 *
 * Determinístico: o match usa as coords que já existem (+ estado como fallback); geocoding
 * (Nominatim, async) NÃO entra no caminho do match — fica pra um preenchimento best-effort à
 * parte, reusando `SupplyNetworkService.geocodeCity`+`geocode_cache`. Isolamento por org.
 */
import db from "./db.js";
import { SupplyNetworkService } from "./SupplyNetworkService.js";
import { ProfessionalService } from "./ProfessionalService.js";
import { ClinicDiscoveryService } from "./ClinicDiscoveryService.js";

/** Normaliza texto pra match: minúsculo, sem acento, colapsa espaço. */
function norm(s: string): string {
  return String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim();
}
/** Especialidades que casam entre a lista do profissional e a procurada (substring nos dois sentidos). */
function specialtyMatch(profSpecialties: string[], sought: string[]): string[] {
  const P = profSpecialties.map(norm).filter(Boolean);
  const out: string[] = [];
  for (const raw of sought) {
    const s = norm(raw);
    if (!s) continue;
    if (P.some((p) => p === s || p.includes(s) || s.includes(p))) out.push(raw);
  }
  return [...new Set(out)];
}
/** Região grossa: raio se ambos têm coords; senão mesmo estado; senão desconhecida (não filtra). */
function regionMatch(aLat: number | null, aLng: number | null, bLat: number | null, bLng: number | null, aState: string | null, bState: string | null, maxKm: number): { ok: boolean; distanceKm: number | null } {
  if (aLat != null && aLng != null && bLat != null && bLng != null) {
    const d = SupplyNetworkService.distanceKm(aLat, aLng, bLat, bLng);
    return { ok: d <= maxKm, distanceKm: d };
  }
  if (aState && bState) return { ok: norm(aState) === norm(bState), distanceKm: null };
  return { ok: true, distanceKm: null }; // sem região nos dois → não sobre-filtra (honesto)
}

export interface SpecialistMatch { professionalId: string; name: string; council: string; registrationNumber: string; matchedSpecialties: string[]; baseCity: string | null; baseState: string | null; distanceKm: number | null; }
export interface ClinicMatch { organizationId: string; businessName: string | null; city: string | null; state: string | null; matchedSpecialties: string[]; distanceKm: number | null; }

export class ProfessionalDiscoveryService {
  private static DEFAULT_RADIUS = 150;

  /** Vínculo VIVO (pending/accepted) entre a org e o profissional? (exclui da descoberta). */
  private static alreadyLinked(orgId: string, professionalId: string): boolean {
    const r = db.prepare(`SELECT 1 FROM clinic_professional_relationships WHERE organization_id = ? AND professional_id = ? AND status IN ('pending','accepted')`).get(orgId, professionalId);
    return !!r;
  }

  /**
   * Especialistas descobríveis pra uma clínica: match das especialidades PROCURADAS
   * (`ClinicDiscoveryService.soughtSpecialties`, ou `opts.specialty`) × os profissionais
   * que optaram por aparecer, por região; exclui quem já tem vínculo com a org.
   */
  static specialistsFor(orgId: string, opts?: { maxDistanceKm?: number; specialty?: string; limit?: number }): SpecialistMatch[] {
    const clinic = ClinicDiscoveryService.settings(orgId);
    const sought = opts?.specialty ? [opts.specialty] : ClinicDiscoveryService.soughtSpecialties(orgId);
    if (!sought.length) return [];
    const maxKm = Math.max(1, Number(opts?.maxDistanceKm) || this.DEFAULT_RADIUS);
    const limit = Math.min(Math.max(Number(opts?.limit) || 50, 1), 100);

    const rows = db.prepare(`SELECT * FROM professionals WHERE discoverable = 1 AND status = 'active'`).all() as any[];
    const out: SpecialistMatch[] = [];
    for (const r of rows) {
      const p = ProfessionalService.getById(r.id)!;
      const matched = specialtyMatch(p.specialties, sought);
      if (!matched.length) continue;
      if (this.alreadyLinked(orgId, p.id)) continue;
      const reg = regionMatch(clinic.lat, clinic.lng, p.baseLat, p.baseLng, clinic.state, p.baseState, maxKm);
      if (!reg.ok) continue;
      out.push({ professionalId: p.id, name: p.name, council: p.council, registrationNumber: p.registrationNumber, matchedSpecialties: matched, baseCity: p.baseCity, baseState: p.baseState, distanceKm: reg.distanceKm });
    }
    out.sort((a, b) => (a.distanceKm ?? 1e9) - (b.distanceKm ?? 1e9));
    return out.slice(0, limit);
  }

  /**
   * Clínicas que procuram a especialidade do profissional: match das especialidades DELE ×
   * as clínicas que optaram por aparecer (descobríveis) e cuja procura casa, por região;
   * exclui as que já têm vínculo com ele. Browsing é passivo — não exige o profissional ser
   * descobrível (só existir).
   */
  static clinicsSeeking(professionalId: string, opts?: { maxDistanceKm?: number; limit?: number }): ClinicMatch[] {
    const p = ProfessionalService.getById(String(professionalId || ""));
    if (!p) throw new Error("professional_not_found");
    if (!p.specialties.length) return [];
    const maxKm = Math.max(1, Number(opts?.maxDistanceKm) || this.DEFAULT_RADIUS);
    const limit = Math.min(Math.max(Number(opts?.limit) || 50, 1), 100);

    const orgs = db.prepare(`SELECT organization_id FROM organization_settings WHERE network_discoverable = 1`).all() as any[];
    const out: ClinicMatch[] = [];
    for (const o of orgs) {
      const orgId = o.organization_id;
      const sought = ClinicDiscoveryService.soughtSpecialties(orgId);
      const matched = specialtyMatch(p.specialties, sought);
      if (!matched.length) continue;
      if (this.alreadyLinked(orgId, p.id)) continue;
      const s = ClinicDiscoveryService.settings(orgId);
      const reg = regionMatch(p.baseLat, p.baseLng, s.lat, s.lng, p.baseState, s.state, maxKm);
      if (!reg.ok) continue;
      out.push({ organizationId: orgId, businessName: s.businessName, city: s.city, state: s.state, matchedSpecialties: matched, distanceKm: reg.distanceKm });
    }
    out.sort((a, b) => (a.distanceKm ?? 1e9) - (b.distanceKm ?? 1e9));
    return out.slice(0, limit);
  }
}

export default ProfessionalDiscoveryService;
