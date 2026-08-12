/**
 * Rotas /api/ux — superfícies de UX invisível (PRD 6 / ADR-163). GET-only,
 * composição pura (nenhum engine novo). Consumidor: frontend das telas
 * "Executando" (§45-47) e "Resultados" (§48-49). Tudo role-scoped + dinheiro
 * role-gated (§73) no próprio service. Aditivo — nenhuma rota anterior mudou.
 */
import { Router } from "express";
import { AuthRequest } from "../middleware/auth.js";
import { ExecutionResultsService } from "../ExecutionResultsService.js";

const router = Router();

// GET /api/ux/executing — processos ativos agrupados por objetivo.
router.get("/executing", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId || !req.user) return res.status(401).json({ error: "Unauthorized" });
  res.json(ExecutionResultsService.executing(orgId, req.user));
});

// GET /api/ux/results — Impact Ledger unificado (categorias separadas) + metas.
router.get("/results", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId || !req.user) return res.status(401).json({ error: "Unauthorized" });
  res.json(ExecutionResultsService.results(orgId, req.user));
});

export default router;
