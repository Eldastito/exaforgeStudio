import { Router } from "express";
import { AuthRequest, requireRole } from "../middleware/auth.js";
import { SkillOsRegistryService } from "../SkillOsRegistryService.js";
import { SkillOsResolverService } from "../SkillOsResolverService.js";

/**
 * SkillOS — leitura do CATÁLOGO de Capabilities/Skills (PRD 4 F2). Só lookup nesta
 * fase (registro/seleção/execução são fases seguintes). Leitura pra gestor
 * (owner/admin) — o catálogo é de plataforma, não expõe dado de tenant. Inerte até
 * o catálogo ter conteúdo.
 */
const router = Router();

// GET /api/skillos/capabilities?status=&category=&vertical=
router.get("/capabilities", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const q = req.query || {};
  res.json({ capabilities: SkillOsRegistryService.listCapabilities({ status: q.status as any, category: q.category as any, vertical: q.vertical as any }) });
});

// GET /api/skillos/capabilities/:id — uma Capability + as Skills que a atendem.
router.get("/capabilities/:id", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const cap = SkillOsRegistryService.getCapability(req.params.id);
  if (!cap) return res.status(404).json({ error: "Capability não encontrada." });
  res.json({ capability: cap, skills: SkillOsRegistryService.skillsForCapability(cap.capabilityId, { vertical: req.query.vertical as any, includeInactive: true }) });
});

// GET /api/skillos/skills?capabilityId=&status=&vertical=
router.get("/skills", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const q = req.query || {};
  res.json({ skills: SkillOsRegistryService.listSkills({ capabilityId: q.capabilityId as any, status: q.status as any, vertical: q.vertical as any }) });
});

// POST /api/skillos/resolve { capabilityId, vertical?, maxRisk? } — qual Skill o
// Resolver escolheria (F3). Inspeção/explicabilidade; NÃO executa. Gestor.
router.post("/resolve", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const b = req.body || {};
  res.json(SkillOsResolverService.resolve(orgId, req.user, { capabilityId: b.capabilityId, vertical: b.vertical, maxRisk: b.maxRisk, requirePermissions: !!b.requirePermissions }));
});

export default router;
