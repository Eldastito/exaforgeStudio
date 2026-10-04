import db from "./db.js";
import { PermissionService } from "./PermissionService.js";
import { RetailStoreScopeService } from "./RetailStoreScopeService.js";
import { bumpSecurityVersion } from "./middleware/auth.js";
import { MASTER_ADMIN_EMAIL } from "./config/secret.js";

/**
 * UserOrgMoveService — MOVE um usuário (mesmo login/identidade) de uma empresa para outra.
 *
 * Origem do problema (TOULON, 04/10): o gerente de loja foi cadastrado numa empresa SEPARADA
 * (ex.: "Toulon Carioca") e as lojas/Alterdata/histórico estão na empresa principal (TOULON).
 * O isolamento é por `organization_id` — a conta do gerente só lê dados da empresa em que está —,
 * então a correção é pôr o LOGIN dentro da empresa certa, NUNCA abrir leitura entre empresas.
 *
 * Invariantes (as mesmas de `OrgGroupStaffService.transferUser`, que agora delega pra cá):
 *  - nunca move dono nem o master admin;
 *  - destino precisa existir; mesma empresa é recusada; e-mail já existente no destino é recusado;
 *  - ESCOPO DE LOJA OBRIGATÓRIO: se o destino tem lojas de varejo, exige ≥1 loja DELE (`storeIds`) e
 *    grava o vínculo na MESMA transação — sem isso o gerente cairia "sem atribuição" = irrestrito
 *    (RetailStoreScopeService.allowed) e veria a rede inteira;
 *  - o perfil RBAC é remapeado pelo `system_key` pro perfil equivalente DO DESTINO (perfil é por empresa);
 *  - `security_version` sobe → a sessão antiga (que claim a empresa de origem) cai e ele reloga já na nova.
 * Quem autoriza é o chamador (master admin na rota admin; dono do grupo na rota de grupo).
 */
export interface MoveUserInput { userId: string; toOrgId: string; storeIds?: string[]; actorUserId?: string | null; allowOwnerRole?: boolean }
export interface MoveUserResult { ok: boolean; code?: string; fromOrgId?: string }

const ACTIVE = "(u.global_status IS NULL OR u.global_status NOT IN ('blocked','deleted'))";

export class UserOrgMoveService {
  static move(input: MoveUserInput): MoveUserResult {
    const { userId, toOrgId } = input;
    const user = db.prepare("SELECT id, organization_id, email, role, role_profile_id, global_status FROM users WHERE id = ?").get(userId) as any;
    if (!user) return { ok: false, code: "user_not_found" };
    if (user.global_status === "deleted") return { ok: false, code: "user_deleted" };
    if (user.email && user.email === MASTER_ADMIN_EMAIL) return { ok: false, code: "cannot_move_master_admin" };
    if (user.role === "owner" && !input.allowOwnerRole) return { ok: false, code: "cannot_move_owner" };

    const dest = db.prepare("SELECT 1 FROM organization_settings WHERE organization_id = ? AND deleted_at IS NULL").get(toOrgId);
    if (!dest) return { ok: false, code: "target_not_found" };
    const fromOrgId = user.organization_id;
    if (fromOrgId === toOrgId) return { ok: false, code: "same_org" };

    // Colisão: o destino não pode já ter usuário ATIVO com o mesmo e-mail (UNIQUE(organization_id, email)).
    if (user.email) {
      const clash = db.prepare(`SELECT 1 FROM users u WHERE u.organization_id = ? AND u.email = ? AND u.id != ? AND ${ACTIVE}`).get(toOrgId, user.email, userId);
      if (clash) return { ok: false, code: "email_exists_in_target" };
    }

    // Escopo de loja: destino com lojas de varejo EXIGE ≥1 loja dele (nunca deixa o gerente irrestrito).
    const destStoreIds = new Set((db.prepare("SELECT id FROM retail_stores WHERE organization_id = ?").all(toOrgId) as any[]).map((r) => String(r.id)));
    const wantedStores = Array.from(new Set((input.storeIds || []).map(String).filter(Boolean)));
    if (destStoreIds.size > 0 && wantedStores.length === 0) return { ok: false, code: "store_required" };
    if (wantedStores.some((id) => !destStoreIds.has(id))) return { ok: false, code: "store_not_in_target" };

    // Perfil equivalente no destino: mapeia pelo system_key do perfil atual. Sem perfil atual → null.
    let destProfileId: string | null = null;
    if (user.role_profile_id) {
      const srcKey = (db.prepare("SELECT system_key FROM role_profiles WHERE id = ?").get(user.role_profile_id) as any)?.system_key || null;
      if (srcKey) {
        PermissionService.seedSystemProfiles(toOrgId); // garante os templates no destino (idempotente)
        destProfileId = (db.prepare("SELECT id FROM role_profiles WHERE organization_id = ? AND system_key = ?").get(toOrgId, srcKey) as any)?.id || null;
      }
    }

    const tx = db.transaction(() => {
      db.prepare("UPDATE users SET organization_id = ?, role_profile_id = ? WHERE id = ?").run(toOrgId, destProfileId, userId);
      // Escopo de loja é por empresa: as linhas da origem não valem no destino.
      try { db.prepare("DELETE FROM user_stores WHERE user_id = ?").run(userId); } catch { /* tabela pode não existir em legado */ }
      if (wantedStores.length) RetailStoreScopeService.setForUser(toOrgId, userId, wantedStores, input.actorUserId || undefined);
    });
    tx();

    // Revoga a sessão atual (o token velho claim a empresa de origem) — força relogin na nova.
    bumpSecurityVersion(userId);
    return { ok: true, fromOrgId };
  }
}

export default UserOrgMoveService;
