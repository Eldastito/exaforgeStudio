import { Router } from "express";
import { AuthRequest } from "../middleware/auth.js";
import { ManagerialDreService } from "../ManagerialDreService.js";

// DRE Gerencial Simplificada (ADR-128) — venda × lucro × caixa. Rota core
// (não é módulo opcional): disponível em todas as verticais.
const router = Router();

// GET /api/dre?period=YYYY-MM — DRE gerencial do mês (padrão: mês corrente).
router.get("/", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const period = /^\d{4}-\d{2}$/.test(String(req.query?.period || "")) ? String(req.query.period) : undefined;
  res.json(ManagerialDreService.monthly(orgId, period));
});

export default router;
