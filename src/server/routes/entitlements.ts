/**
 * Rotas /api/entitlements — GET-only (ADR-153 F1.1).
 *
 * Consumidor: frontend (Sidebar, ModulesPanel, futura "Plano e Expansões" UI)
 * e o próprio ExecutiveAdvisor (F7) quando precisar saber o que o dono pode
 * ver/comprar antes de fazer recomendação.
 *
 * Aditivo puro — nenhuma rota anterior mudou. F1.3 vai migrar useStore pra
 * chamar essas rotas em vez de compor localmente ModuleService + Permission.
 */
import { Router } from "express";
import { AuthRequest } from "../middleware/auth.js";
import { EntitlementService, type EntitlementAction } from "../EntitlementService.js";
import { PermissionService } from "../PermissionService.js";
import { FalaTuService } from "../FalaTuService.js";
import { MASTER_ADMIN_EMAIL } from "../config/secret.js";
import db from "../db.js";

const router = Router();

// GET /api/entitlements/me — mapa completo (todos os módulos CORE + OPTIONAL)
// pra o usuário logado, MAIS bloco `meta` com o contexto de plano/vertical/
// isMasterAdmin/hasProfile/falatuEnabled/permissions — fonte única do frontend.
// Substitui a combinação de GET /api/analytics/settings + GET /api/permissions/me
// + ModuleService.overview em uma chamada só (ADR-153 F1.3).
router.get("/me", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId || !req.user) return res.status(401).json({ error: "Unauthorized" });
  try {
    const map = EntitlementService.overview(orgId, req.user);
    const org = db.prepare(
      `SELECT vertical, plan_id, default_landing_view FROM organization_settings WHERE organization_id = ? AND deleted_at IS NULL`,
    ).get(orgId) as any || {};
    const meta = {
      isMasterAdmin: !!(req.user.email && req.user.email === MASTER_ADMIN_EMAIL),
      hasProfile: PermissionService.hasProfile(orgId, req.user),
      falatuEnabled: FalaTuService.orgEnabled(orgId),
      vertical: org.vertical || null,
      planId: org.plan_id || null,
      defaultLandingView: org.default_landing_view || null,
      permissions: PermissionService.permissionMap(orgId, req.user),
    };
    res.json({ entitlements: map, meta });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/entitlements/modules — mesma coisa que /me mas achatado como array
// (útil pra ModulesPanel que hoje itera sobre `overview.items`).
router.get("/modules", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId || !req.user) return res.status(401).json({ error: "Unauthorized" });
  try {
    const map = EntitlementService.overview(orgId, req.user);
    const items = Object.entries(map).map(([resource, d]) => ({ resource, ...d }));
    res.json({ items });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/entitlements/resource/:key?action=view|use|enable|buy|execute
// Consulta pontual — o middleware de rota (F1.2) e o motor de recomendação
// (F7) chamam pra decidir 1 caso específico.
router.get("/resource/:key", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId || !req.user) return res.status(401).json({ error: "Unauthorized" });
  const key = String(req.params.key || "").trim();
  if (!key) return res.status(400).json({ error: "resource key required" });
  const rawAction = String(req.query.action || "view");
  const validActions: EntitlementAction[] = ["view", "use", "enable", "buy", "execute"];
  if (!(validActions as string[]).includes(rawAction)) {
    return res.status(400).json({ error: `action must be one of: ${validActions.join(", ")}` });
  }
  try {
    const decision = EntitlementService.check(orgId, req.user, key, rawAction as EntitlementAction);
    res.json(decision);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
