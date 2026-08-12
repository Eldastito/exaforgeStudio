import { Router } from "express";
import { AuthRequest, requireRole } from "../middleware/auth.js";
import { ReputationConnectorService } from "../ReputationConnectorService.js";
import { ReputationIngestionService } from "../ReputationIngestionService.js";
import { ReputationCaseService } from "../ReputationCaseService.js";
import { ReputationClassificationService } from "../ReputationClassificationService.js";
import { CustomerContextService } from "../CustomerContextService.js";
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

// POST /api/reputation/cases/:signalId/resolve { hints? } — resolve identidade +
// contexto de um caso de reputação (§11-§14). `hints` = override do operador
// (contactId/orderRef/phone/email). Re-sujeita em match único; sempre cerca o
// conteúdo (untrusted_external_data). NÃO age (F3 é só percepção).
router.post("/cases/:signalId/resolve", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const hints = (req.body || {}).hints || {};
  if (typeof hints !== "object") return res.status(400).json({ error: "hints inválido" });
  const out = ReputationCaseService.resolveCase(orgId, req.params.signalId, hints);
  if (!out) return res.status(404).json({ error: "caso de reputação não encontrado" });
  logAuthEvent(orgId, (req as any).user?.userId || null, out.identity.contactId || null, "REPUTATION_CASE_RESOLVE", {
    signalId: out.signalId, identityStatus: out.identity.status, matchedBy: out.identity.matchedBy, reSubjected: out.reSubjected, escalate: out.escalate, suspicious: out.fenced.suspicious,
  });
  res.json(out);
});

// POST /api/reputation/cases/:signalId/classify — classificação determinística
// (§15-18): taxonomia + severidade + high-risk gates. PERSISTE upgrade monotônico de
// severidade (nunca rebaixa). Sem IA (reprodutível). NÃO age (F4 é percepção).
router.post("/cases/:signalId/classify", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const out = ReputationClassificationService.classifySignal(orgId, req.params.signalId);
  if (!out) return res.status(404).json({ error: "caso de reputação não encontrado" });
  logAuthEvent(orgId, (req as any).user?.userId || null, null, "REPUTATION_CASE_CLASSIFY", {
    signalId: out.signalId, category: out.classification.category, severityLevel: out.classification.severityLevel,
    highRisk: out.classification.highRisk, severityUpgraded: out.severityUpgraded, from: out.from, to: out.to,
  });
  res.json(out);
});

// GET /api/reputation/customer/:contactId/context — customer-360 (§13). Owner/admin;
// a projeção RBAC+purpose (§73) é aplicada a jusante quando entregue a um agente.
router.get("/customer/:contactId/context", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const ctx = CustomerContextService.build(orgId, req.params.contactId);
  if (!ctx) return res.status(404).json({ error: "contato não encontrado" });
  res.json(ctx);
});

export default router;
