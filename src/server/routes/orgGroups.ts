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
import { GroupConsolidationService } from "../GroupConsolidationService.js";
import { GroupBillingService } from "../GroupBillingService.js";

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

/**
 * F2 — visão consolidada do grupo (fan-out, read-only). Só o dono/admin do grupo.
 * ?month=YYYY-MM (default: mês corrente) · ?orgId= filtra por operação. Money — a rota
 * é role-gated (owner/admin). Valida que o grupo é do dono da sessão (isolamento).
 */
router.get("/:groupId/consolidated", requireRole("owner", "admin"), (req: AuthRequest, res: Response): any => {
  if (!gate(req, res)) return;
  const identityId = AccountIdentityService.identityIdForUser(req.user!.userId);
  const groupId = String(req.params.groupId || "");
  const group = OrgGroupService.getGroup(groupId);
  if (!group || !identityId || group.ownerIdentityId !== identityId) {
    return res.status(404).json({ error: "Not found" }); // não revela grupo de outro dono
  }
  const month = String(req.query.month || new Date().toISOString().slice(0, 7));
  const onlyOrg = req.query.orgId ? String(req.query.orgId) : undefined;
  res.json(GroupConsolidationService.consolidateMonthly(groupId, month, { onlyOrg }));
});

/**
 * PRÉVIA de fatura do grupo (read-model, NÃO cobra). Só o dono/admin do grupo. Dinheiro
 * → role-gated. ?groupAddon= (valor do add-on de grupo; default 0 — não inventa).
 */
router.get("/:groupId/billing-preview", requireRole("owner", "admin"), (req: AuthRequest, res: Response): any => {
  if (!gate(req, res)) return;
  const identityId = AccountIdentityService.identityIdForUser(req.user!.userId);
  const groupId = String(req.params.groupId || "");
  const group = OrgGroupService.getGroup(groupId);
  if (!group || !identityId || group.ownerIdentityId !== identityId) {
    return res.status(404).json({ error: "Not found" });
  }
  const groupAddon = req.query.groupAddon != null ? Number(req.query.groupAddon) : 0;
  // ?split=payer → faturamento SEPARADO (uma prévia por pagador; cada CNPJ paga a própria).
  if (String(req.query.split || "") === "payer") {
    return res.json(GroupBillingService.previewByPayer(groupId, { groupAddon }));
  }
  res.json(GroupBillingService.preview(groupId, { groupAddon }));
});

/** Define o pagador (faturamento separado) de uma operação: body { orgId, payerRef|null }. */
router.post("/:groupId/payer", requireRole("owner", "admin"), (req: AuthRequest, res: Response): any => {
  if (!gate(req, res)) return;
  const identityId = AccountIdentityService.identityIdForUser(req.user!.userId);
  const groupId = String(req.params.groupId || "");
  const group = OrgGroupService.getGroup(groupId);
  if (!group || !identityId || group.ownerIdentityId !== identityId) {
    return res.status(404).json({ error: "Not found" });
  }
  const orgId = String(req.body?.orgId || "");
  if (!orgId) return res.status(400).json({ error: "orgId obrigatório" });
  const ok = OrgGroupService.setPayerRef(groupId, orgId, req.body?.payerRef ?? null);
  if (!ok) return res.status(404).json({ error: "operação não está no grupo" });
  res.json({ ok: true });
});

export default router;
