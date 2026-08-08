import { Router } from "express";
import { AuthRequest } from "../middleware/auth.js";
import { EvidencePackageService } from "../EvidencePackageService.js";
import { ImpactPrioritizationService } from "../ImpactPrioritizationService.js";
import { DecisionEngine } from "../DecisionEngine.js";
import { DecisionRiskService } from "../DecisionRiskService.js";

/**
 * Decision Intelligence — rotas de leitura (DI-1, aditivo sobre ADR-135/136).
 * Sem UI/menu novo: expõe o Evidence Package v1 e o Pareto já com níveis L0–L4
 * para os consumidores existentes (Diretor IA / Cockpit) e para a DI-2.
 */
const router = Router();

// GET /api/decision-intelligence/evidence?subject=&period=&force=1
// Pacote de evidências reutilizável (interno). Cacheado se a org opta pelo flag.
router.get("/evidence", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const subject = typeof req.query?.subject === "string" ? req.query.subject : undefined;
  const period = typeof req.query?.period === "string" ? req.query.period : undefined;
  const force = req.query?.force === "1" || req.query?.force === "true";
  res.json({ evidence: EvidencePackageService.build(orgId, { subject, period, force }) });
});

// GET /api/decision-intelligence/priorities — Pareto de sinais abertos já com
// impactLevel (L0–L4) + perfil de análise recomendado por prioridade.
router.get("/priorities", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json(ImpactPrioritizationService.prioritize(orgId));
});

// POST /api/decision-intelligence/analyze — roda as estratégias (premortem/
// red_team/advocate) sobre a decisão. Body: { title, decisionType, impactAmount,
// impactUnit, severity?, expectedValue?, premises?, decisionId?, mode?, persist? }.
router.post("/analyze", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const b = req.body || {};
  if (!b.title || typeof b.title !== "string") return res.status(400).json({ error: "title é obrigatório." });
  const out = DecisionEngine.analyze(orgId, {
    title: b.title,
    decisionType: b.decisionType,
    impactAmount: b.impactAmount ?? null,
    impactUnit: b.impactUnit ?? null,
    severity: b.severity,
    expectedValue: b.expectedValue ?? null,
    premises: Array.isArray(b.premises) ? b.premises : undefined,
    decisionId: b.decisionId ?? null,
  }, { mode: typeof b.mode === "string" ? b.mode : undefined, persist: b.persist === true });
  res.json(out);
});

// GET /api/decision-intelligence/risks?decisionId=&status= — riscos previstos.
router.get("/risks", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const decisionId = typeof req.query?.decisionId === "string" ? req.query.decisionId : undefined;
  const status = typeof req.query?.status === "string" ? req.query.status : undefined;
  res.json({ risks: DecisionRiskService.list(orgId, { decisionId, status }) });
});

// POST /api/decision-intelligence/risks/:id/resolve — o risco deixou de valer.
router.post("/risks/:id/resolve", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const out = DecisionRiskService.resolve(orgId, req.params.id);
  if (!out.ok) return res.status(404).json({ error: "Risco não encontrado ou já resolvido." });
  res.json(out);
});

export default router;
