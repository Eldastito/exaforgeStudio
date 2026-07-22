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

// POST /api/health-center/apply — aplica uma prioridade → ação no Impact Ledger.
router.post("/apply", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const { source, title, impact, rationale, baselineShortfall } = req.body || {};
  const out = BusinessHealthService.apply(orgId, { source, title, impact: Number(impact) || 0, rationale, baselineShortfall: Number(baselineShortfall) || 0 }, req.user?.userId);
  if (!out.ok) return res.status(400).json(out);
  res.status(201).json(out);
});

export default router;
