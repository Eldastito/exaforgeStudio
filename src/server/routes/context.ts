import { Router } from "express";
import { AuthRequest } from "../middleware/auth.js";
import { ContextEngineService } from "../ContextEngineService.js";
import type { ContextRequest } from "../contextModel.js";

/**
 * Context Engine — leituras do Business Context Engine (PRD 3). Hoje expõe a
 * QUALIDADE do contexto (F8, §75/§34): cobertura por-fonte + confiança + frescor +
 * conflitos detalhados + proveniência agregada. READ+DERIVE — não executa nada.
 * Leitura pra qualquer papel autenticado (o pacote cru por papel é da F9).
 */
const router = Router();

// GET /api/context/quality?intent=&focus=&domains=a,b&profile= — o relatório rico
// de qualidade do contexto pra um intent/escopo.
router.get("/quality", async (req: AuthRequest, res): Promise<any> => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const q = req.query || {};
  const request: ContextRequest = {
    intent: typeof q.intent === "string" && q.intent.trim() ? q.intent.trim() : "context_quality",
    focus: typeof q.focus === "string" ? q.focus : null,
    profile: q.profile === "minimal" || q.profile === "deep" ? q.profile : undefined,
    domains: typeof q.domains === "string" && q.domains.trim() ? q.domains.split(",").map((s) => s.trim()).filter(Boolean) : null,
  };
  try {
    res.json(await ContextEngineService.quality(orgId, request));
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

export default router;
