/**
 * OrgGroupProvisioningService — ADR-199 F1: "Adicionar operação ao grupo".
 *
 * Provisiona uma NOVA org (marca/operação) para o dono de um grupo, com PARIDADE de
 * plano, e a vincula ao grupo — a fatia que resolve o cliente franqueado de N marcas
 * (Toulon + Democrata) num único login.
 *
 * REUSO (§4/D6, sem reinventar): a org nova nasce pelo MESMO pipeline do cadastro
 * (organization_settings + PlanService.selectPlan + ModuleService), e o dono ganha uma
 * linha de `users` ligada à MESMA identidade (AccountIdentityService) — é por isso que
 * o mesmo humano acessa as duas marcas e alterna com switch-org (F0c-2).
 *
 * ISOLAMENTO (RN-GRP-01): cada org é um tenant COMPLETO e isolado (catálogo/contatos/
 * fiscal/estoque próprios). Este service só CRIA a org e a registra no grupo — nunca
 * compartilha dado entre orgs. O grupo é só metadado de agregação.
 *
 * IDEMPOTENTE (critério de aceite): reexecutar com o mesmo (grupo, businessName, dono)
 * devolve a org existente em vez de duplicar.
 *
 * PRÉ-REQUISITO: criar a 2ª linha de `users` com o MESMO email exige o schema relaxado
 * da F0c-1 (UNIQUE(org,email)). Por isso as rotas ficam atrás de FEATURE_ORG_GROUPS,
 * assim como o rebuild.
 *
 * FORA DESTA FATIA (F1 core): conexão de WhatsApp/ERP/fiscal por CNPJ — precisam de
 * credenciais reais por operação e entram como wiring separado (F1b). Aqui entregamos
 * a paridade de PLANO (features), que é o critério de aceite testável.
 */
import { randomUUID } from "crypto";
import db from "./db.js";
import { PlanService } from "./PlanService.js";
import { ModuleService } from "./ModuleService.js";
import { OrgGroupService } from "./OrgGroupService.js";
import { AccountIdentityService } from "./AccountIdentityService.js";
import { logAuthEvent } from "./auditLog.js";

export interface ProvisionInput {
  ownerIdentityId: string;          // dono do grupo (identidade)
  businessName: string;             // nome da nova operação
  owner?: { name?: string; role?: string }; // dados da linha de users do dono (email vem da identidade)
  phone?: string | null;
  vertical?: string | null;         // vertical explícita (se não copiar de outra org)
  planId?: string | null;           // plano explícito
  copyPlanFromOrgId?: string | null; // PARIDADE: copia plano + módulos + vertical desta org
  groupId?: string | null;          // grupo alvo; senão usa/cria o grupo do dono
  groupName?: string | null;        // nome ao criar o grupo
  actorUserId?: string | null;      // auditoria
}

export interface ProvisionResult {
  organizationId: string;
  userId: string;
  groupId: string;
  created: boolean;                 // false = já existia (idempotência)
}

function norm(s?: string | null): string { return String(s ?? "").trim(); }

export class OrgGroupProvisioningService {
  /** Resolve (ou cria) o grupo do dono. */
  private static resolveGroup(ownerIdentityId: string, groupId?: string | null, groupName?: string | null): string {
    if (groupId) {
      const g = OrgGroupService.getGroup(groupId);
      if (!g) throw new Error("group_not_found");
      if (g.ownerIdentityId !== ownerIdentityId) throw new Error("group_owner_mismatch");
      return g.id;
    }
    const existing = OrgGroupService.groupsForOwner(ownerIdentityId);
    if (existing.length) return existing[0].id;
    const identity = AccountIdentityService.getById(ownerIdentityId);
    const name = norm(groupName) || `Grupo de ${identity?.email || "operações"}`;
    return OrgGroupService.createGroup({ name, ownerIdentityId }).id;
  }

  /** Se o grupo já tem uma operação com este nome e o dono, devolve-a (idempotência). */
  private static findExisting(groupId: string, businessName: string, ownerIdentityId: string): ProvisionResult | null {
    const members = OrgGroupService.membersOf(groupId);
    for (const m of members) {
      const s = db.prepare("SELECT business_name FROM organization_settings WHERE organization_id = ?").get(m.organizationId) as any;
      if (!s || norm(s.business_name).toLowerCase() !== norm(businessName).toLowerCase()) continue;
      const u = AccountIdentityService.userRowForOrg(ownerIdentityId, m.organizationId);
      if (u) return { organizationId: m.organizationId, userId: u.id, groupId, created: false };
    }
    return null;
  }

  static provision(input: ProvisionInput): ProvisionResult {
    const ownerIdentityId = norm(input.ownerIdentityId);
    const businessName = norm(input.businessName);
    if (!ownerIdentityId) throw new Error("owner_identity_required");
    if (!businessName) throw new Error("business_name_required");
    const identity = AccountIdentityService.getById(ownerIdentityId);
    if (!identity) throw new Error("owner_identity_not_found"); // não inventa identidade
    if (!identity.email) throw new Error("owner_identity_without_email");

    const groupId = OrgGroupProvisioningService.resolveGroup(ownerIdentityId, input.groupId, input.groupName);

    // Idempotência: reexecução não duplica org/canal (critério de aceite F1).
    const already = OrgGroupProvisioningService.findExisting(groupId, businessName, ownerIdentityId);
    if (already) return already;

    const orgId = "org_" + randomUUID().substring(0, 8);
    const userId = randomUUID();

    // Fonte da PARIDADE: copiar de uma org de referência, ou plano/vertical explícitos.
    let refPlan: string | null = norm(input.planId) || null;
    let refVertical: string | null = norm(input.vertical) || null;
    let refModules: string[] | null = null;
    if (input.copyPlanFromOrgId) {
      const ref = db.prepare("SELECT plan_id, vertical, enabled_modules FROM organization_settings WHERE organization_id = ?").get(norm(input.copyPlanFromOrgId)) as any;
      if (!ref) throw new Error("reference_org_not_found");
      refPlan = ref.plan_id || refPlan;
      refVertical = ref.vertical || refVertical;
      try { const m = JSON.parse(ref.enabled_modules || "null"); if (Array.isArray(m)) refModules = m.map(String); } catch { /* noop */ }
    }

    // Credencial do dono: espelha a da identidade na nova linha de users (mantém o
    // login/switch consistentes; a identidade continua sendo a fonte de verdade).
    const cred = db.prepare("SELECT password_hash, mfa_secret, mfa_enabled, mfa_backup_codes FROM account_identities WHERE id = ?").get(ownerIdentityId) as any;

    const tx = db.transaction(() => {
      db.prepare(`
        INSERT INTO organization_settings (id, organization_id, business_name, phone, status, onboarding_status, plan_id, billing_status)
        VALUES (?, ?, ?, ?, 'active', 'completed', ?, 'active')
      `).run(randomUUID(), orgId, businessName, norm(input.phone) || null, refPlan || 'cortesia');

      // Plano é o teto; aplica ANTES da vertical (interseção no applyVertical).
      if (refPlan) { try { PlanService.selectPlan(orgId, refPlan); } catch { /* noop */ } }
      if (refModules) {
        // Paridade exata: replica o conjunto de módulos da org de referência.
        if (refVertical) db.prepare("UPDATE organization_settings SET vertical = ? WHERE organization_id = ?").run(refVertical, orgId);
        ModuleService.setModules(orgId, refModules);
      } else if (refVertical) {
        ModuleService.applyVertical(orgId, refVertical);
      }

      db.prepare(`
        INSERT INTO users (id, organization_id, name, email, phone, password_hash, mfa_secret, mfa_enabled, mfa_backup_codes, role, global_status, identity_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)
      `).run(
        userId, orgId, norm(input.owner?.name) || identity.email, identity.email, norm(input.phone) || null,
        cred?.password_hash ?? null, cred?.mfa_secret ?? null, cred?.mfa_enabled ? 1 : 0, cred?.mfa_backup_codes ?? null,
        norm(input.owner?.role) || "owner", ownerIdentityId
      );

      OrgGroupService.addMember(groupId, orgId, input.actorUserId || undefined);
    });
    tx();

    try { logAuthEvent(orgId, userId, input.actorUserId || null, "ORG_GROUP_OPERATION_PROVISIONED", { groupId, businessName, ownerIdentityId }); } catch { /* noop */ }

    return { organizationId: orgId, userId, groupId, created: true };
  }
}
