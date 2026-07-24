import { Router } from "express";
import { AuthRequest } from "../middleware/auth.js";
import { ExecutiveAdvisorService } from "../ExecutiveAdvisorService.js";

const router = Router();

// GET /api/executive/briefing — briefing do dia (dados reais).
router.get("/briefing", async (req: AuthRequest, res): Promise<any> => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    res.json({ text: await ExecutiveAdvisorService.briefing(orgId) });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// GET /api/executive/effectiveness — "o que costuma funcionar": eficácia aprendida
// por tipo de ação (todos os domínios), ranqueada. Só leitura, determinística.
router.get("/effectiveness", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json({ items: ExecutiveAdvisorService.learnedEffectiveness(orgId) });
});

// POST /api/executive/ask — pergunta livre do gestor ao Diretor IA.
router.post("/ask", async (req: AuthRequest, res): Promise<any> => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    res.json({ text: await ExecutiveAdvisorService.ask(orgId, req.body?.question) });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;
