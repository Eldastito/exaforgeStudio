/**
 * Router — ADR-153 F7.3: recomendações de upgrade + histórico + cooldown.
 *
 * PRD §14/§15 + Decisão #7. Exposto em `/api/billing/recommendations`.
 *
 * Rotas:
 *   GET  /api/billing/recommendations                — lista (default excl. expired)
 *   GET  /api/billing/recommendations/:id            — detalhe de uma recomendação
 *   POST /api/billing/recommendations/:id/dismiss    — dispensa + cooldown
 *   POST /api/billing/recommendations/:id/accept     — marca aceita (NÃO executa upgrade)
 *
 * G-153-3: `accept` só marca aceito e retorna o `targetPlanId`. Frontend leva o
 * dono pra tela de Cobrança (checkout real vem em F5.3). Nada é cobrado aqui.
 *
 * Isolamento multi-tenant: organization_id de req.organizationId em toda query.
 */
import { Router } from "express";
import { AuthRequest } from "../middleware/auth.js";
import { UpgradeRecommendationService } from "../UpgradeRecommendationService.js";

const router = Router();
const actor = (req: AuthRequest) => req.user?.userId || null;

// GET /api/billing/recommendations?status=pending&includeExpired=false
router.get("/", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const status = typeof req.query?.status === "string" ? req.query.status : undefined;
  const includeExpired = String(req.query?.includeExpired || "") === "true";
  const limit = req.query?.limit ? Math.min(200, Math.max(1, Number(req.query.limit))) : undefined;
  res.json({ recommendations: UpgradeRecommendationService.list(orgId, { status, includeExpired, limit }) });
});

// ADR-153 F4.4 — série temporal aceitas × dispensadas por bucket diário. Consumido
// pelo RecommendationTrendChart na aba "Plano e Expansões". Dias clampado 7..180
// no service (default 30).
// GET /api/billing/recommendations/history-chart?days=30
router.get("/history-chart", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const days = req.query?.days ? Number(req.query.days) : undefined;
  res.json(UpgradeRecommendationService.historyByBucket(orgId, { days }));
});

// GET /api/billing/recommendations/:id
router.get("/:id", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const rec = UpgradeRecommendationService.getById(orgId, req.params.id);
  if (!rec) return res.status(404).json({ error: "Recomendação não encontrada." });
  res.json({ recommendation: rec });
});

// POST /api/billing/recommendations/:id/dismiss
router.post("/:id/dismiss", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const out = UpgradeRecommendationService.dismiss(orgId, req.params.id, actor(req));
  if (!out.ok) return res.status(404).json({ error: "Recomendação não encontrada." });
  res.json(out);
});

// POST /api/billing/recommendations/:id/accept
// G-153-3: NÃO executa upgrade — só marca aceita. Frontend redireciona pra
// Cobrança onde há aceite explícito + método de pagamento + CPF/CNPJ.
router.post("/:id/accept", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const out = UpgradeRecommendationService.accept(orgId, req.params.id, actor(req));
  if (!out.ok) return res.status(404).json({ error: "Recomendação não encontrada." });
  res.json({
    ...out,
    // Hint pro frontend: destino do checkout.
    redirectTo: out.recommendation?.targetPlanId
      ? `/settings?tab=cobranca&target=${encodeURIComponent(out.recommendation.targetPlanId)}`
      : "/settings?tab=cobranca",
    note: "G-153-3: nenhuma cobrança feita. Finalize o upgrade em Cobrança.",
  });
});

export default router;
