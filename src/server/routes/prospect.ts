import { Router } from "express";
import { AuthRequest, requireRole } from "../middleware/auth.js";
import { logAuthEvent } from "../auditLog.js";
import { ProspectService } from "../ProspectService.js";
import { ProspectDiscoveryService } from "../ProspectDiscoveryService.js";
import { ProspectExecutionService } from "../ProspectExecutionService.js";
import { ProspectResearchService } from "../ProspectResearchService.js";

const router = Router();
const actor = (req: any) => req.user?.userId || req.user?.id;

// RBAC (ADR-079, Fase A): configuração e aprovação são de gestor (owner/admin);
// o vendedor (agent) trabalha os leads — evidências, hipóteses, score, rascunho
// de abordagem, follow-up e registro de desfecho.
const managerOnly = requireRole("owner", "admin");

// ── ICP ──────────────────────────────────────────────────────────────────
router.get("/icps", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json(ProspectService.listIcps(orgId));
});

router.post("/icps", managerOnly, (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const icp = ProspectService.createIcp(orgId, req.body || {}, actor(req));
    logAuthEvent(orgId, actor(req), null, "PROSPECT_ICP_CREATED", { icpId: icp.id, name: icp.name });
    res.json(icp);
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.patch("/icps/:id", managerOnly, (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const icp = ProspectService.updateIcp(orgId, req.params.id, req.body || {});
    logAuthEvent(orgId, actor(req), null, "PROSPECT_ICP_UPDATED", { icpId: req.params.id });
    res.json(icp);
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.delete("/icps/:id", managerOnly, (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const ok = ProspectService.archiveIcp(orgId, req.params.id);
  if (!ok) return res.status(400).json({ error: "ICP não encontrado." });
  logAuthEvent(orgId, actor(req), null, "PROSPECT_ICP_ARCHIVED", { icpId: req.params.id });
  res.json({ success: true });
});

// ── Campanhas (rascunho) ─────────────────────────────────────────────────
router.get("/campaigns", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json(ProspectService.listCampaigns(orgId));
});

router.post("/campaigns", managerOnly, (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const camp = ProspectService.createCampaign(orgId, req.body || {}, actor(req));
    logAuthEvent(orgId, actor(req), null, "PROSPECT_CAMPAIGN_CREATED", { campaignId: camp.id, name: camp.name });
    res.json(camp);
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.patch("/campaigns/:id", managerOnly, (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const camp = ProspectService.updateCampaign(orgId, req.params.id, req.body || {});
    logAuthEvent(orgId, actor(req), null, "PROSPECT_CAMPAIGN_UPDATED", { campaignId: req.params.id, fields: Object.keys(req.body || {}) });
    res.json(camp);
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

// ── Importação (CSV) + contas/contatos ───────────────────────────────────
// POST /api/prospect/import { campaignId?, sourceRef?, records: [...] }
// Auditoria do lote (PROSPECT_LEADS_IMPORTED) é feita no serviço.
router.post("/import", managerOnly, (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(ProspectService.importRecords(orgId, req.body || {}, actor(req))); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.get("/accounts", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json(ProspectService.listAccounts(orgId, { campaignId: req.query.campaignId as string, q: req.query.q as string }));
});

router.get("/accounts/:id", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const a = ProspectService.getAccount(orgId, req.params.id);
  if (!a) return res.status(404).json({ error: "Conta não encontrada." });
  res.json(a);
});

router.post("/accounts/:id/status", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const ok = ProspectService.updateAccountStatus(orgId, req.params.id, String(req.body?.status || ""));
    if (!ok) return res.status(400).json({ error: "Conta não encontrada." });
    logAuthEvent(orgId, actor(req), null, "PROSPECT_ACCOUNT_STATUS_CHANGED", { accountId: req.params.id, status: String(req.body?.status || "") });
    res.json({ success: true });
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

// ── LGPD: bloqueio de conta e opt-out de contato (ADR-079, Fase A) ────────
// Qualquer usuário autenticado pode registrar — honrar opt-out deve ser fácil.
// Auditoria (PROSPECT_ACCOUNT_BLOCKED / PROSPECT_CONTACT_OPTOUT) no serviço.
router.post("/accounts/:id/block", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(ProspectService.setAccountBlocked(orgId, req.params.id, req.body?.blocked !== false, actor(req))); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.post("/accounts/:id/contacts/:cid/opt-out", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(ProspectService.setContactOptOut(orgId, req.params.id, req.params.cid, req.body?.optOut !== false, actor(req))); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

// ── Evidências ───────────────────────────────────────────────────────────
router.post("/accounts/:id/signals", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const a = ProspectService.addSignal(orgId, req.params.id, req.body || {});
    logAuthEvent(orgId, actor(req), null, "PROSPECT_SIGNAL_ADDED", { accountId: req.params.id, signalType: String(req.body?.signalType || "outro") });
    res.json(a);
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.delete("/accounts/:id/signals/:sid", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const a = ProspectService.removeSignal(orgId, req.params.id, req.params.sid);
    logAuthEvent(orgId, actor(req), null, "PROSPECT_SIGNAL_REMOVED", { accountId: req.params.id, signalId: req.params.sid });
    res.json(a);
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

// ── Hipóteses de dor (IA) ────────────────────────────────────────────────
router.post("/accounts/:id/hypotheses", async (req: AuthRequest, res): Promise<any> => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const a = await ProspectService.generateHypotheses(orgId, req.params.id);
    logAuthEvent(orgId, actor(req), null, "PROSPECT_HYPOTHESES_GENERATED", { accountId: req.params.id, createdByAi: true });
    res.json(a);
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.post("/accounts/:id/hypotheses/:hid/status", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const a = ProspectService.setHypothesisStatus(orgId, req.params.id, req.params.hid, String(req.body?.status || ""));
    logAuthEvent(orgId, actor(req), null, "PROSPECT_HYPOTHESIS_STATUS", { accountId: req.params.id, hypothesisId: req.params.hid, status: String(req.body?.status || "") });
    res.json(a);
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

// ── Score (recalcula sob demanda) ────────────────────────────────────────
router.post("/accounts/:id/score", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const score = ProspectService.computeScore(orgId, req.params.id);
    logAuthEvent(orgId, actor(req), null, "PROSPECT_SCORE_COMPUTED", { accountId: req.params.id, priority: score.priority });
    res.json(score);
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

// ── Composer de abordagem (IA) + fila de aprovação ───────────────────────
// Gera um rascunho (e-mail/WhatsApp/ligação) a partir de evidências + hipóteses.
// Auditoria (PROSPECT_OUTREACH_*) é feita no serviço.
router.post("/accounts/:id/outreach", async (req: AuthRequest, res): Promise<any> => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(await ProspectService.composeOutreach(orgId, req.params.id, req.body || {}, actor(req))); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.patch("/outreach/:oid", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(ProspectService.updateOutreach(orgId, req.params.oid, req.body || {}, actor(req))); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.post("/outreach/:oid/status", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const status = String(req.body?.status || "");
  // Aprovar/rejeitar é decisão de gestor (ADR-079, Fase A). Pedir aprovação
  // (pending_approval), voltar a rascunho e marcar envio ficam com o vendedor.
  if ((status === "approved" || status === "rejected") && !["owner", "admin"].includes(req.user?.role)) {
    return res.status(403).json({ error: "Apenas gestores (owner/admin) aprovam ou rejeitam abordagens." });
  }
  try { res.json(ProspectService.setOutreachStatus(orgId, req.params.oid, status, actor(req))); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

// ── Execução real (ADR-079, Fase B) ──────────────────────────────────────
// Envio REAL da abordagem aprovada (WhatsApp/e-mail). Vendedor pode executar:
// a decisão de conteúdo já passou pela aprovação do gestor.
router.post("/outreach/:oid/send", async (req: AuthRequest, res): Promise<any> => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(await ProspectExecutionService.sendOutreach(orgId, req.params.oid, actor(req))); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.post("/accounts/:id/reply", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(ProspectExecutionService.registerReply(orgId, req.params.id, { ...req.body, source: "manual" }, actor(req))); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.post("/accounts/:id/meeting", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(ProspectExecutionService.registerMeeting(orgId, req.params.id, req.body || {}, actor(req))); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.post("/accounts/:id/convert-to-crm", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(ProspectExecutionService.convertToCrm(orgId, req.params.id, actor(req))); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.get("/accounts/:id/events", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json(ProspectExecutionService.listEvents(orgId, req.params.id));
});

// ── Research Engine (ADR-079, Fase C) ────────────────────────────────────
// Criar/iniciar/concluir experimento é decisão de gestor. Alocar lead a uma
// variante (gera rascunho para aprovação) fica aberto ao vendedor.
router.post("/experiments", managerOnly, (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(ProspectResearchService.createExperiment(orgId, req.body || {}, actor(req))); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.get("/experiments", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json(ProspectResearchService.listExperiments(orgId));
});

router.get("/experiments/:id", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const e = ProspectResearchService.getExperiment(orgId, req.params.id);
  if (!e) return res.status(404).json({ error: "Experimento não encontrado." });
  res.json(e);
});

router.post("/experiments/:id/start", managerOnly, (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(ProspectResearchService.startExperiment(orgId, req.params.id, actor(req))); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.post("/experiments/:id/draft", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(ProspectResearchService.draftFromVariant(orgId, req.params.id, String(req.body?.accountId || ""), req.body?.contactId, actor(req))); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.post("/experiments/:id/complete", managerOnly, async (req: AuthRequest, res): Promise<any> => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(await ProspectResearchService.completeExperiment(orgId, req.params.id, actor(req))); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

// ── Dashboard (ADR-079, Fase E) ──────────────────────────────────────────
router.get("/dashboard", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json(ProspectResearchService.dashboard(orgId));
});

// ── Memória de aprendizados + IA (ADR-079, Fase D) ───────────────────────
router.get("/research/learnings", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json(ProspectResearchService.listLearnings(orgId, { campaignId: req.query.campaignId as string, includeDeprecated: req.query.all === "1" }));
});

router.post("/research/learnings", managerOnly, (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(ProspectResearchService.recordLearning(orgId, req.body || {}, actor(req))); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.post("/research/learnings/:id/deprecate", managerOnly, (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const ok = ProspectResearchService.deprecateLearning(orgId, req.params.id, actor(req));
  if (!ok) return res.status(400).json({ error: "Aprendizado não encontrado ou já depreciado." });
  res.json({ success: true });
});

router.post("/research/suggest-hypotheses", async (req: AuthRequest, res): Promise<any> => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(await ProspectResearchService.suggestHypotheses(orgId, req.body?.campaignId)); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.post("/research/recommend-next-action", async (req: AuthRequest, res): Promise<any> => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json(await ProspectResearchService.recommendNextAction(orgId));
});

router.get("/approval-queue", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json(ProspectService.listApprovalQueue(orgId));
});

// ── Atribuição (receita originada) + copiloto do SDR ─────────────────────
router.post("/accounts/:id/outcome", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(ProspectService.recordOutcome(orgId, req.params.id, req.body || {}, actor(req))); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.get("/attribution", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json(ProspectService.attributionSummary(orgId));
});

// ── Descoberta automática por região (OpenStreetMap, fontes públicas) ────
router.patch("/campaigns/:id/discovery", managerOnly, async (req: AuthRequest, res): Promise<any> => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const camp = await ProspectDiscoveryService.updateConfig(orgId, req.params.id, req.body || {});
    logAuthEvent(orgId, actor(req), null, "PROSPECT_DISCOVERY_CONFIG_UPDATED", { campaignId: req.params.id, fields: Object.keys(req.body || {}) });
    res.json(camp);
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

// Auditoria da rodada (PROSPECT_DISCOVERY_RUN) é feita no serviço — cobre
// também as execuções do scheduler, que não passam por esta rota.
router.post("/campaigns/:id/discovery/run", managerOnly, async (req: AuthRequest, res): Promise<any> => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(await ProspectDiscoveryService.runForCampaign(orgId, req.params.id, "manual")); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.get("/discovery/runs", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json(ProspectDiscoveryService.listRuns(orgId, req.query.campaignId as string));
});

// Chave da Google Places API (premium) — status (sem expor o valor) e gravação.
router.get("/discovery/places-key", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json(ProspectDiscoveryService.getPlacesKeyInfo(orgId));
});

router.post("/discovery/places-key", managerOnly, (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const r = ProspectDiscoveryService.setPlacesKey(orgId, String(req.body?.apiKey || ""));
    logAuthEvent(orgId, actor(req), null, "PROSPECT_PLACES_KEY_UPDATED", { configured: r.configured });
    res.json(r);
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.post("/accounts/:id/copilot", async (req: AuthRequest, res): Promise<any> => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(await ProspectService.sdrCopilot(orgId, req.params.id)); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

export default router;
