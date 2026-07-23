import { Router } from "express";
import { AuthRequest } from "../middleware/auth.js";
import { AiGovernanceService } from "../AiGovernanceService.js";

// Governança de IA (ADR-130) — política vigente + auditoria de decisões que
// afetam pessoas. Rota core (todas as verticais).
const router = Router();

// GET /api/ai-governance — política de governança de IA (controles vigentes).
router.get("/", (req: AuthRequest, res): any => {
  if (!req.organizationId) return res.status(401).json({ error: "Unauthorized" });
  res.json(AiGovernanceService.policy());
});

// GET /api/ai-governance/decisions — auditoria das decisões que afetam pessoas.
router.get("/decisions", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json({ decisions: AiGovernanceService.decisions(orgId) });
});

export default router;
