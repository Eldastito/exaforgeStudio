/**
 * Rotas /api/ux — superfícies de UX invisível (PRD 6 / ADR-163). GET-only,
 * composição pura (nenhum engine novo). Consumidor: frontend das telas
 * "Executando" (§45-47) e "Resultados" (§48-49). Tudo role-scoped + dinheiro
 * role-gated (§73) no próprio service. Aditivo — nenhuma rota anterior mudou.
 */
import { Router } from "express";
import { AuthRequest } from "../middleware/auth.js";
import { ExecutionResultsService } from "../ExecutionResultsService.js";
import { AdaptiveOnboardingService } from "../AdaptiveOnboardingService.js";

const router = Router();
const actor = (req: AuthRequest) => req.user?.userId;

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

// GET /api/ux/onboarding/discover — perfil autodescoberto + lacunas (§17-25).
router.get("/onboarding/discover", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId || !req.user) return res.status(401).json({ error: "Unauthorized" });
  res.json(AdaptiveOnboardingService.discover(orgId, req.user));
});

// POST /api/ux/onboarding/confirm { key, value } — confirma/corrige campo descritivo.
router.post("/onboarding/confirm", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId || !req.user) return res.status(401).json({ error: "Unauthorized" });
  const r = AdaptiveOnboardingService.confirm(orgId, actor(req), { key: req.body?.key, value: req.body?.value });
  res.status(r.applied ? 200 : 400).json(r);
});

export default router;
