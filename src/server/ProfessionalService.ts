/**
 * ProfessionalService — ADR-180 F1: identidade GLOBAL do profissional (Agenda Federada).
 *
 * Decisão de fronteira (§90 / RN-PN-1): o profissional pertence ao ECOSSISTEMA
 * ZapFlow, não a uma clínica. Por isso a tabela `professionals` é GLOBAL — SEM
 * `organization_id` — chaveada por conselho + registro (ex. CRMV-SP 12345). Este é
 * o precedente já validado no repo (vertical_intelligence é global; retail_sellers
 * separa identidade de vínculo). Toda a RELAÇÃO clínica↔profissional (permissões,
 * comissão, status do convite) vive no bridge por-org
 * (ClinicProfessionalRelationshipService), NUNCA aqui.
 *
 * Guardrails: identidade é do ecossistema (RN-PN-1 — zero dado por-org aqui);
 * `upsertIdentity` é IDEMPOTENTE pela chave do conselho e NUNCA sobrescreve dado
 * existente com vazio (não apaga o que já foi cadastrado por outra clínica —
 * RN-PN-3); nunca inventa (campos ausentes ficam null). O 1º arg `createdByOrg` é só
 * AUDITORIA (quem cadastrou) — não confere propriedade.
 */
import { randomUUID } from "crypto";
import db from "./db.js";
import { logAuthEvent } from "./auditLog.js";

export interface ProfessionalIdentityInput {
  council?: string;               // CRMV, CRM, CRO, CREFITO, ...
  registrationNumber?: string;    // nº no conselho
  name?: string;
  specialties?: string[] | null;
  phone?: string | null;
  email?: string | null;
}

export interface Professional {
  id: string;
  council: string;
  registrationNumber: string;
  name: string;
  specialties: string[];
  phone: string | null;
  email: string | null;
  status: string;
  createdAt: string;
  // F10.1 — descoberta (rede/marketplace). Opt-in; default off.
  discoverable: boolean;
  baseCity: string | null;
  baseState: string | null;
  baseLat: number | null;
  baseLng: number | null;
}

export interface DiscoverabilityInput {
  discoverable?: boolean;
  baseCity?: string | null;
  baseState?: string | null;
  baseLat?: number | null;
  baseLng?: number | null;
}

function norm(s?: string | null): string {
  return String(s ?? "").trim();
}

export class ProfessionalService {
  private static map(r: any): Professional {
    let specialties: string[] = [];
    try { const v = JSON.parse(r.specialties_json || "[]"); if (Array.isArray(v)) specialties = v.map(String); } catch { /* noop */ }
    return {
      id: r.id, council: r.council, registrationNumber: r.registration_number,
      name: r.name, specialties, phone: r.phone ?? null, email: r.email ?? null,
      status: r.status || "active", createdAt: r.created_at,
      discoverable: !!r.discoverable,
      baseCity: r.base_city ?? null, baseState: r.base_state ?? null,
      baseLat: r.base_lat ?? null, baseLng: r.base_lng ?? null,
    };
  }

  /**
   * F10.1 — o profissional liga/desliga a própria DESCOBERTA e define a região base.
   * Opt-in (RN-PN-9 — default off; desligar tira do diretório na hora, não apaga
   * identidade/vínculos). Só grava o que foi passado (undefined = mantém); string vazia
   * limpa. Nunca inventa: sem existir, lança. Determinístico (sem geocode/rede aqui — a
   * F10.3 preenche lat/lng no matching, reusando o geocode_cache do SupplyNetworkService).
   */
  static setDiscoverability(professionalId: string, input: DiscoverabilityInput, actorId?: string): Professional {
    const p = ProfessionalService.getById(String(professionalId || ""));
    if (!p) throw new Error("professional_not_found");
    const patch: Record<string, any> = {};
    if (input.discoverable !== undefined) patch.discoverable = input.discoverable ? 1 : 0;
    if (input.baseCity !== undefined) patch.base_city = input.baseCity == null ? null : (norm(input.baseCity) || null);
    if (input.baseState !== undefined) patch.base_state = input.baseState == null ? null : (norm(input.baseState).toUpperCase().slice(0, 2) || null);
    if (input.baseLat !== undefined) patch.base_lat = input.baseLat == null ? null : Number(input.baseLat);
    if (input.baseLng !== undefined) patch.base_lng = input.baseLng == null ? null : Number(input.baseLng);
    if (Object.keys(patch).length) {
      const sets = Object.keys(patch).map((k) => `${k} = ?`).join(", ");
      db.prepare(`UPDATE professionals SET ${sets}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...Object.values(patch), p.id);
      try { logAuthEvent("system", actorId || "system", p.id, "PROFESSIONAL_DISCOVERABILITY_SET", { discoverable: patch.discoverable }); } catch { /* noop */ }
    }
    return ProfessionalService.getById(p.id)!;
  }

  /** Identidade por id (global). null se não existir. */
  static getById(id: string): Professional | null {
    const r = db.prepare(`SELECT * FROM professionals WHERE id = ?`).get(String(id || "")) as any;
    return r ? ProfessionalService.map(r) : null;
  }

  /** Identidade por conselho + registro (a chave natural). Case/space-insensível. */
  static findByRegistration(council?: string | null, registrationNumber?: string | null): Professional | null {
    const c = norm(council), n = norm(registrationNumber);
    if (!c || !n) return null;
    const r = db.prepare(
      `SELECT * FROM professionals WHERE UPPER(council) = UPPER(?) AND registration_number = ?`
    ).get(c, n) as any;
    return r ? ProfessionalService.map(r) : null;
  }

  /** Busca por nome/registro (para o fluxo de convite). Limite 1..50 (default 20). */
  static search(query?: string, limit = 20): Professional[] {
    const q = norm(query);
    const lim = Math.min(Math.max(Number(limit) || 20, 1), 50);
    if (!q) {
      const rows = db.prepare(`SELECT * FROM professionals WHERE status = 'active' ORDER BY name LIMIT ?`).all(lim) as any[];
      return rows.map(ProfessionalService.map);
    }
    const like = `%${q}%`;
    const rows = db.prepare(
      `SELECT * FROM professionals WHERE status = 'active' AND (name LIKE ? OR registration_number LIKE ?) ORDER BY name LIMIT ?`
    ).all(like, like, lim) as any[];
    return rows.map(ProfessionalService.map);
  }

  /**
   * Cria (ou devolve) a identidade global, IDEMPOTENTE por (council, registration).
   * Se já existe: NÃO sobrescreve com vazio (RN-PN-3) — só completa campos que
   * estavam faltando. Exige council + registrationNumber + name (não inventa).
   * `createdByOrg`/`actorId` são só auditoria.
   */
  static upsertIdentity(input: ProfessionalIdentityInput, createdByOrg?: string, actorId?: string): Professional {
    const council = norm(input.council), registration = norm(input.registrationNumber), name = norm(input.name);
    if (!council) throw new Error("professional_council_required");
    if (!registration) throw new Error("professional_registration_required");
    if (!name) throw new Error("professional_name_required");

    const existing = ProfessionalService.findByRegistration(council, registration);
    if (existing) {
      // Completa só o que falta; nunca apaga (RN-PN-3).
      const patch: Record<string, any> = {};
      if (!existing.name && name) patch.name = name;
      if ((existing.phone == null || existing.phone === "") && input.phone != null && norm(input.phone)) patch.phone = norm(input.phone);
      if ((existing.email == null || existing.email === "") && input.email != null && norm(input.email)) patch.email = norm(input.email);
      if ((!existing.specialties || existing.specialties.length === 0) && Array.isArray(input.specialties) && input.specialties.length) {
        patch.specialties_json = JSON.stringify(input.specialties.map(String));
      }
      if (Object.keys(patch).length) {
        const sets = Object.keys(patch).map((k) => `${k} = ?`).join(", ");
        db.prepare(`UPDATE professionals SET ${sets}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...Object.values(patch), existing.id);
      }
      return ProfessionalService.getById(existing.id)!;
    }

    const id = randomUUID();
    db.prepare(`
      INSERT INTO professionals (id, council, registration_number, name, specialties_json, phone, email, status, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)
    `).run(
      id, council, registration, name,
      Array.isArray(input.specialties) && input.specialties.length ? JSON.stringify(input.specialties.map(String)) : null,
      input.phone != null && norm(input.phone) ? norm(input.phone) : null,
      input.email != null && norm(input.email) ? norm(input.email) : null,
      createdByOrg || null,
    );
    try { logAuthEvent(createdByOrg || "system", actorId || "system", id, "PROFESSIONAL_IDENTITY_CREATE", { council, registration }); } catch { /* noop */ }
    return ProfessionalService.getById(id)!;
  }
}

export default ProfessionalService;
