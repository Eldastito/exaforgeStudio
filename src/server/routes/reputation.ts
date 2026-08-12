import { Router } from "express";
import { AuthRequest, requireRole } from "../middleware/auth.js";
import { ReputationConnectorService } from "../ReputationConnectorService.js";
import { ReputationIngestionService } from "../ReputationIngestionService.js";
import { logAuthEvent } from "../auditLog.js";

/**
 * Rotas do Customer Recovery & Reputation (ADR-162 / PRD 5 F2). Owner/admin.
 * Config do conector (credenciais CIFRADAS — nunca devolvidas cruas), status
 * redigido, e o passe de sincronização incremental (opt-in, gated por flags).
 * A rota valida FORMA; o service guarda invariante (gate/degradação).
 */
const router = Router();
const PROVIDERS = new Set(["reclame_aqui", "stub"]);

// GET /api/reputation/connector?provider=reclame_aqui — status REDIGIDO (sem token).
router.get("/connector", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const provider = typeof req.query?.provider === "string" ? req.query.provider : "reclame_aqui";
  if (!PROVIDERS.has(provider)) return res.status(400).json({ error: "provider inválido" });
  res.json({
    engineEnabled: ReputationIngestionService.engineEnabled(orgId),
    ...ReputationConnectorService.status(orgId, provider),
  });
});

// PUT /api/reputation/connector { provider, config, enabled? } — grava credenciais
// (cifradas). `config` deve trazer baseUrl+token pro conector real.
router.put("/connector", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const b = req.body || {};
  const provider = typeof b.provider === "string" ? b.provider : "reclame_aqui";
  if (!PROVIDERS.has(provider)) return res.status(400).json({ error: "provider inválido" });
  if (b.config != null && typeof b.config !== "object") return res.status(400).json({ error: "config inválido" });
  try {
    ReputationConnectorService.setConfig(orgId, provider, b.config || {}, { enabled: b.enabled == null ? undefined : !!b.enabled });
    logAuthEvent(orgId, (req as any).user?.userId || null, null, "REPUTATION_CONNECTOR_SET", { provider, enabled: !!b.enabled });
    res.json({ ok: true, ...ReputationConnectorService.status(orgId, provider) });
  } catch (e: any) { res.status(500).json({ error: String(e?.message || e) }); }
});

// POST /api/reputation/sync { provider? } — passe de ingestão incremental (§9/§70).
router.post("/sync", requireRole("owner", "admin"), async (req: AuthRequest, res): Promise<any> => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const provider = typeof (req.body || {}).provider === "string" ? req.body.provider : "reclame_aqui";
  if (!PROVIDERS.has(provider)) return res.status(400).json({ error: "provider inválido" });
  try {
    const result = await ReputationIngestionService.sync(orgId, { provider });
    logAuthEvent(orgId, (req as any).user?.userId || null, null, "REPUTATION_SYNC", { provider, ingested: result.ingested, deduped: result.deduped, degraded: !!result.degraded, reason: result.reason });
    res.json(result);
  } catch (e: any) { res.status(500).json({ error: String(e?.message || e) }); }
});

export default router;
