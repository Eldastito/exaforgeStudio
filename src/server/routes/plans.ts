import { Router } from "express";
import { AuthRequest } from "../middleware/auth.js";
import { PlanService } from "../PlanService.js";

const router = Router();

// GET /api/plans — lista os planos disponíveis (público para a UI de escolha).
router.get("/", (req: AuthRequest, res): any => {
  try {
    res.json(PlanService.listPlans());
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// GET /api/plans/current — plano atual + status + uso vs limites.
router.get("/current", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    res.json(PlanService.getBillingSnapshot(orgId));
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// GET /api/plans/alerts — alertas de uso (80/90/100% dos limites do plano).
router.get("/alerts", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    res.json({ alerts: PlanService.getUsageAlerts(orgId) });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// POST /api/plans/select — escolhe/troca o plano da org. Inicia trial na primeira escolha.
router.post("/select", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const { planId } = req.body || {};
    if (!planId) return res.status(400).json({ error: "planId é obrigatório." });
    const r = PlanService.selectPlan(orgId, planId);
    if (!r.ok) return res.status(400).json({ error: r.reason || "Erro ao selecionar plano." });
    res.json({ success: true, ...PlanService.getBillingSnapshot(orgId) });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;
