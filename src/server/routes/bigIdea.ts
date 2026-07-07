import { Router } from "express";
import { AuthRequest } from "../middleware/auth.js";
import { BigIdeaBarService } from "../BigIdeaBarService.js";

const router = Router();

// POST /api/big-idea/generate { panel_key, data }
// Devolve a Big Idea (do cache se hash bate, ou gera nova). Frontend chama
// depois de carregar os dados do painel.
router.post("/generate", async (req: AuthRequest, res): Promise<any> => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const { panel_key, data, force } = req.body || {};
    const key = String(panel_key || "").trim().slice(0, 60);
    if (!key) return res.status(400).json({ error: "panel_key obrigatório" });
    const idea = await BigIdeaBarService.get(orgId, key, data || {}, { force: !!force });
    if (!idea) {
      // Fallback: última já gerada, se houver — melhor "algo velho" do que nada.
      const last = BigIdeaBarService.latest(orgId, key);
      if (last) return res.json({ ...last, stale: true });
      return res.json(null);
    }
    res.json(idea);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// GET /api/big-idea/latest?panel_key=... — só o último cache, sem chamar LLM.
router.get("/latest", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const key = String(req.query.panel_key || "").trim().slice(0, 60);
  if (!key) return res.status(400).json({ error: "panel_key obrigatório" });
  res.json(BigIdeaBarService.latest(orgId, key));
});

export default router;
