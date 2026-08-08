import { Router } from "express";
import { AuthRequest } from "../middleware/auth.js";
import { EvidencePackageService } from "../EvidencePackageService.js";
import { ImpactPrioritizationService } from "../ImpactPrioritizationService.js";

/**
 * Decision Intelligence — rotas de leitura (DI-1, aditivo sobre ADR-135/136).
 * Sem UI/menu novo: expõe o Evidence Package v1 e o Pareto já com níveis L0–L4
 * para os consumidores existentes (Diretor IA / Cockpit) e para a DI-2.
 */
const router = Router();

// GET /api/decision-intelligence/evidence?subject=&period=&force=1
// Pacote de evidências reutilizável (interno). Cacheado se a org opta pelo flag.
router.get("/evidence", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const subject = typeof req.query?.subject === "string" ? req.query.subject : undefined;
  const period = typeof req.query?.period === "string" ? req.query.period : undefined;
  const force = req.query?.force === "1" || req.query?.force === "true";
  res.json({ evidence: EvidencePackageService.build(orgId, { subject, period, force }) });
});

// GET /api/decision-intelligence/priorities — Pareto de sinais abertos já com
// impactLevel (L0–L4) + perfil de análise recomendado por prioridade.
router.get("/priorities", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json(ImpactPrioritizationService.prioritize(orgId));
});

export default router;
