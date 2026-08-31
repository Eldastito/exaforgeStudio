/**
 * Rotas do ZapFlow Grupo (ADR-199 F1) — provisionamento "Adicionar operação ao grupo".
 * Montadas em /api/groups (protectedApi). Atrás de FEATURE_ORG_GROUPS: sem a flag → 404
 * (feature invisível, 0-regressão pro parque single-org). requireRole owner/admin: só o
 * dono/admin provisiona. O dono do grupo é a IDENTIDADE da sessão atual.
 */
import { Router, Response } from "express";
import { AuthRequest, requireRole } from "../middleware/auth.js";
import { AccountIdentityService } from "../AccountIdentityService.js";
import { OrgGroupService } from "../OrgGroupService.js";
import { OrgGroupProvisioningService } from "../OrgGroupProvisioningService.js";

const router = Router();

const orgGroupsEnabled = () => /^(1|true|yes|on)$/i.test(String(process.env.FEATURE_ORG_GROUPS || ""));
function gate(req: AuthRequest, res: Response): boolean {
  if (!orgGroupsEnabled()) { res.status(404).json({ error: "Not found" }); return false; }
  if (!req.user?.userId) { res.status(401).json({ error: "Unauthorized" }); return false; }
  return true;
}

/** Grupos do dono (identidade da sessão) + suas operações. */
router.get("/", (req: AuthRequest, res: Response): any => {
  if (!gate(req, res)) return;
  const identityId = AccountIdentityService.identityIdForUser(req.user!.userId);
  if (!identityId) return res.json({ groups: [] });
  const groups = OrgGroupService.groupsForOwner(identityId).map((g) => ({
    ...g,
    members: OrgGroupService.membersOf(g.id).map((m) => m.organizationId),
  }));
  res.json({ groups });
});

/**
 * Provisiona uma nova operação (marca) no grupo do dono, com paridade de plano.
 * Body: { businessName (obrigatório), vertical?, planId?, copyPlanFromOrgId?, groupId?,
 * groupName?, ownerName?, phone? }. Sem plano/vertical/copy explícitos, herda o plano da
 * operação ATUAL (copyPlanFromOrgId = org da sessão) — a paridade Toulon→Democrata default.
 */
router.post("/provision", requireRole("owner", "admin"), (req: AuthRequest, res: Response): any => {
  if (!gate(req, res)) return;
  const identityId = AccountIdentityService.identityIdForUser(req.user!.userId);
  if (!identityId) return res.status(400).json({ error: "no_identity" });

  const b = req.body || {};
  const businessName = String(b.businessName || "").trim();
  if (!businessName) return res.status(400).json({ error: "businessName obrigatório" });

  // Paridade default: mesmo plano da operação atual, salvo se o cliente especificar.
  const hasExplicitPlan = b.planId || b.vertical || b.copyPlanFromOrgId;
  const copyPlanFromOrgId = b.copyPlanFromOrgId || (hasExplicitPlan ? null : req.user!.organizationId);

  try {
    const result = OrgGroupProvisioningService.provision({
      ownerIdentityId: identityId,
      businessName,
      owner: { name: b.ownerName, role: "owner" },
      phone: b.phone ?? null,
      vertical: b.vertical ?? null,
      planId: b.planId ?? null,
      copyPlanFromOrgId,
      groupId: b.groupId ?? null,
      groupName: b.groupName ?? null,
      actorUserId: req.user!.userId,
    });
    res.status(result.created ? 201 : 200).json(result);
  } catch (e: any) {
    res.status(400).json({ error: e?.message || "provision_failed" });
  }
});

export default router;
