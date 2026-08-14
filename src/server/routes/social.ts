import { Router } from "express";
import { AuthRequest, requireRole } from "../middleware/auth.js";
import { SocialConnectionService } from "../SocialConnectionService.js";
import { SocialAnalyticsService } from "../SocialAnalyticsService.js";
import { VerticalSocialIntelligenceService } from "../VerticalSocialIntelligenceService.js";
import { OpportunityMatchingService } from "../OpportunityMatchingService.js";
import { StudioBriefService } from "../StudioBriefService.js";
import { CreativeVariantService } from "../CreativeVariantService.js";
import { EditorialCalendarService } from "../EditorialCalendarService.js";
import { GovernedPublishService } from "../GovernedPublishService.js";
import { SocialAttributionService } from "../SocialAttributionService.js";
import { CreativeLearningService } from "../CreativeLearningService.js";
import { SocialProactivityService } from "../SocialProactivityService.js";
import { SocialEntitlementService } from "../SocialEntitlementService.js";
import { CreativeExperimentService } from "../CreativeExperimentService.js";
import { ContentLeadAttributionService } from "../ContentLeadAttributionService.js";
import { ContentRevenueAttributionService } from "../ContentRevenueAttributionService.js";
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

// GET /api/social/studio/opportunities — oportunidades de conteúdo abertas (candidatas
// a virar briefing orientado no Estúdio). Read-only. Owner/admin.
router.get("/studio/opportunities", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json({ opportunities: StudioBriefService.listOpportunities(orgId) });
});

// GET /api/social/studio/brief/:signalId — briefing orientado derivado de UMA
// oportunidade (nicho/tópico/ângulo/formato/procedência + texto pronto p/ o Estúdio).
router.get("/studio/brief/:signalId", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const brief = StudioBriefService.fromOpportunity(orgId, String(req.params.signalId || ""));
  if (!brief) return res.status(404).json({ error: "oportunidade não encontrada" });
  res.json(brief);
});

// GET /api/social/studio/variants/:signalId — variantes criativas A/B/C derivadas do
// briefing orientado (cada uma pronta p/ StudioService.generate). Read-only.
router.get("/studio/variants/:signalId", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const set = CreativeVariantService.variants(orgId, String(req.params.signalId || ""));
  if (!set) return res.status(404).json({ error: "oportunidade não encontrada" });
  res.json(set);
});

// GET /api/social/studio/calendar — calendário editorial (todos os estágios).
router.get("/studio/calendar", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json({ entries: EditorialCalendarService.calendar(orgId) });
});

// POST /api/social/studio/calendar — cria um RASCUNHO no calendário (não publica).
router.post("/studio/calendar", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const b = req.body || {};
  try {
    const out = EditorialCalendarService.draft(orgId, {
      creationId: b.creationId, channel: b.channel, objective: b.objective, caption: b.caption,
      scheduledAt: b.scheduledAt, variantKey: b.variantKey, correlationId: b.correlationId,
    });
    logAuthEvent(orgId, (req as any).user?.userId || null, out.id, "SOCIAL_CALENDAR_DRAFT", { channel: b.channel || null });
    res.json(out);
  } catch (e: any) { res.status(400).json({ error: String(e?.message || e) }); }
});

// POST /api/social/studio/calendar/:id/approve { scheduledAt } — draft→scheduled.
router.post("/studio/calendar/:id/approve", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const scheduledAt = (req.body || {}).scheduledAt;
  if (!scheduledAt) return res.status(400).json({ error: "scheduledAt é obrigatório" });
  try {
    EditorialCalendarService.approve(orgId, String(req.params.id), { scheduledAt });
    logAuthEvent(orgId, (req as any).user?.userId || null, req.params.id, "SOCIAL_CALENDAR_APPROVE", { scheduledAt });
    res.json({ ok: true });
  } catch (e: any) { res.status(400).json({ error: String(e?.message || e) }); }
});

// DELETE /api/social/studio/calendar/:id — cancela (rascunho ou agendada).
router.delete("/studio/calendar/:id", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const ok = EditorialCalendarService.cancel(orgId, String(req.params.id));
  if (!ok) return res.status(404).json({ error: "entrada não encontrada ou não cancelável" });
  res.json({ ok: true });
});

// GET /api/social/studio/best-time?channel= — melhor horário derivado do desempenho próprio.
router.get("/studio/best-time", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const channel = typeof req.query?.channel === "string" ? req.query.channel : "instagram";
  res.json(EditorialCalendarService.bestTime(orgId, channel));
});

// POST /api/social/publish { channel, caption?, mediaRef?, kind?, variantKey?, signalId?,
// correlationId? } — PROPÕE a publicação como comando GOVERNADO (não publica direto).
// A ação nasce aguardando aprovação (default) ou aprovada (Autonomy Contract). Owner/admin.
router.post("/publish", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const b = req.body || {};
  if (!b.channel) return res.status(400).json({ error: "channel é obrigatório" });
  // GATE de plano SERVER-SIDE (RN-SI-14): recusa a publicação ANTES de propor se o plano
  // não cobre — um cliente que pule a UI é barrado igual. 402 + caminho de upgrade.
  try { SocialEntitlementService.assertAllowed(orgId, req.user, "execute"); }
  catch (e: any) {
    if (e?.code === "entitlement_denied") return res.status(402).json({ error: e.message, entitlement: e.decision });
    return res.status(400).json({ error: String(e?.message || e) });
  }
  try {
    const action = GovernedPublishService.propose(orgId, {
      channel: b.channel, caption: b.caption, mediaRef: b.mediaRef, kind: b.kind,
      variantKey: b.variantKey, signalId: b.signalId, correlationId: b.correlationId, title: b.title,
      createdBy: (req as any).user?.userId || "studio",
    });
    logAuthEvent(orgId, (req as any).user?.userId || null, action.id, "SOCIAL_PUBLISH_PROPOSE", { channel: b.channel, status: action.status });
    res.json({ action });
  } catch (e: any) { res.status(400).json({ error: String(e?.message || e) }); }
});

// POST /api/social/publish/:actionId/execute — roda o efeito de uma ação de publicação
// APROVADA pelo choke-point governado (idempotente). Owner/admin.
router.post("/publish/:actionId/execute", requireRole("owner", "admin"), async (req: AuthRequest, res): Promise<any> => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const out = await GovernedPublishService.execute(orgId, String(req.params.actionId));
    res.json(out);
  } catch (e: any) { res.status(400).json({ error: String(e?.message || e) }); }
});

// POST /api/social/attribution/resolve — resolve confirmações social_publish pendentes
// com o analytics do post (PUBLISHED→RESULTADO). Owner/admin.
router.post("/attribution/resolve", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const out = SocialAttributionService.resolvePending(orgId);
    if (out.resolved > 0) logAuthEvent(orgId, (req as any).user?.userId || null, null, "SOCIAL_ATTRIBUTION_RESOLVE", { resolved: out.resolved });
    res.json(out);
  } catch (e: any) { res.status(400).json({ error: String(e?.message || e) }); }
});

// GET /api/social/attribution?correlationId= — atribuição variante→engajamento medido.
router.get("/attribution", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const correlationId = typeof req.query?.correlationId === "string" ? req.query.correlationId : undefined;
  res.json({ attribution: SocialAttributionService.attribution(orgId, { correlationId }) });
});

// POST /api/social/creative-learning/sweep — aprende das publicações asseguradas
// (assured→PatternMemory: qual ângulo/formato funciona pro nicho). Owner/admin.
router.post("/creative-learning/sweep", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const out = CreativeLearningService.sweep(orgId);
    if (out.learned > 0) logAuthEvent(orgId, (req as any).user?.userId || null, null, "SOCIAL_CREATIVE_LEARN", { learned: out.learned });
    res.json(out);
  } catch (e: any) { res.status(400).json({ error: String(e?.message || e) }); }
});

// GET /api/social/creative-learning — eficácia aprendida por ângulo criativo (assured).
router.get("/creative-learning", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json({ effectiveness: CreativeLearningService.effectiveness(orgId) });
});

// GET /api/social/proactive — digest humano da fatia social pro "Hoje" do Fala Tu/Radar
// (oportunidades + aprovações pendentes + resultados medidos + o que funciona). Read-only.
router.get("/proactive", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json(SocialProactivityService.digest(orgId));
});

// GET /api/social/entitlement — status do gate de plano das capacidades sociais
// (allowed + caminho de upgrade/add-on pra a CTA de billing). Read-only.
router.get("/entitlement", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json(SocialEntitlementService.status(orgId, req.user));
});

// ── Creative Experiment Engine (PRD 11 / ADR-168 F6) — variantes → z-test → campeão ──

// POST /api/social/experiments { hypothesis, variants:[{variantKey,label?}], objectiveId?, correlationId?, minSample?, confidenceZ? }
router.post("/experiments", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const out = CreativeExperimentService.create(orgId, req.user?.userId || null, {
      hypothesis: String(req.body?.hypothesis || ""),
      variants: Array.isArray(req.body?.variants) ? req.body.variants : [],
      objectiveId: req.body?.objectiveId ? String(req.body.objectiveId) : null,
      correlationId: req.body?.correlationId ? String(req.body.correlationId) : null,
      minSample: req.body?.minSample !== undefined ? Number(req.body.minSample) : undefined,
      confidenceZ: req.body?.confidenceZ !== undefined ? Number(req.body.confidenceZ) : undefined,
    });
    res.json(out);
  } catch (e: any) { res.status(400).json({ error: e.message || "Falha ao criar o experimento." }); }
});

// GET /api/social/experiments?status=running
router.get("/experiments", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const status = req.query?.status ? String(req.query.status) : undefined;
  res.json({ experiments: CreativeExperimentService.list(orgId, status ? { status } : undefined) });
});

// GET /api/social/experiments/:id
router.get("/experiments/:id", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const e = CreativeExperimentService.get(orgId, req.params.id);
  if (!e) return res.status(404).json({ error: "Experimento não encontrado." });
  res.json(e);
});

// POST /api/social/experiments/:id/decide — mede + decide (não executa; RN-CG-08)
router.post("/experiments/:id/decide", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(CreativeExperimentService.decide(orgId, req.params.id, req.user?.userId || null)); }
  catch (e: any) { res.status(404).json({ error: e.message || "Falha ao decidir." }); }
});

// GET /api/social/experiments/:id/outcome — resultado de NEGÓCIO por variante (F9, role-gated)
router.get("/experiments/:id/outcome", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json({ outcomes: CreativeExperimentService.outcomeFor(orgId, req.params.id) });
});

// ── Content→Lead Attribution (PRD 11 / ADR-168 F7) — 1º elo do fio de negócio ──

// POST /api/social/attribution/lead { correlationId, contactId, actionId?, source? }
router.post("/attribution/lead", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const out = ContentLeadAttributionService.attribute(orgId, {
      correlationId: String(req.body?.correlationId || ""),
      contactId: String(req.body?.contactId || ""),
      actionId: req.body?.actionId ? String(req.body.actionId) : null,
      source: req.body?.source ? String(req.body.source) : null,
    });
    res.json(out);
  } catch (e: any) { res.status(400).json({ error: e.message || "Falha ao atribuir o lead." }); }
});

// GET /api/social/attribution/leads?correlationId=...
router.get("/attribution/leads", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const correlationId = String(req.query?.correlationId || "").trim();
  if (!correlationId) return res.status(400).json({ error: "Informe o correlationId." });
  res.json({ correlationId, leadCount: ContentLeadAttributionService.leadCount(orgId, correlationId), leads: ContentLeadAttributionService.leadsFor(orgId, correlationId) });
});

// ── Lead→Sale→Revenue→Margin (PRD 11 / ADR-168 F8) — dinheiro role-gated (RN-CG-06) ──

// POST /api/social/attribution/revenue { correlationId } — resolve venda dos leads do conteúdo
router.post("/attribution/revenue", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const correlationId = String(req.body?.correlationId || "").trim();
  if (!correlationId) return res.status(400).json({ error: "Informe o correlationId." });
  res.json(ContentRevenueAttributionService.attributeLeads(orgId, correlationId));
});

// GET /api/social/attribution/revenue?correlationId=... — resumo receita/margem (fact≠estimate)
router.get("/attribution/revenue", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const correlationId = String(req.query?.correlationId || "").trim();
  if (!correlationId) return res.status(400).json({ error: "Informe o correlationId." });
  res.json(ContentRevenueAttributionService.revenueFor(orgId, correlationId));
});

export default router;
