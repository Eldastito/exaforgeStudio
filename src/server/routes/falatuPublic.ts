import { Router } from "express";
import { PlanService } from "../PlanService.js";

/**
 * Rotas PÚBLICAS do FalaTu (sem auth) — ADR-154 F2.2 (Fatia A).
 *
 * Por enquanto só o catálogo comercial (Solo/Pro/Família): a landing e o
 * checkout (Fatia B) consomem daqui em vez de hardcodar preço. Read-only e
 * público de propósito — plano/preço é informação de vitrine.
 */
const router = Router();

// GET /api/public/falatu/plans → catálogo B2C do FalaTu.
router.get("/plans", (_req, res): any => {
  try {
    return res.json({ plans: PlanService.listFalatuPlans() });
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
});

export default router;
