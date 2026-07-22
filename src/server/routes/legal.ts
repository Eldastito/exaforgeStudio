import { Router } from "express";
import { AuthRequest } from "../middleware/auth.js";
import { LegalAdvisorService } from "../LegalAdvisorService.js";

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

export default router;
