/**
 * Rotas consolidadas do Content & Growth Engine (ADR-168).
 *
 * Contexto: os endpoints Content/Growth-domain (autopilot, optimization,
 * attribution) nasceram misturados a Social em `/api/social/*` porque
 * o hub compartilha superfície (o mesmo formulário de canais social é
 * o ponto de entrada). Isto criou um blocked_reason no
 * `CONTENT_GROWTH_ENGINE` do Product Evolution Ledger: "consolidar
 * rota /api/content ou /api/growth antes de exposição externa".
 *
 * Esta fatia expõe uma superfície coerente em `/api/growth/*` que
 * delega aos MESMOS services usados por `/api/social/*` — zero
 * duplicação de lógica, apenas re-organização do endpoint tree. Os
 * endpoints legados em `/api/social/*` continuam funcionando pra
 * compatibilidade retroativa (nenhum breaking change).
 *
 * Endpoints:
 *   Autopilot (shadow-first, RN-CG-08/10):
 *     GET  /autopilot                         — plano hipotético
 *     POST /autopilot/mode                    — 'off' | 'shadow'
 *   Optimizations (governadas via DecisionAction):
 *     GET  /optimizations
 *     POST /optimizations/propose
 *     POST /optimizations/:actionId/execute
 *   Growth brief (F13, role-gated):
 *     GET  /brief
 *   Attribution (F7 conteúdo→lead, F8 lead→revenue):
 *     POST /attribution/lead
 *     GET  /attribution/leads?correlationId=...
 *     POST /attribution/revenue
 *     GET  /attribution/revenue?correlationId=...
 */
import { Router } from "express";
import { AuthRequest, requireRole } from "../middleware/auth.js";
import { GrowthAutopilotService } from "../GrowthAutopilotService.js";
import { GrowthOptimizationService } from "../GrowthOptimizationService.js";
import { SocialProactivityService } from "../SocialProactivityService.js";
import { ContentLeadAttributionService } from "../ContentLeadAttributionService.js";
import { ContentRevenueAttributionService } from "../ContentRevenueAttributionService.js";

const router = Router();

// ── Growth Autopilot (shadow-first) ──

router.get("/autopilot", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json(GrowthAutopilotService.plan(orgId));
});

router.post("/autopilot/mode", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(GrowthAutopilotService.setMode(orgId, String(req.body?.mode || ""))); }
  catch (e: any) { res.status(400).json({ error: e.message || "Modo inválido." }); }
});

// ── Growth Optimizations (governadas) ──

router.get("/optimizations", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json(GrowthOptimizationService.list(orgId));
});

router.post("/optimizations/propose", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    res.json(GrowthOptimizationService.propose(orgId, {
      kind: String(req.body?.kind || ""),
      ref: String(req.body?.ref || ""),
    }, (req as any).user?.userId || "growth_autopilot"));
  } catch (e: any) { res.status(400).json({ error: e.message || "Não foi possível propor a otimização." }); }
});

router.post("/optimizations/:actionId/execute", requireRole("owner", "admin"),
  async (req: AuthRequest, res): Promise<any> => {
    const orgId = req.organizationId;
    if (!orgId) return res.status(401).json({ error: "Unauthorized" });
    try { res.json(await GrowthOptimizationService.execute(orgId, String(req.params.actionId))); }
    catch (e: any) { res.status(400).json({ error: e.message || "Não foi possível executar a otimização." }); }
  });

// ── Growth Brief (F13, role-gated) ──

router.get("/brief", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json(SocialProactivityService.growthBrief(orgId));
});

// ── Content→Lead Attribution (F7) ──

router.post("/attribution/lead", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const out = ContentLeadAttributionService.attribute(orgId, {
      correlationId: String(req.body?.correlationId || ""),
      contactId: String(req.body?.contactId || ""),
      actionId: req.body?.actionId ? String(req.body.actionId) : null,
      source: req.body?.source ? String(req.body.source) : null,
    });
    res.json(out);
  } catch (e: any) { res.status(400).json({ error: e.message || "Falha ao atribuir o lead." }); }
});

router.get("/attribution/leads", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const correlationId = String(req.query?.correlationId || "").trim();
  if (!correlationId) return res.status(400).json({ error: "Informe o correlationId." });
  res.json({
    correlationId,
    leadCount: ContentLeadAttributionService.leadCount(orgId, correlationId),
    leads: ContentLeadAttributionService.leadsFor(orgId, correlationId),
  });
});

// ── Lead→Revenue Attribution (F8, dinheiro role-gated) ──

router.post("/attribution/revenue", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const correlationId = String(req.body?.correlationId || "").trim();
  if (!correlationId) return res.status(400).json({ error: "Informe o correlationId." });
  res.json(ContentRevenueAttributionService.attributeLeads(orgId, correlationId));
});

router.get("/attribution/revenue", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const correlationId = String(req.query?.correlationId || "").trim();
  if (!correlationId) return res.status(400).json({ error: "Informe o correlationId." });
  res.json(ContentRevenueAttributionService.revenueFor(orgId, correlationId));
});

export default router;
