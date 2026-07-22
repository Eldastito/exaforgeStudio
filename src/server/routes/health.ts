import { Router } from "express";
import { AuthRequest } from "../middleware/auth.js";
import { BusinessHealthService } from "../BusinessHealthService.js";

// Central de Saúde e Decisão (ADR-126) — síntese: status + 3 prioridades do dia.
// Rota core (não é módulo opcional): disponível em todas as verticais.
const router = Router();

// GET /api/health-center — status geral + frase-síntese + top-3 prioridades.
router.get("/", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const minCash = Number(req.query?.minCash) || 0;
  res.json(BusinessHealthService.overview(orgId, minCash));
});

export default router;
