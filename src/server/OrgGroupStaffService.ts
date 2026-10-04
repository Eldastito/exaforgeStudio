import db from "./db.js";
import { OrgGroupService } from "./OrgGroupService.js";
import { UserOrgMoveService } from "./UserOrgMoveService.js";

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
 *  - ESCOPO DE LOJA OBRIGATÓRIO: se a org destino tem lojas de varejo, a transferência EXIGE
 *    ≥1 loja dela (`storeIds`) e grava o vínculo na MESMA transação. Sem isso o gerente cairia
 *    "sem atribuição" = irrestrito (RetailStoreScopeService.allowed) e veria a rede inteira.
 *  - Bump de `security_version` REVOGA a sessão antiga (o token velho claim a org
 *    de origem) — o gerente é forçado a relogar já na loja nova (SEC-F7).
 */

export interface GroupStaffMember {
  userId: string; name: string | null; email: string | null; role: string;
  roleProfileId: string | null; profileName: string | null;
}
export interface GroupStoreStaff {
  organizationId: string; businessName: string | null; users: GroupStaffMember[];
  /** Lojas de varejo ativas desta org — o destino precisa delas pra exigir o vínculo na transferência. */
  retailStores: { id: string; name: string }[];
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
      const retailStores = (db.prepare("SELECT id, name FROM retail_stores WHERE organization_id = ? AND active = 1 ORDER BY name ASC").all(orgId) as any[])
        .map((r) => ({ id: r.id, name: r.name }));
      out.push({ organizationId: orgId, businessName: biz, users, retailStores });
    }
    return out;
  }

  /**
   * Move um gerente da sua loja atual para outra loja do MESMO grupo (mesmo login).
   * Retorna { ok } ou { ok:false, code } com o motivo (a rota traduz p/ HTTP).
   */
  static transferUser(input: {
    groupId: string; ownerIdentityId: string; userId: string; toOrgId: string; actorUserId?: string | null;
    storeIds?: string[];
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

    // O resto (colisão de e-mail, escopo de loja obrigatório, perfil equivalente, user_stores e sessão) é a mesma
    // regra de qualquer remanejamento de usuário entre empresas — fonte única em UserOrgMoveService.
    const moved = UserOrgMoveService.move({ userId, toOrgId, storeIds: input.storeIds, actorUserId: input.actorUserId, allowOwnerRole: true });
    if (!moved.ok) return { ok: false, code: moved.code };
    return { ok: true, fromOrgId };
  }
}

export default OrgGroupStaffService;
