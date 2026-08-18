import { Router } from "express";
import { AuthRequest, requireMasterAdmin } from "../middleware/auth.js";
import { LegalAdvisorService } from "../LegalAdvisorService.js";
import { LaborLawAdvisorService } from "../LaborLawAdvisorService.js";

// Consultora Jurídica (ADR-115) — orientação ancorada no CDC. Rota core (não é
// módulo opcional): capacidade GLOBAL, disponível em todas as verticais.
const router = Router();

// GET /api/legal — metadados da base + perguntas sugeridas + situações (para a UI).
router.get("/", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json({
    base: LegalAdvisorService.baseInfo(),
    topics: LegalAdvisorService.suggestedTopics(),
    situations: LegalAdvisorService.situations(),
  });
});

// GET /api/legal/situation/:key — dica proativa ancorada no CDC para um momento
// do negócio (cobrança de fiado, devolução/troca, arrependimento, negativação).
router.get("/situation/:key", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const tip = LegalAdvisorService.forSituation(String(req.params.key), orgId, req.user?.userId);
  if (!tip) return res.status(404).json({ error: "situation_not_found" });
  res.json(tip);
});

// GET /api/legal/history — consultas por tema (o que o lojista mais consultou).
router.get("/history", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json(LegalAdvisorService.history(orgId));
});

// POST /api/legal/ask — pergunta do lojista → orientação + artigos + disclaimer.
router.post("/ask", async (req: AuthRequest, res): Promise<any> => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const question = String(req.body?.question || "").trim();
  if (question.length < 3) return res.status(400).json({ error: "Faça uma pergunta." });
  try {
    const answer = await LegalAdvisorService.ask(orgId, question, req.body?.context, req.user?.userId);
    res.json(answer);
  } catch (e) {
    console.error("[legal] falha na consulta:", e);
    res.status(500).json({ error: "Não consegui responder agora. Tente novamente." });
  }
});

// ---- Trabalhista (ADR-178) — scaffold honesto, gated em curadoria jurídica ----

// GET /api/legal/labor/status — taxonomia + estado da base (aguardando curadoria?).
router.get("/labor/status", (req: AuthRequest, res): any => {
  if (!req.organizationId) return res.status(401).json({ error: "Unauthorized" });
  res.json(LaborLawAdvisorService.status());
});

// GET /api/legal/labor/advise?q= — orientação GROUNDED na base curada; base
// vazia/sem match → "aguardando validação jurídica" (nunca inventa CLT).
router.get("/labor/advise", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const q = String(req.query?.q || "").trim();
  res.json(LaborLawAdvisorService.advise(q, { orgId, actorId: req.user?.userId }));
});

// GET /api/legal/labor/entries — lista as entradas curadas (painel master).
router.get("/labor/entries", requireMasterAdmin, (_req: AuthRequest, res): any => {
  res.json({ entries: LaborLawAdvisorService.list() });
});

// POST /api/legal/labor/curate — publica entrada CURADA (master-only; exige
// reviewedBy — o jurista que revisou). Curadoria de plataforma (RN-178-004).
router.post("/labor/curate", requireMasterAdmin, (req: AuthRequest, res): any => {
  try {
    res.json(LaborLawAdvisorService.curate(req.body || {}, req.user?.userId));
  } catch (e: any) {
    res.status(400).json({ error: e?.message || "erro" });
  }
});

// POST /api/legal/labor/entries/:id/archive — arquiva uma entrada (master-only).
router.post("/labor/entries/:id/archive", requireMasterAdmin, (req: AuthRequest, res): any => {
  res.json(LaborLawAdvisorService.archive(String(req.params.id), req.user?.userId));
});

export default router;
