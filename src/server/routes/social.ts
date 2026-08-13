import { Router } from "express";
import { AuthRequest, requireRole } from "../middleware/auth.js";
import { SocialConnectionService } from "../SocialConnectionService.js";
import { SocialAnalyticsService } from "../SocialAnalyticsService.js";
import { VerticalSocialIntelligenceService } from "../VerticalSocialIntelligenceService.js";
import { OpportunityMatchingService } from "../OpportunityMatchingService.js";
import { logAuthEvent } from "../auditLog.js";

/**
 * Rotas do Social Connection Hub (PRD 10 / ADR-167 F2). ESTENDE Canais e IA com o
 * estado por-org das conexões de CANAL SOCIAL. Owner/admin (config = credencial).
 *
 * SEGREDOS (RN-SI-05): a config gravada é CIFRADA no service; o status devolvido é
 * REDIGIDO — nunca o token cru, só `hasToken`/escopos/capacidades/estado. A rota valida
 * FORMA; o service guarda invariante (cifra, degradação, estado observável §5). NÃO há
 * segunda tela de credenciais no frontend nem integração frontend→API social (§42): estas
 * rotas são o backend que a superfície de Canais e IA consome.
 */
const router = Router();

// GET /api/social/connections — lista REDIGIDA das conexões da org.
router.get("/connections", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json({ connections: SocialConnectionService.list(orgId) });
});

// GET /api/social/connections/:channel — status REDIGIDO de um canal.
router.get("/connections/:channel", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const channel = String(req.params.channel || "");
  if (!SocialConnectionService.isKnownChannel(channel)) return res.status(400).json({ error: "canal inválido" });
  res.json(SocialConnectionService.status(orgId, channel));
});

// PUT /api/social/connections/:channel { config, provider?, enabled?, scopes? } —
// grava credenciais (CIFRADAS no service). `config` traz o token/escopos do canal.
router.put("/connections/:channel", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const channel = String(req.params.channel || "");
  if (!SocialConnectionService.isKnownChannel(channel)) return res.status(400).json({ error: "canal inválido" });
  const b = req.body || {};
  if (b.config != null && typeof b.config !== "object") return res.status(400).json({ error: "config inválido" });
  if (b.scopes != null && !Array.isArray(b.scopes)) return res.status(400).json({ error: "scopes inválido" });
  try {
    SocialConnectionService.setConfig(orgId, channel, b.config || {}, {
      provider: typeof b.provider === "string" ? b.provider : undefined,
      enabled: b.enabled == null ? undefined : !!b.enabled,
      scopes: Array.isArray(b.scopes) ? b.scopes.map(String) : undefined,
    });
    logAuthEvent(orgId, (req as any).user?.userId || null, null, "SOCIAL_CONNECTION_SET", { channel, enabled: !!b.enabled });
    res.json({ ok: true, ...SocialConnectionService.status(orgId, channel) });
  } catch (e: any) { res.status(500).json({ error: String(e?.message || e) }); }
});

// POST /api/social/connections/:channel/health — passe de saúde: conecta, lê health,
// PERSISTE estado observável (§5) + capacidades DESCOBERTAS (RN-SI-06). Redigido.
router.post("/connections/:channel/health", requireRole("owner", "admin"), async (req: AuthRequest, res): Promise<any> => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const channel = String(req.params.channel || "");
  if (!SocialConnectionService.isKnownChannel(channel)) return res.status(400).json({ error: "canal inválido" });
  try {
    const status = await SocialConnectionService.refreshHealth(orgId, channel);
    res.json(status);
  } catch (e: any) { res.status(500).json({ error: String(e?.message || e) }); }
});

// DELETE /api/social/connections/:channel — desconecta (zera credencial, not_connected).
router.delete("/connections/:channel", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const channel = String(req.params.channel || "");
  if (!SocialConnectionService.isKnownChannel(channel)) return res.status(400).json({ error: "canal inválido" });
  try {
    SocialConnectionService.disconnect(orgId, channel);
    logAuthEvent(orgId, (req as any).user?.userId || null, null, "SOCIAL_CONNECTION_DISCONNECTED", { channel });
    res.json({ ok: true, ...SocialConnectionService.status(orgId, channel) });
  } catch (e: any) { res.status(500).json({ error: String(e?.message || e) }); }
});

// POST /api/social/analytics/:channel/sync — puxa posts+analytics próprios do provider
// e persiste (idempotente). Owner/admin. Best-effort/honesto (degrada sem capacidade).
router.post("/analytics/:channel/sync", requireRole("owner", "admin"), async (req: AuthRequest, res): Promise<any> => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const channel = String(req.params.channel || "");
  if (!SocialConnectionService.isKnownChannel(channel)) return res.status(400).json({ error: "canal inválido" });
  const b = req.body || {};
  const limit = Number.isFinite(b.limit) ? Math.max(1, Math.min(50, Number(b.limit))) : undefined;
  try {
    const result = await SocialAnalyticsService.sync(orgId, channel, { limit });
    logAuthEvent(orgId, (req as any).user?.userId || null, null, "SOCIAL_ANALYTICS_SYNC", { channel, synced: result.synced, withAnalytics: result.withAnalytics, degraded: !!result.degraded });
    res.json(result);
  } catch (e: any) { res.status(500).json({ error: String(e?.message || e) }); }
});

// GET /api/social/analytics/:channel — posts persistidos + resumo agregado (por-org).
router.get("/analytics/:channel", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const channel = String(req.params.channel || "");
  if (!SocialConnectionService.isKnownChannel(channel)) return res.status(400).json({ error: "canal inválido" });
  const limit = typeof req.query?.limit === "string" ? parseInt(req.query.limit, 10) : undefined;
  res.json({
    summary: SocialAnalyticsService.summary(orgId, channel),
    posts: SocialAnalyticsService.list(orgId, channel, { limit }),
  });
});

// GET /api/social/vertical-intelligence?vertical=&channel=&topics=a,b — consolida a
// inteligência social do nicho (externo compartilhado + próprio da F4). Read-only.
router.get("/vertical-intelligence", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const vertical = typeof req.query?.vertical === "string" ? req.query.vertical : "";
  if (!vertical) return res.status(400).json({ error: "vertical é obrigatório" });
  const channel = typeof req.query?.channel === "string" ? req.query.channel : undefined;
  const topics = typeof req.query?.topics === "string" ? req.query.topics.split(",").map((t) => t.trim()).filter(Boolean) : undefined;
  const region = typeof req.query?.region === "string" ? req.query.region : undefined;
  const timeframe = typeof req.query?.timeframe === "string" ? req.query.timeframe : undefined;
  try {
    res.json(VerticalSocialIntelligenceService.assemble(orgId, { vertical, channel, topics, region, timeframe }));
  } catch (e: any) { res.status(400).json({ error: String(e?.message || e) }); }
});

// POST /api/social/opportunities/match { vertical?, channel?, publish? } — cruza a
// inteligência do nicho com o momento da org; `publish` grava as oportunidades frescas
// em `business_signals` (espinha canônica). `publish` default true. Owner/admin.
router.post("/opportunities/match", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const b = req.body || {};
  const publish = b.publish === undefined ? true : !!b.publish;
  try {
    const out = OpportunityMatchingService.match(orgId, {
      vertical: typeof b.vertical === "string" ? b.vertical : undefined,
      channel: typeof b.channel === "string" ? b.channel : undefined,
      publish,
    });
    if (publish && out.matched > 0) logAuthEvent(orgId, (req as any).user?.userId || null, null, "SOCIAL_OPPORTUNITY_MATCH", { vertical: out.vertical, channel: out.channel, matched: out.matched });
    res.json(out);
  } catch (e: any) { res.status(400).json({ error: String(e?.message || e) }); }
});

export default router;
