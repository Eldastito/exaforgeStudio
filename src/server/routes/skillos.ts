import { Router } from "express";
import { AuthRequest, requireRole } from "../middleware/auth.js";
import { SkillOsRegistryService } from "../SkillOsRegistryService.js";
import { SkillOsResolverService } from "../SkillOsResolverService.js";
import { SkillOsModelRouterService } from "../SkillOsModelRouterService.js";
import { SkillOsProviderHealthService } from "../SkillOsProviderHealthService.js";
import { SkillOsPlannerService } from "../SkillOsPlannerService.js";
import { SkillOsEvalService } from "../SkillOsEvalService.js";
import { SkillOsRolloutService } from "../SkillOsRolloutService.js";
import { SkillOsPilotSeeder } from "../SkillOsPilotSeeder.js";

/**
 * SkillOS — leitura do CATÁLOGO de Capabilities/Skills (PRD 4 F2). Só lookup nesta
 * fase (registro/seleção/execução são fases seguintes). Leitura pra gestor
 * (owner/admin) — o catálogo é de plataforma, não expõe dado de tenant. Inerte até
 * o catálogo ter conteúdo.
 */
const router = Router();

// GET /api/skillos/capabilities?status=&category=&vertical=
router.get("/capabilities", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const q = req.query || {};
  res.json({ capabilities: SkillOsRegistryService.listCapabilities({ status: q.status as any, category: q.category as any, vertical: q.vertical as any }) });
});

// GET /api/skillos/capabilities/:id — uma Capability + as Skills que a atendem.
router.get("/capabilities/:id", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const cap = SkillOsRegistryService.getCapability(req.params.id);
  if (!cap) return res.status(404).json({ error: "Capability não encontrada." });
  res.json({ capability: cap, skills: SkillOsRegistryService.skillsForCapability(cap.capabilityId, { vertical: req.query.vertical as any, includeInactive: true }) });
});

// GET /api/skillos/skills?capabilityId=&status=&vertical=
router.get("/skills", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const q = req.query || {};
  res.json({ skills: SkillOsRegistryService.listSkills({ capabilityId: q.capabilityId as any, status: q.status as any, vertical: q.vertical as any }) });
});

// POST /api/skillos/resolve { capabilityId, vertical?, maxRisk? } — qual Skill o
// Resolver escolheria (F3). Inspeção/explicabilidade; NÃO executa. Gestor.
router.post("/resolve", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const b = req.body || {};
  res.json(SkillOsResolverService.resolve(orgId, req.user, { capabilityId: b.capabilityId, vertical: b.vertical, maxRisk: b.maxRisk, requirePermissions: !!b.requirePermissions }));
});

// GET /api/skillos/models?provider=&status= — catálogo de modelos (F5).
router.get("/models", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const q = req.query || {};
  res.json({ models: SkillOsModelRouterService.listModels({ provider: q.provider as any, status: q.status as any }) });
});

// POST /api/skillos/route { needs:[], prefer?, minContextTokens? } — qual MODELO o
// Router escolheria (F5). Inspeção; NÃO invoca. Gestor.
router.post("/route", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const b = req.body || {};
  res.json(SkillOsModelRouterService.route({ needs: Array.isArray(b.needs) ? b.needs : [], prefer: b.prefer, minContextTokens: b.minContextTokens, maxLatencyMsTarget: b.maxLatencyMsTarget, riskLevel: b.riskLevel }, { orgId }));
});

// GET /api/skillos/provider-health/:provider?model= — estado do circuit breaker
// (F5, derivado). Contagens/taxas — sem custo financeiro (§30). Gestor.
router.get("/provider-health/:provider", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json(SkillOsProviderHealthService.stats(req.params.provider, { model: req.query.model as any }));
});

// POST /api/skillos/plan { goal, steps:[{capabilityId, dependsOn?}], vertical? } — o
// Planner monta o ExecutionPlan (F7). PLANEJA, não executa. Gestor.
router.post("/plan", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const b = req.body || {};
  try {
    res.json(SkillOsPlannerService.plan(orgId, req.user, { goal: b.goal, intent: b.intent, vertical: b.vertical, correlationId: b.correlationId, maxRisk: b.maxRisk, steps: Array.isArray(b.steps) ? b.steps : [] }));
  } catch (e: any) {
    res.status(400).json({ error: String(e?.message || e) });
  }
});

// GET /api/skillos/eval-cases/:skillId — casos de eval da skill (F11). Config de
// PLATAFORMA (skill global) — leitura pra gestor/admin. §30-safe (não carrega custo).
router.get("/eval-cases/:skillId", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json({ cases: SkillOsEvalService.listCases(req.params.skillId, { includeDisabled: req.query.includeDisabled === "1" }) });
});

// GET /api/skillos/evals/:skillId — último run de eval + flag de regressão (F11).
router.get("/evals/:skillId", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const last = SkillOsEvalService.lastRun(req.params.skillId, "eval");
  if (!last) return res.status(404).json({ error: "Nenhum run de eval pra essa skill." });
  res.json({
    skillId: last.skill_id, promptVersion: last.prompt_version, total: last.total,
    passed: last.passed, failed: last.failed, passRate: last.pass_rate,
    regressed: !!last.regressed, at: last.created_at,
  });
});

// ── Rollout / Canary / Kill switch / Readiness (PRD 4 F12) — controle de PLATAFORMA
// (owner/admin). Reusa o teto `execution_mode` da ADR-159; o gate de execução real
// segue no CommandExecutor. ─────────────────────────────────────────────────────

// GET /api/skillos/rollout/:skillId — estágio + canário + kill + decisão pra esta org.
router.get("/rollout/:skillId", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json({ state: SkillOsRolloutService.get(req.params.skillId), decisionForOrg: SkillOsRolloutService.isLiveForOrg(req.params.skillId, orgId), globalKill: SkillOsRolloutService.isGloballyKilled() });
});

// POST /api/skillos/rollout/:skillId { stage?, canaryPercent? } — avança/ajusta.
router.post("/rollout/:skillId", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const b = req.body || {};
  try {
    if (b.stage != null) SkillOsRolloutService.setStage(req.params.skillId, b.stage);
    if (b.canaryPercent != null) SkillOsRolloutService.setCanaryPercent(req.params.skillId, Number(b.canaryPercent));
    res.json({ state: SkillOsRolloutService.get(req.params.skillId) });
  } catch (e: any) { res.status(400).json({ error: String(e?.message || e) }); }
});

// POST /api/skillos/rollout/:skillId/rollback — desce um degrau (§69).
router.post("/rollout/:skillId/rollback", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  if (!req.organizationId) return res.status(401).json({ error: "Unauthorized" });
  res.json({ state: SkillOsRolloutService.stepDown(req.params.skillId) });
});

// POST /api/skillos/rollout/:skillId/kill { on } — kill switch por-skill.
router.post("/rollout/:skillId/kill", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  if (!req.organizationId) return res.status(401).json({ error: "Unauthorized" });
  const on = req.body?.on !== false; // default true
  res.json({ state: on ? SkillOsRolloutService.kill(req.params.skillId) : SkillOsRolloutService.revive(req.params.skillId) });
});

// POST /api/skillos/kill-switch { on } — kill switch de PLATAFORMA (§69: desliga tudo).
router.post("/kill-switch", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  if (!req.organizationId) return res.status(401).json({ error: "Unauthorized" });
  const on = req.body?.on !== false; // default true
  res.json(on ? SkillOsRolloutService.killAll() : SkillOsRolloutService.reviveAll());
});

// GET /api/skillos/readiness — prontidão operacional do SkillOS (§30-safe).
router.get("/readiness", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  if (!req.organizationId) return res.status(401).json({ error: "Unauthorized" });
  res.json(SkillOsRolloutService.readiness());
});

// POST /api/skillos/seed-pilots — onboarding idempotente dos 3 pilotos §61 (Capability+
// Skill+evals, estágio `shadow`, SEM efeito). Também roda no boot; a rota é o gatilho
// manual do operador (owner/admin).
router.post("/seed-pilots", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  if (!req.organizationId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(SkillOsPilotSeeder.seedPilots()); }
  catch (e: any) { res.status(500).json({ error: String(e?.message || e) }); }
});

// POST /api/skillos/promote-pilots { percent? } — promoção §68 dos 3 pilotos `shadow`→
// `pilot` @percent% (default 10). Aplica a DECISÃO do operador; one-time (marker), não
// re-dispara nem briga com rollback. Também roda no boot; a rota é o gatilho manual.
router.post("/promote-pilots", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  if (!req.organizationId) return res.status(401).json({ error: "Unauthorized" });
  const raw = (req.body || {}).percent;
  const percent = raw == null ? 10 : Number(raw);
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) return res.status(400).json({ error: "percent inválido (0..100)" });
  try { res.json(SkillOsPilotSeeder.promotePilotsToPilot(percent)); }
  catch (e: any) { res.status(500).json({ error: String(e?.message || e) }); }
});

export default router;
