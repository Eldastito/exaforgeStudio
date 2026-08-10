import { Router } from "express";
import { AuthRequest, requireRole } from "../middleware/auth.js";
import { BusinessGoalService } from "../BusinessGoalService.js";

/**
 * Metas do negócio (ADR-160 F4 / D4) — o dono define objetivos por métrica e lê
 * a DISTÂNCIA À META derivada do snapshot/analytics. Leitura pra qualquer papel
 * autenticado; definir/remover meta é do gestor (owner/admin). Rota inerte até o
 * dono criar a 1ª meta (0 regressão).
 */
const router = Router();
const actor = (req: AuthRequest) => req.user?.userId;

// GET /api/goals — metas vigentes (o alvo definido pelo dono, por métrica).
router.get("/", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json({ goals: BusinessGoalService.list(orgId), catalog: BusinessGoalService.catalog() });
});

// GET /api/goals/progress — distância à meta (realizado + quanto falta + pace).
router.get("/progress", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json(BusinessGoalService.progress(orgId));
});

// PUT /api/goals { metric, targetAmount } — define/atualiza a meta (gestor).
router.put("/", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const goal = BusinessGoalService.set(orgId, { metric: req.body?.metric, targetAmount: Number(req.body?.targetAmount), actor: actor(req) });
    res.json({ ok: true, goal });
  } catch (e: any) {
    res.status(400).json({ error: String(e?.message || e) });
  }
});

// DELETE /api/goals/:metric — remove a meta de uma métrica (gestor).
router.delete("/:metric", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json({ ok: true, ...BusinessGoalService.remove(orgId, req.params.metric) });
});

export default router;
