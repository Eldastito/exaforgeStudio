/**
 * OrgGroupService — ADR-199 F0a: a HOLDING (grupo) e suas operações-membro.
 *
 * D2/§4.2: o grupo é apenas METADADO de agregação/UI — quais orgs (marcas/operações)
 * compõem o grupo de um dono (identidade). NÃO é tenant, NÃO carrega dado de negócio, e
 * NENHUM service org-scoped o conhece (RN-GRP-01/RN-GRP-05: o conceito de grupo só vive
 * aqui e, na F2, no GroupConsolidationService). Este service NÃO lê dado de negócio de
 * org nenhuma — só gerencia a lista de membros. A consolidação real (fan-out) é F2.
 *
 * Membership de ACESSO (quais orgs a identidade pode abrir/alternar) NÃO é este grupo —
 * é ter linha de `users` ligada por identity_id (AccountIdentityService.orgsForIdentity).
 * O grupo é o agrupamento de marcas do dono pra visão consolidada; um dono pode até ter
 * orgs fora de um grupo. Mantê-los separados evita confundir "vejo o consolidado" com
 * "tenho login naquela org".
 *
 * GLOBAL (sem organization_id no service): opera sobre org_groups / org_group_members.
 */
import { randomUUID } from "crypto";
import db from "./db.js";

export interface OrgGroup {
  id: string;
  name: string;
  ownerIdentityId: string;
  createdAt: string;
}

export interface OrgGroupMember {
  id: string;
  groupId: string;
  organizationId: string;
  addedBy: string | null;
  addedAt: string;
}

function norm(s?: string | null): string {
  return String(s ?? "").trim();
}

export class OrgGroupService {
  private static mapGroup(r: any): OrgGroup {
    return { id: r.id, name: r.name, ownerIdentityId: r.owner_identity_id, createdAt: r.created_at };
  }
  private static mapMember(r: any): OrgGroupMember {
    return { id: r.id, groupId: r.group_id, organizationId: r.organization_id, addedBy: r.added_by ?? null, addedAt: r.added_at };
  }

  /** Cria um grupo. Exige nome e a identidade dona (não inventa — RN-GRP). */
  static createGroup(input: { name: string; ownerIdentityId: string }): OrgGroup {
    const name = norm(input?.name);
    const owner = norm(input?.ownerIdentityId);
    if (!name) throw new Error("group_name_required");
    if (!owner) throw new Error("owner_identity_required");
    const exists = db.prepare("SELECT 1 FROM account_identities WHERE id = ?").get(owner);
    if (!exists) throw new Error("owner_identity_not_found");
    const id = randomUUID();
    db.prepare("INSERT INTO org_groups (id, name, owner_identity_id) VALUES (?, ?, ?)").run(id, name, owner);
    return OrgGroupService.getGroup(id)!;
  }

  static getGroup(groupId: string): OrgGroup | null {
    const r = db.prepare("SELECT * FROM org_groups WHERE id = ?").get(norm(groupId)) as any;
    return r ? OrgGroupService.mapGroup(r) : null;
  }

  /** Grupos de um dono (identidade). */
  static groupsForOwner(ownerIdentityId: string): OrgGroup[] {
    const rows = db.prepare("SELECT * FROM org_groups WHERE owner_identity_id = ? ORDER BY created_at ASC").all(norm(ownerIdentityId)) as any[];
    return rows.map(OrgGroupService.mapGroup);
  }

  /**
   * Adiciona uma org ao grupo. Idempotente por UNIQUE(group_id, organization_id):
   * reexecutar devolve o mesmo membro (não duplica — critério de aceite da F1/§6).
   */
  static addMember(groupId: string, organizationId: string, addedBy?: string): OrgGroupMember {
    const gid = norm(groupId), org = norm(organizationId);
    if (!gid || !org) throw new Error("group_and_org_required");
    if (!OrgGroupService.getGroup(gid)) throw new Error("group_not_found");
    const existing = db.prepare("SELECT * FROM org_group_members WHERE group_id = ? AND organization_id = ?").get(gid, org) as any;
    if (existing) return OrgGroupService.mapMember(existing);
    const id = randomUUID();
    db.prepare("INSERT INTO org_group_members (id, group_id, organization_id, added_by) VALUES (?, ?, ?, ?) ON CONFLICT(group_id, organization_id) DO NOTHING")
      .run(id, gid, org, addedBy ? norm(addedBy) : null);
    const row = db.prepare("SELECT * FROM org_group_members WHERE group_id = ? AND organization_id = ?").get(gid, org) as any;
    return OrgGroupService.mapMember(row);
  }

  /** Remove uma org do grupo (não apaga a org nem seus dados — só o vínculo de holding). */
  static removeMember(groupId: string, organizationId: string): boolean {
    const changes = db.prepare("DELETE FROM org_group_members WHERE group_id = ? AND organization_id = ?").run(norm(groupId), norm(organizationId)).changes as number;
    return changes > 0;
  }

  /** Orgs que compõem o grupo (a lista que a F2 vai iterar por fan-out). */
  static membersOf(groupId: string): OrgGroupMember[] {
    const rows = db.prepare("SELECT * FROM org_group_members WHERE group_id = ? ORDER BY added_at ASC").all(norm(groupId)) as any[];
    return rows.map(OrgGroupService.mapMember);
  }

  /** Grupos que contêm uma org (uma org, em teoria, só pertence a um grupo por dono). */
  static groupsForOrg(organizationId: string): OrgGroup[] {
    const rows = db.prepare(
      `SELECT g.* FROM org_groups g JOIN org_group_members m ON m.group_id = g.id WHERE m.organization_id = ? ORDER BY g.created_at ASC`
    ).all(norm(organizationId)) as any[];
    return rows.map(OrgGroupService.mapGroup);
  }
}
