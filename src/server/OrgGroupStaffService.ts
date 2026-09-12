import db from "./db.js";
import { OrgGroupService } from "./OrgGroupService.js";
import { PermissionService } from "./PermissionService.js";
import { bumpSecurityVersion } from "./middleware/auth.js";

/**
 * OrgGroupStaffService — ADR-199 (extensão): equipe do grupo e REMANEJAMENTO de
 * gerente entre lojas. Cada loja é uma ORG (1 CNPJ = 1 tenant); um gerente é um
 * usuário de UMA loja. "Transferir" = MOVER o mesmo usuário (mesmo login/identidade)
 * da org de origem para a org destino, ambas membros do MESMO grupo do dono.
 *
 * Guardrails (RN-GRP):
 *  - Só o DONO do grupo (identidade que possui o grupo) opera — validado aqui E na rota.
 *  - Nunca move o próprio dono (linha ligada à identidade dona) — RN-GRP-01/06.
 *  - Origem e destino têm de ser membros do MESMO grupo (isolamento) — nunca move
 *    para fora do grupo.
 *  - Ao mover, reatribui o perfil RBAC equivalente da loja DESTINO (mesmo system_key)
 *    para o gerente manter o nível de acesso; e limpa o escopo de loja da origem.
 *  - Bump de `security_version` REVOGA a sessão antiga (o token velho claim a org
 *    de origem) — o gerente é forçado a relogar já na loja nova (SEC-F7).
 */

export interface GroupStaffMember {
  userId: string; name: string | null; email: string | null; role: string;
  roleProfileId: string | null; profileName: string | null;
}
export interface GroupStoreStaff {
  organizationId: string; businessName: string | null; users: GroupStaffMember[];
}

const ACTIVE = "(u.global_status IS NULL OR u.global_status NOT IN ('blocked','deleted'))";

export class OrgGroupStaffService {
  /** O grupo é do dono (identidade)? Fonte única do gate de propriedade. */
  private static ownsGroup(groupId: string, ownerIdentityId: string): boolean {
    const g = OrgGroupService.getGroup(groupId);
    return !!(g && ownerIdentityId && g.ownerIdentityId === ownerIdentityId);
  }

  private static memberOrgIds(groupId: string): string[] {
    return OrgGroupService.membersOf(groupId).map((m) => m.organizationId);
  }

  /**
   * Equipe por loja do grupo (o DONO da identidade é omitido — ele não é "gerente
   * transferível"). Só o dono do grupo enxerga. Sem grupo/propriedade → [].
   */
  static listStaff(groupId: string, ownerIdentityId: string): GroupStoreStaff[] {
    if (!this.ownsGroup(groupId, ownerIdentityId)) return [];
    const out: GroupStoreStaff[] = [];
    for (const orgId of this.memberOrgIds(groupId)) {
      const biz = (db.prepare("SELECT business_name FROM organization_settings WHERE organization_id = ?").get(orgId) as any)?.business_name ?? null;
      const rows = db.prepare(
        `SELECT u.id, u.name, u.email, u.role, u.role_profile_id, u.identity_id, rp.name AS profile_name
           FROM users u
           LEFT JOIN role_profiles rp ON rp.id = u.role_profile_id
          WHERE u.organization_id = ? AND ${ACTIVE}
          ORDER BY u.name ASC`
      ).all(orgId) as any[];
      const users = rows
        .filter((r) => r.identity_id !== ownerIdentityId) // omite o próprio dono
        .map((r) => ({ userId: r.id, name: r.name ?? null, email: r.email ?? null, role: r.role, roleProfileId: r.role_profile_id ?? null, profileName: r.profile_name ?? null }));
      out.push({ organizationId: orgId, businessName: biz, users });
    }
    return out;
  }

  /**
   * Move um gerente da sua loja atual para outra loja do MESMO grupo (mesmo login).
   * Retorna { ok } ou { ok:false, code } com o motivo (a rota traduz p/ HTTP).
   */
  static transferUser(input: {
    groupId: string; ownerIdentityId: string; userId: string; toOrgId: string; actorUserId?: string | null;
  }): { ok: boolean; code?: string; fromOrgId?: string } {
    const { groupId, ownerIdentityId, userId, toOrgId } = input;
    if (!this.ownsGroup(groupId, ownerIdentityId)) return { ok: false, code: "not_group_owner" };

    const user = db.prepare("SELECT id, organization_id, email, identity_id, role, role_profile_id FROM users WHERE id = ?").get(userId) as any;
    if (!user) return { ok: false, code: "user_not_found" };
    // Nunca move o próprio dono (RN-GRP-06).
    if (user.identity_id && user.identity_id === ownerIdentityId) return { ok: false, code: "cannot_move_owner" };

    const members = new Set(this.memberOrgIds(groupId));
    const fromOrgId = user.organization_id;
    if (!members.has(fromOrgId)) return { ok: false, code: "user_not_in_group" };   // origem fora do grupo
    if (!members.has(toOrgId)) return { ok: false, code: "target_not_in_group" };   // destino fora do grupo
    if (fromOrgId === toOrgId) return { ok: false, code: "same_org" };

    // Colisão: destino não pode já ter um usuário ATIVO com o mesmo e-mail
    // (UNIQUE(organization_id, email) — mover cairia em constraint).
    if (user.email) {
      const clash = db.prepare(
        `SELECT 1 FROM users u WHERE u.organization_id = ? AND u.email = ? AND u.id != ? AND ${ACTIVE}`
      ).get(toOrgId, user.email, userId);
      if (clash) return { ok: false, code: "email_exists_in_target" };
    }

    // Perfil equivalente na loja destino: mapeia pelo system_key do perfil atual
    // (ex.: 'gerente' → o perfil 'gerente' da loja destino). Sem perfil atual → null.
    let destProfileId: string | null = null;
    if (user.role_profile_id) {
      const srcKey = (db.prepare("SELECT system_key FROM role_profiles WHERE id = ?").get(user.role_profile_id) as any)?.system_key || null;
      if (srcKey) {
        PermissionService.seedSystemProfiles(toOrgId); // garante os templates na destino (idempotente)
        destProfileId = (db.prepare("SELECT id FROM role_profiles WHERE organization_id = ? AND system_key = ?").get(toOrgId, srcKey) as any)?.id || null;
      }
    }

    const tx = db.transaction(() => {
      db.prepare("UPDATE users SET organization_id = ?, role_profile_id = ? WHERE id = ?").run(toOrgId, destProfileId, userId);
      // Escopo de loja (ADR-173) é por-org: as linhas da origem não valem na destino.
      try { db.prepare("DELETE FROM user_stores WHERE user_id = ?").run(userId); } catch { /* tabela pode não existir em legado */ }
    });
    tx();

    // Revoga a sessão atual (token velho claim a org de origem) — força relogin na nova.
    bumpSecurityVersion(userId);
    return { ok: true, fromOrgId };
  }
}

export default OrgGroupStaffService;
