/**
 * ClinicProfessionalRelationshipService — ADR-180 F1: bridge POR-ORG do vínculo
 * clínica↔profissional (Agenda Federada).
 *
 * Espelha organization_contextualization (bridge por-org sobre a camada global) e
 * retail_seller_store_assignments (vínculo separado da identidade). A identidade
 * GLOBAL vive em ProfessionalService; AQUI vive só a RELAÇÃO: status do convite,
 * permissões (quais serviços a clínica pode agendar), comissão.
 *
 * Guardrails: isolamento multi-tenant (RN-PN-2 — orgId 1º arg, toda query filtra
 * organization_id; uma clínica só vê a relação dela); revogar NÃO apaga a identidade
 * global (RN-PN-3); UNIQUE(org, professional) → 1 relação viva por par (convite
 * idempotente); nunca inventa (permissões default vazias). O ciclo é
 * convite(pending) → aceite(accepted) → revogação(revoked).
 */
import { randomUUID } from "crypto";
import db from "./db.js";
import { logAuthEvent } from "./auditLog.js";
import { ProfessionalService, ProfessionalIdentityInput, Professional } from "./ProfessionalService.js";

export type CommissionBeneficiary = "professional" | "clinic";
export interface RelationshipPermissions {
  services?: string[];            // ids de serviços que a clínica pode agendar
  commissionPercent?: number | null;
  commissionBeneficiary?: CommissionBeneficiary;   // F8.2 — de quem é o %
  taxWithholdingPercent?: number | null;           // F8.2 — imposto retido na fonte
  travelBufferMin?: number | null;                 // F5.2 — deslocamento cross-clínica (null = off)
}

export interface ClinicProfessionalRelationship {
  id: string;
  organizationId: string;
  professionalId: string;
  status: string;                 // pending | accepted | revoked
  permissions: { services: string[] };
  commissionPercent: number | null;
  commissionBeneficiary: CommissionBeneficiary;    // F8.2 — 'professional' (default) | 'clinic'
  taxWithholdingPercent: number | null;            // F8.2 — null = sem retenção configurada
  travelBufferMin: number | null;                  // F5.2 — null = deslocamento desligado
  notes: string | null;
  invitedAt: string | null;
  respondedAt: string | null;
  revokedAt: string | null;
  professional: Professional | null;   // identidade global (read-only)
}

const STATUSES = new Set(["pending", "accepted", "revoked"]);

/** Normaliza um percentual opcional (0..100) ou null; lança se fora da faixa. */
function normPct(v: number | null | undefined): number | null {
  if (v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 100) throw new Error("percent_out_of_range");
  return n;
}
function normBeneficiary(v: CommissionBeneficiary | undefined): CommissionBeneficiary | undefined {
  if (v == null) return undefined;
  if (v !== "professional" && v !== "clinic") throw new Error("beneficiary_invalid");
  return v;
}
/** Buffer de deslocamento (min): null = desligado; senão inteiro ≥ 0. */
function normBufferMin(v: number | null | undefined): number | null {
  if (v == null) return null;
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n < 0 || n > 1440) throw new Error("travel_buffer_invalid");
  return n;
}

function parsePerms(json?: string | null): { services: string[] } {
  try { const v = JSON.parse(json || "{}"); const s = Array.isArray(v?.services) ? v.services.map(String) : []; return { services: s }; }
  catch { return { services: [] }; }
}

export class ClinicProfessionalRelationshipService {
  private static map(r: any): ClinicProfessionalRelationship {
    return {
      id: r.id, organizationId: r.organization_id, professionalId: r.professional_id,
      status: r.status, permissions: parsePerms(r.permissions_json),
      commissionPercent: r.commission_percent ?? null,
      commissionBeneficiary: r.commission_beneficiary === "clinic" ? "clinic" : "professional",
      taxWithholdingPercent: r.tax_withholding_percent ?? null,
      travelBufferMin: r.travel_buffer_min ?? null,
      notes: r.notes ?? null,
      invitedAt: r.invited_at ?? null, respondedAt: r.responded_at ?? null, revokedAt: r.revoked_at ?? null,
      professional: ProfessionalService.getById(r.professional_id),
    };
  }

  /** Relação por id, isolada por org. null se não for da org (RN-PN-2). */
  static get(orgId: string, relId: string): ClinicProfessionalRelationship | null {
    const r = db.prepare(
      `SELECT * FROM clinic_professional_relationships WHERE organization_id = ? AND id = ?`
    ).get(orgId, String(relId || "")) as any;
    return r ? ClinicProfessionalRelationshipService.map(r) : null;
  }

  /** Relação da org com um profissional (a chave natural do bridge). */
  static getByProfessional(orgId: string, professionalId: string): ClinicProfessionalRelationship | null {
    const r = db.prepare(
      `SELECT * FROM clinic_professional_relationships WHERE organization_id = ? AND professional_id = ?`
    ).get(orgId, String(professionalId || "")) as any;
    return r ? ClinicProfessionalRelationshipService.map(r) : null;
  }

  /** Relações da org (opcional filtro por status). Só as DESTA org (RN-PN-2). */
  static list(orgId: string, opts?: { status?: string }): ClinicProfessionalRelationship[] {
    let sql = `SELECT * FROM clinic_professional_relationships WHERE organization_id = ?`;
    const args: any[] = [orgId];
    if (opts?.status && STATUSES.has(opts.status)) { sql += ` AND status = ?`; args.push(opts.status); }
    sql += ` ORDER BY invited_at DESC`;
    const rows = db.prepare(sql).all(...args) as any[];
    return rows.map(ClinicProfessionalRelationshipService.map);
  }

  /**
   * Convida um profissional para a clínica. Aceita um `professionalId` existente OU
   * dados de identidade (`identity`) — nesse caso cria/reusa a identidade GLOBAL
   * (idempotente, ProfessionalService.upsertIdentity). Idempotente por
   * UNIQUE(org, professional): se já houver relação, devolve a existente (reativa se
   * estava revoked → pending). Nasce `pending` (RN-PN-5: convite ≠ vínculo ativo).
   */
  static invite(
    orgId: string,
    input: { professionalId?: string; identity?: ProfessionalIdentityInput; permissions?: RelationshipPermissions; notes?: string | null },
    actorId?: string,
  ): ClinicProfessionalRelationship {
    let professionalId = String(input.professionalId || "").trim();
    if (!professionalId) {
      if (!input.identity) throw new Error("professional_id_or_identity_required");
      professionalId = ProfessionalService.upsertIdentity(input.identity, orgId, actorId).id;
    } else if (!ProfessionalService.getById(professionalId)) {
      throw new Error("professional_not_found");
    }

    const existing = ClinicProfessionalRelationshipService.getByProfessional(orgId, professionalId);
    if (existing) {
      // Reativa um vínculo revogado como novo convite; caso contrário devolve como está.
      if (existing.status === "revoked") {
        db.prepare(
          `UPDATE clinic_professional_relationships SET status = 'pending', invited_by = ?, invited_at = CURRENT_TIMESTAMP, responded_at = NULL, revoked_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
        ).run(actorId || null, existing.id);
        try { logAuthEvent(orgId, actorId || "system", existing.id, "CLINIC_PROFESSIONAL_REINVITE", { professionalId }); } catch { /* noop */ }
        return ClinicProfessionalRelationshipService.get(orgId, existing.id)!;
      }
      return existing;
    }

    const id = randomUUID();
    const perms = JSON.stringify({ services: Array.isArray(input.permissions?.services) ? input.permissions!.services!.map(String) : [] });
    const commission = normPct(input.permissions?.commissionPercent);
    const beneficiary = normBeneficiary(input.permissions?.commissionBeneficiary) || "professional";
    const tax = normPct(input.permissions?.taxWithholdingPercent);
    db.prepare(`
      INSERT INTO clinic_professional_relationships (id, organization_id, professional_id, status, permissions_json, commission_percent, commission_beneficiary, tax_withholding_percent, notes, invited_by)
      VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)
    `).run(id, orgId, professionalId, perms, commission, beneficiary, tax, input.notes ?? null, actorId || null);
    try { logAuthEvent(orgId, actorId || "system", id, "CLINIC_PROFESSIONAL_INVITE", { professionalId }); } catch { /* noop */ }
    return ClinicProfessionalRelationshipService.get(orgId, id)!;
  }

  /** Aceita o vínculo (pending → accepted). No-op se já accepted. Só da org. */
  static accept(orgId: string, relId: string, actorId?: string): ClinicProfessionalRelationship {
    const rel = ClinicProfessionalRelationshipService.get(orgId, relId);
    if (!rel) throw new Error("relationship_not_found");
    if (rel.status === "revoked") throw new Error("relationship_revoked");
    if (rel.status !== "accepted") {
      db.prepare(
        `UPDATE clinic_professional_relationships SET status = 'accepted', responded_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE organization_id = ? AND id = ?`
      ).run(orgId, relId);
      try { logAuthEvent(orgId, actorId || "system", relId, "CLINIC_PROFESSIONAL_ACCEPT", {}); } catch { /* noop */ }
    }
    return ClinicProfessionalRelationshipService.get(orgId, relId)!;
  }

  /** Revoga o vínculo (→ revoked). NÃO apaga a identidade global (RN-PN-3). */
  static revoke(orgId: string, relId: string, actorId?: string): ClinicProfessionalRelationship {
    const rel = ClinicProfessionalRelationshipService.get(orgId, relId);
    if (!rel) throw new Error("relationship_not_found");
    if (rel.status !== "revoked") {
      db.prepare(
        `UPDATE clinic_professional_relationships SET status = 'revoked', revoked_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE organization_id = ? AND id = ?`
      ).run(orgId, relId);
      try { logAuthEvent(orgId, actorId || "system", relId, "CLINIC_PROFESSIONAL_REVOKE", {}); } catch { /* noop */ }
    }
    return ClinicProfessionalRelationshipService.get(orgId, relId)!;
  }

  /** Atualiza permissões/comissão do vínculo (só da org). */
  static setPermissions(orgId: string, relId: string, perms: RelationshipPermissions, actorId?: string): ClinicProfessionalRelationship {
    const rel = ClinicProfessionalRelationshipService.get(orgId, relId);
    if (!rel) throw new Error("relationship_not_found");
    const services = Array.isArray(perms.services) ? perms.services.map(String) : rel.permissions.services;
    const commission = perms.commissionPercent === undefined ? rel.commissionPercent : normPct(perms.commissionPercent);
    const beneficiary = perms.commissionBeneficiary === undefined ? rel.commissionBeneficiary : (normBeneficiary(perms.commissionBeneficiary) || "professional");
    const tax = perms.taxWithholdingPercent === undefined ? rel.taxWithholdingPercent : normPct(perms.taxWithholdingPercent);
    const travel = perms.travelBufferMin === undefined ? rel.travelBufferMin : normBufferMin(perms.travelBufferMin);
    db.prepare(
      `UPDATE clinic_professional_relationships SET permissions_json = ?, commission_percent = ?, commission_beneficiary = ?, tax_withholding_percent = ?, travel_buffer_min = ?, updated_at = CURRENT_TIMESTAMP WHERE organization_id = ? AND id = ?`
    ).run(JSON.stringify({ services }), commission, beneficiary, tax, travel, orgId, relId);
    try { logAuthEvent(orgId, actorId || "system", relId, "CLINIC_PROFESSIONAL_SET_PERMISSIONS", { services: services.length }); } catch { /* noop */ }
    return ClinicProfessionalRelationshipService.get(orgId, relId)!;
  }
}

export default ClinicProfessionalRelationshipService;
