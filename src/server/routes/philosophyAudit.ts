import { Router } from "express";
import { AuthRequest } from "../middleware/auth.js";
import { CeleryTestService } from "../CeleryTestService.js";
import { ManipulationRadarService, analyzeText } from "../ManipulationRadarService.js";
import { FundamentalsChecklistService } from "../FundamentalsChecklistService.js";
import { logAuthEvent } from "../auditLog.js";

const router = Router();

// ==== Celery Test ====
// POST /api/philosophy/celery { subject } — cria pergunta pro assunto
router.post("/celery", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const subject = String(req.body?.subject || "").trim();
  if (!subject) return res.status(400).json({ error: "subject obrigatório" });
  const test = CeleryTestService.create(orgId, subject);
  if (!test) return res.status(500).json({ error: "Falha ao criar teste" });
  res.json(test);
});

// PATCH /api/philosophy/celery/:id { answer, decision }
router.patch("/celery/:id", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  const userId = req.user?.userId;
  if (!orgId || !userId) return res.status(401).json({ error: "Unauthorized" });
  const decision = String(req.body?.decision || "");
  if (!["keeps", "drops", "needs_review"].includes(decision)) return res.status(400).json({ error: "decision inválida" });
  const answer = String(req.body?.answer || "");
  const updated = CeleryTestService.answer(orgId, req.params.id, { answer, decision: decision as any, handledBy: userId });
  if (!updated) return res.status(404).json({ error: "Teste não encontrado" });
  logAuthEvent(orgId, userId, req.params.id, "CELERY_ANSWERED", { decision });
  res.json(updated);
});

// GET /api/philosophy/celery — lista + métrica
router.get("/celery", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json({
    tests: CeleryTestService.list(orgId, { status: (req.query.status as any) || "all" }),
    metrics: CeleryTestService.metrics(orgId, 60),
    currentWeek: CeleryTestService.currentWeek(),
  });
});

// ==== Radar de Manipulação ====
// POST /api/philosophy/manipulation/scan { text, source?, ref? }
// Devolve { tactics, severity } SEMPRE (mesmo sem alerta). Se detectou, também
// cria alerta persistido.
router.post("/manipulation/scan", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const text = String(req.body?.text || "");
  if (!text.trim()) return res.status(400).json({ error: "text obrigatório" });
  const analysis = analyzeText(text);
  let alert = null;
  if (analysis.tactics.length > 0) {
    alert = ManipulationRadarService.scan({
      organizationId: orgId,
      text,
      source: req.body?.source,
      ref: req.body?.ref,
    });
  }
  res.json({ ...analysis, alert });
});

// GET /api/philosophy/manipulation
router.get("/manipulation", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json({
    alerts: ManipulationRadarService.list(orgId, { status: (req.query.status as any) || "open" }),
    metrics: ManipulationRadarService.metrics(orgId, 30),
  });
});

// PATCH /api/philosophy/manipulation/:id { status }
router.patch("/manipulation/:id", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  const userId = req.user?.userId;
  if (!orgId || !userId) return res.status(401).json({ error: "Unauthorized" });
  const status = String(req.body?.status || "");
  if (!["dismissed", "reformulated"].includes(status)) return res.status(400).json({ error: "status inválido" });
  const ok = ManipulationRadarService.updateStatus(orgId, req.params.id, status as any, { handledBy: userId });
  if (!ok) return res.status(404).json({ error: "Alerta não encontrado" });
  logAuthEvent(orgId, userId, req.params.id, "MANIPULATION_" + status.toUpperCase(), {});
  res.json({ success: true });
});

// ==== Checklist de Fundamentos ====
// POST /api/philosophy/fundamentals/run { campaignRef? } — roda o check agora
router.post("/fundamentals/run", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  const userId = req.user?.userId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const check = FundamentalsChecklistService.run(orgId, {
    campaignRef: req.body?.campaignRef,
    handledBy: userId,
  });
  if (!check) return res.status(500).json({ error: "Falha ao rodar checklist" });
  if (userId) logAuthEvent(orgId, userId, check.id, "FUNDAMENTALS_RUN", { status: check.status, score: check.score });
  res.json(check);
});

// GET /api/philosophy/fundamentals — lista + latest
router.get("/fundamentals", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json({
    history: FundamentalsChecklistService.list(orgId, { limit: 20 }),
    latest: FundamentalsChecklistService.latest(orgId),
  });
});

export default router;
