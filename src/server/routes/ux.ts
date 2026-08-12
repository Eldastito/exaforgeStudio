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
import { InferredSettingsService } from "../InferredSettingsService.js";
import { ContextualUpgradeService } from "../ContextualUpgradeService.js";
import { ZeroTrainingHelpService } from "../ZeroTrainingHelpService.js";
import { UxTelemetryService } from "../UxTelemetryService.js";

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

// GET /api/ux/inferred-settings — sugestões de política inferidas (só gestor).
router.get("/inferred-settings", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId || !req.user) return res.status(401).json({ error: "Unauthorized" });
  res.json(InferredSettingsService.suggestions(orgId, req.user));
});

// POST /api/ux/inferred-settings/apply { domain, actionType, bands } — confirma e grava.
// RN-UX-3: aplicar política material exige gestor + confirmação explícita (nunca inferência sozinha).
router.post("/inferred-settings/apply", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId || !req.user) return res.status(401).json({ error: "Unauthorized" });
  if (!["owner", "admin"].includes(req.user?.role)) return res.status(403).json({ error: "Apenas gestores podem definir política de aprovação." });
  const b = req.body || {};
  const r = InferredSettingsService.apply(orgId, actor(req), { domain: b.domain, actionType: b.actionType, bands: b.bands });
  res.status(r.applied ? 200 : 400).json(r);
});

// GET /api/ux/contextual-upgrades — upgrades SITUACIONAIS (recomendação ∩ fora-do-plano).
// Vazio quando não há gatilho — é o comportamento correto (§56, sem catálogo de cadeados).
// Aceitar/dispensar seguem em /api/billing/recommendations (reuso, sem duplicar).
router.get("/contextual-upgrades", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId || !req.user) return res.status(401).json({ error: "Unauthorized" });
  res.json(ContextualUpgradeService.forUser(orgId, req.user));
});

// POST /api/ux/help { text } — ajuda zero-training do Fala Tu (ensine/mostre/faça/onde).
// Camada determinística (§91-92); é o Fala Tu respondendo, não assistente paralelo (RN-UX-1).
router.post("/help", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId || !req.user) return res.status(401).json({ error: "Unauthorized" });
  res.json(ZeroTrainingHelpService.answer(orgId, req.user, { text: String(req.body?.text || "") }));
});

// POST /api/ux/telemetry { eventType, surface?, moduleKey?, sessionId?, ttfvMs? }
// Registra evento de UX minimizado (LGPD §84). No-op sem a flag opt-in; nunca conteúdo.
router.post("/telemetry", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId || !req.user) return res.status(401).json({ error: "Unauthorized" });
  const b = req.body || {};
  res.json(UxTelemetryService.record(orgId, req.user, { eventType: b.eventType, surface: b.surface, moduleKey: b.moduleKey, sessionId: b.sessionId, ttfvMs: b.ttfvMs }));
});

// GET /api/ux/telemetry/summary?days=30 — agregados de UX (só gestor, nunca conteúdo).
router.get("/telemetry/summary", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId || !req.user) return res.status(401).json({ error: "Unauthorized" });
  const days = typeof req.query?.days === "string" ? Number(req.query.days) : undefined;
  const r = UxTelemetryService.summary(orgId, req.user, { sinceDays: days });
  if ((r as any).restricted) return res.status(403).json({ error: "Resumo de telemetria é restrito a gestores." });
  res.json(r);
});

export default router;
