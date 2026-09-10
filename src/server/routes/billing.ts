/**
 * Router — ADR-153 Fatia 6.1: catálogo de planos + snapshot atual + preview de
 * mudança de plano (proporcionalidade). Exposto em `/api/billing`.
 *
 * Rotas (todas READ/COMPUTE — nenhuma cobra, aceita termos ou toca provedor):
 *   GET  /api/billing/plans                — catálogo comercial (planos + preço + módulos)
 *   GET  /api/billing/current              — snapshot do billing da org (plano/status/uso)
 *   POST /api/billing/upgrade/preview      — { targetPlanId } → proporcionalidade + diff (§19)
 *
 * Dinheiro é role-gated (§73): só owner/admin veem preço/proporcional. O
 * checkout/confirm reais (Fatias 5.2/5.3) estão BLOQUEADOS por decisões externas
 * (Decisão #2 jurídico / Asaas homologado) e NÃO vivem aqui.
 *
 * Isolamento multi-tenant: `organization_id` de req.organizationId em toda query.
 */
import { Router } from "express";
import { AuthRequest } from "../middleware/auth.js";
import { PlanService } from "../PlanService.js";
import { SubscriptionOrchestratorService, PlanChangePreviewError } from "../SubscriptionOrchestratorService.js";

const router = Router();
const canSeeMoney = (req: AuthRequest) => ["owner", "admin"].includes(String(req.user?.role || ""));

// GET /api/billing/plans — catálogo comercial (exclui os planos B2C do FalaTu).
router.get("/plans", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  if (!canSeeMoney(req)) return res.status(403).json({ error: "Apenas gestores veem planos e preços." });
  return res.json({ plans: PlanService.listPlans() });
});

// GET /api/billing/current — snapshot do billing da org.
router.get("/current", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  if (!canSeeMoney(req)) return res.status(403).json({ error: "Apenas gestores veem o plano e o faturamento." });
  return res.json(PlanService.getBillingSnapshot(orgId));
});

// POST /api/billing/upgrade/preview — { targetPlanId } → preview de proporcionalidade.
// READ-ONLY: não muda o plano nem cobra. É o cálculo por trás do CTA de upgrade.
router.post("/upgrade/preview", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  if (!canSeeMoney(req)) return res.status(403).json({ error: "Apenas gestores podem simular mudança de plano." });
  const targetPlanId = String(req.body?.targetPlanId || "").trim();
  if (!targetPlanId) return res.status(400).json({ error: "targetPlanId é obrigatório." });
  const r = SubscriptionOrchestratorService.preview(orgId, targetPlanId);
  if (r.ok) return res.json(r);
  return res.status(404).json({ error: "Plano não encontrado.", code: (r as PlanChangePreviewError).reason });
});

export default router;
