import { Router } from "express";
import { AuthRequest, requireRole } from "../middleware/auth.js";
import { ReputationConnectorService } from "../ReputationConnectorService.js";
import { ReputationIngestionService } from "../ReputationIngestionService.js";
import { ReputationCaseService } from "../ReputationCaseService.js";
import { ReputationClassificationService } from "../ReputationClassificationService.js";
import { ReputationInvestigationService } from "../ReputationInvestigationService.js";
import { ReputationRecoveryService } from "../ReputationRecoveryService.js";
import { ReputationHandoffService } from "../ReputationHandoffService.js";
import { ReputationReplyService } from "../ReputationReplyService.js";
import { ReputationResolutionService } from "../ReputationResolutionService.js";
import { ReputationClosureService } from "../ReputationClosureService.js";
import { ReputationEscalationRiskDetectorService } from "../ReputationEscalationRiskDetectorService.js";
import { ReputationRootCauseService } from "../ReputationRootCauseService.js";
import { ReputationImpactService } from "../ReputationImpactService.js";
import { ReputationHealthService } from "../ReputationHealthService.js";
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

// POST /api/reputation/cases/:signalId/investigate — investigação (§19-20): causa
// candidata + evidência + grounding + confiança, separando alegação/fato/hipótese.
// Determinística (sem IA). NÃO age (F5 é investigação). Owner/admin.
router.post("/cases/:signalId/investigate", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const out = ReputationInvestigationService.investigate(orgId, req.params.signalId);
  if (!out) return res.status(404).json({ error: "caso de reputação não encontrado" });
  logAuthEvent(orgId, (req as any).user?.userId || null, null, "REPUTATION_CASE_INVESTIGATE", {
    signalId: out.signalId, category: out.category, highRisk: out.highRisk, escalate: out.escalate,
    grounding: out.grounding.status, corroborated: out.grounding.corroboratedByInternalFact, confidence: out.confidence,
  });
  res.json(out);
});

// POST /api/reputation/cases/:signalId/recommend — recovery playbook (§22-24):
// investigação → ações RECOMENDADAS no ledger governado, SEM efeito externo. A
// política de aprovação decide; financeiro nunca auto-aprova; high-risk só encaminha.
router.post("/cases/:signalId/recommend", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const out = ReputationRecoveryService.recommend(orgId, req.params.signalId);
  if (!out) return res.status(404).json({ error: "caso de reputação não encontrado" });
  logAuthEvent(orgId, (req as any).user?.userId || null, null, "REPUTATION_CASE_RECOMMEND", {
    signalId: out.signalId, strategy: out.strategy, highRisk: out.highRisk, corroborated: out.corroborated,
    actions: out.recommendedActions.map((a) => ({ type: a.actionType, status: a.status })),
  });
  res.json(out);
});

// GET /api/reputation/cases/:signalId/view — central Fala Tu do caso (§36): thread
// (linha do tempo por correlation_id) + aprovações pendentes deste caso. Owner/admin.
router.get("/cases/:signalId/view", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const out = ReputationHandoffService.caseView(orgId, (req as any).user, req.params.signalId);
  if (!out) return res.status(404).json({ error: "caso de reputação não encontrado" });
  res.json(out);
});

// POST /api/reputation/cases/:signalId/handoff { toUserId?, note? } — internal handoff
// (§33): posta um resumo determinístico do caso como nota (do caso ou direcionada),
// ancorada ao correlation_id. NÃO age no caso. Owner/admin.
router.post("/cases/:signalId/handoff", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const fromUserId = (req as any).user?.userId || (req as any).user?.id;
  if (!fromUserId) return res.status(401).json({ error: "Unauthorized" });
  const b = req.body || {};
  if (b.toUserId != null && typeof b.toUserId !== "string") return res.status(400).json({ error: "toUserId inválido" });
  try {
    const out = ReputationHandoffService.handoff(orgId, fromUserId, req.params.signalId, { toUserId: b.toUserId || null, note: typeof b.note === "string" ? b.note : undefined });
    if (!out) return res.status(404).json({ error: "caso de reputação não encontrado" });
    logAuthEvent(orgId, fromUserId, out.note?.id || null, "REPUTATION_CASE_HANDOFF", { signalId: req.params.signalId, correlationId: out.correlationId, toUserId: b.toUserId || null });
    res.json(out);
  } catch (e: any) { res.status(400).json({ error: String(e?.message || e) }); }
});

// POST /api/reputation/cases/:signalId/reply/draft { content, provider?, claims? } —
// rascunha a resposta pública como AÇÃO GOVERNADA (awaiting_approval). Não publica;
// o humano aprova no Approval Center (F7). Devolve prévia de grounding (§25). Owner/admin.
router.post("/cases/:signalId/reply/draft", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const b = req.body || {};
  if (typeof b.content !== "string" || !b.content.trim()) return res.status(400).json({ error: "content obrigatório" });
  if (b.claims != null && !Array.isArray(b.claims)) return res.status(400).json({ error: "claims deve ser lista" });
  try {
    const out = ReputationReplyService.draft(orgId, req.params.signalId, { content: b.content, provider: typeof b.provider === "string" ? b.provider : undefined, claims: b.claims, createdBy: (req as any).user?.userId });
    if (!out) return res.status(404).json({ error: "caso de reputação não encontrado" });
    logAuthEvent(orgId, (req as any).user?.userId || null, out.action.id, "REPUTATION_REPLY_DRAFT", { signalId: req.params.signalId, actionId: out.action.id, grounding: out.grounding.status });
    res.json(out);
  } catch (e: any) { res.status(400).json({ error: String(e?.message || e) }); }
});

// POST /api/reputation/actions/:actionId/publish — PUBLICA (execute governado) uma
// resposta APROVADA. Guardas G1/G2/G3 + grounding no handler; provider só aqui (§29).
router.post("/actions/:actionId/publish", requireRole("owner", "admin"), async (req: AuthRequest, res): Promise<any> => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const out = await ReputationReplyService.publish(orgId, req.params.actionId);
    logAuthEvent(orgId, (req as any).user?.userId || null, req.params.actionId, "REPUTATION_REPLY_PUBLISH", { actionId: req.params.actionId, effect: out?.result?.effect, externalRef: out?.result?.externalRef });
    res.json(out);
  } catch (e: any) { res.status(400).json({ error: String(e?.message || e) }); }
});

// POST /api/reputation/actions/:actionId/resolve { overrides? } — RESOLUÇÃO material
// governada (§28-29): executa order_reship/ticket_assign/contact_task de uma ação
// APROVADA. `overrides` = dados reais que o operador informa (ticketId/responsável).
router.post("/actions/:actionId/resolve", requireRole("owner", "admin"), async (req: AuthRequest, res): Promise<any> => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const overrides = (req.body || {}).overrides;
  if (overrides != null && (typeof overrides !== "object" || Array.isArray(overrides))) return res.status(400).json({ error: "overrides deve ser objeto" });
  try {
    const out = await ReputationResolutionService.resolve(orgId, req.params.actionId, overrides || {});
    logAuthEvent(orgId, (req as any).user?.userId || null, req.params.actionId, "REPUTATION_RESOLVE", { actionId: req.params.actionId, effect: out?.result?.effect, externalRef: out?.result?.externalRef });
    res.json(out);
  } catch (e: any) { res.status(400).json({ error: String(e?.message || e) }); }
});

// POST /api/reputation/cases/:signalId/sync-replies { provider? } — lê réplicas do
// consumidor (§31): grava no caso (cercadas), reabre se houver réplica nova num caso
// fechado. Não age externamente. Owner/admin.
router.post("/cases/:signalId/sync-replies", requireRole("owner", "admin"), async (req: AuthRequest, res): Promise<any> => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const provider = typeof (req.body || {}).provider === "string" ? req.body.provider : undefined;
  const out = await ReputationClosureService.syncReplies(orgId, req.params.signalId, { provider });
  if (!out) return res.status(404).json({ error: "caso de reputação não encontrado" });
  logAuthEvent(orgId, (req as any).user?.userId || null, req.params.signalId, "REPUTATION_SYNC_REPLIES", { signalId: req.params.signalId, newConsumer: out.newConsumerReplies.length, reopened: out.reopened, itemStatus: out.itemStatus });
  res.json(out);
});

// POST /api/reputation/cases/:signalId/close { resolution, note? } — fecha o caso
// (§11.10): resolved → confirma a resposta (F8) e resolve o sinal; not_resolved →
// reconhece e dispensa a pendência. Owner/admin.
router.post("/cases/:signalId/close", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const resolution = (req.body || {}).resolution;
  if (resolution !== "resolved" && resolution !== "not_resolved") return res.status(400).json({ error: "resolution deve ser 'resolved' ou 'not_resolved'" });
  const out = ReputationClosureService.close(orgId, req.params.signalId, { resolution, actorId: (req as any).user?.userId || null, note: typeof (req.body || {}).note === "string" ? req.body.note : undefined });
  if (!out) return res.status(404).json({ error: "caso de reputação não encontrado" });
  logAuthEvent(orgId, (req as any).user?.userId || null, req.params.signalId, "REPUTATION_CASE_CLOSE", { signalId: req.params.signalId, resolution: out.resolution, confirmed: out.confirmed.length, dismissed: out.dismissed.length });
  res.json(out);
});

// GET /api/reputation/escalation-risk — candidatos a escalar publicamente (§39-41),
// derivado por query (advisory). POST /run dispara o detector (publica+sweep). Owner/admin.
router.get("/escalation-risk", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json({ enabled: ReputationEscalationRiskDetectorService.enabled(orgId), candidates: ReputationEscalationRiskDetectorService.detect(orgId) });
});

router.post("/escalation-risk/run", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const out = ReputationEscalationRiskDetectorService.publish(orgId);
  logAuthEvent(orgId, (req as any).user?.userId || null, null, "REPUTATION_ESCALATION_RUN", out);
  res.json(out);
});

// GET /api/reputation/root-cause?windowDays=30 — clusters de reclamação por categoria +
// tendência vs baseline + volume-baseline (§42-46, RN-CRR-8). Read-only. Owner/admin.
router.get("/root-cause", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const windowDays = Number(req.query?.windowDays) > 0 ? Number(req.query.windowDays) : undefined;
  res.json(ReputationRootCauseService.analyze(orgId, { windowDays }));
});

// POST /api/reputation/root-cause/learn { windowDays? } — memoriza os padrões
// (PatternMemoryService, opt-in pattern_memory). Owner/admin.
router.post("/root-cause/learn", requireRole("owner", "admin"), async (req: AuthRequest, res): Promise<any> => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const windowDays = Number((req.body || {}).windowDays) > 0 ? Number(req.body.windowDays) : undefined;
  try {
    const out = await ReputationRootCauseService.learn(orgId, { windowDays });
    logAuthEvent(orgId, (req as any).user?.userId || null, null, "REPUTATION_ROOTCAUSE_LEARN", { detected: out.detected, validated: out.validated, published: out.published, skipped: !!out.skipped });
    res.json(out);
  } catch (e: any) { res.status(500).json({ error: String(e?.message || e) }); }
});

// GET /api/reputation/impact?windowDays=30 — KPI da recuperação (§51-55): problemas
// resolvidos (North Star) + taxa + valor protegido por categoria/base (nunca somados).
router.get("/impact", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const windowDays = Number(req.query?.windowDays) > 0 ? Number(req.query.windowDays) : null;
  res.json(ReputationImpactService.kpi(orgId, { windowDays }));
});

// POST /api/reputation/actions/:actionId/impact { realizedValue, category, evidence, basis? }
// — atribui valor recuperado a uma ação de recovery (§52, default INFLUENCED). Owner/admin.
router.post("/actions/:actionId/impact", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const b = req.body || {};
  try {
    const out = ReputationImpactService.recordRecoveryValue(orgId, req.params.actionId, {
      realizedValue: Number(b.realizedValue), category: String(b.category), evidence: b.evidence,
      basis: b.basis, attributionWindowDays: b.attributionWindowDays != null ? Number(b.attributionWindowDays) : null,
    });
    logAuthEvent(orgId, (req as any).user?.userId || null, req.params.actionId, "REPUTATION_IMPACT_RECORD", { actionId: req.params.actionId, category: b.category, basis: out.basis });
    res.json(out);
  } catch (e: any) { res.status(400).json({ error: String(e?.message || e) }); }
});

// GET /api/reputation/health — prontidão do módulo (§67-69): saúde dos conectores +
// backlog + rate-limit de resposta + status agregado (healthy/degraded/blocked). Owner/admin.
router.get("/health", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json(ReputationHealthService.report(orgId));
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
