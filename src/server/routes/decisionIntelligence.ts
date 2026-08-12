import { Router } from "express";
import { AuthRequest, requireMasterAdmin } from "../middleware/auth.js";
import { EvidencePackageService } from "../EvidencePackageService.js";
import { ImpactPrioritizationService } from "../ImpactPrioritizationService.js";
import { DecisionEngine } from "../DecisionEngine.js";
import { DecisionRiskService } from "../DecisionRiskService.js";
import { DecisionMetricsService } from "../DecisionMetricsService.js";
import { VerticalIntelligenceService } from "../VerticalIntelligenceService.js";
import { ResearchBrokerService } from "../ResearchBrokerService.js";
import { ResearchBudgetService } from "../ResearchBudgetService.js";
import { VerticalIntelligenceReminderService } from "../VerticalIntelligenceReminderService.js";
import { ExecutionTraceService } from "../ExecutionTraceService.js";
import { OutcomeAssuranceService } from "../OutcomeAssuranceService.js";
import { ProcessOutcomeContractService } from "../ProcessOutcomeContractService.js";
import { OutcomeReconcilerService } from "../OutcomeReconcilerService.js";
import { OutcomeCorrectionService } from "../OutcomeCorrectionService.js";
import { UnifiedImpactLedgerService } from "../UnifiedImpactLedgerService.js";
import { VerticalIntelligenceResearchService } from "../VerticalIntelligenceResearchService.js";

/**
 * Decision Intelligence — rotas de leitura (DI-1, aditivo sobre ADR-135/136).
 * Sem UI/menu novo: expõe o Evidence Package v1 e o Pareto já com níveis L0–L4
 * para os consumidores existentes (Diretor IA / Cockpit) e para a DI-2.
 */
const router = Router();

// GET /api/decision-intelligence/evidence?subject=&period=&force=1
// Pacote de evidências reutilizável (interno). Cacheado se a org opta pelo flag.
router.get("/evidence", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const subject = typeof req.query?.subject === "string" ? req.query.subject : undefined;
  const period = typeof req.query?.period === "string" ? req.query.period : undefined;
  const force = req.query?.force === "1" || req.query?.force === "true";
  res.json({ evidence: EvidencePackageService.build(orgId, { subject, period, force }) });
});

// GET /api/decision-intelligence/priorities — Pareto de sinais abertos já com
// impactLevel (L0–L4) + perfil de análise recomendado por prioridade.
router.get("/priorities", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json(ImpactPrioritizationService.prioritize(orgId));
});

// POST /api/decision-intelligence/analyze — roda as estratégias (premortem/
// red_team/advocate) sobre a decisão. Body: { title, decisionType, impactAmount,
// impactUnit, severity?, expectedValue?, premises?, decisionId?, mode?, persist? }.
router.post("/analyze", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const b = req.body || {};
  if (!b.title || typeof b.title !== "string") return res.status(400).json({ error: "title é obrigatório." });
  const out = DecisionEngine.analyze(orgId, {
    title: b.title,
    decisionType: b.decisionType,
    impactAmount: b.impactAmount ?? null,
    impactUnit: b.impactUnit ?? null,
    severity: b.severity,
    expectedValue: b.expectedValue ?? null,
    premises: Array.isArray(b.premises) ? b.premises : undefined,
    decisionId: b.decisionId ?? null,
  }, { mode: typeof b.mode === "string" ? b.mode : undefined, persist: b.persist === true });
  res.json(out);
});

// GET /api/decision-intelligence/trace/:correlationId — rastreabilidade ponta-a-
// ponta (ADR-158 §50): o fio sinal → decisão → outcome de um correlationId.
// Read-only, isolado por org. Responde "por que o ZapFlow fez isso?".
router.get("/trace/:correlationId", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json(ExecutionTraceService.trace(orgId, req.params.correlationId));
});

// GET /api/decision-intelligence/assurance/action/:actionId — garantia de ciclo fechado
// de UMA ação (PRD 8 / ADR-165 F1). Read-only, derivado, isolado por org. DONE ≠ RESULTADO.
router.get("/assurance/action/:actionId", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json(OutcomeAssuranceService.assessAction(orgId, req.params.actionId));
});

// GET /api/decision-intelligence/assurance/correlation/:correlationId — garantia do FIO
// inteiro (todas as ações da correlação). overall = pior estado. Read-only (RN-OA-3).
router.get("/assurance/correlation/:correlationId", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json(OutcomeAssuranceService.assessCorrelation(orgId, req.params.correlationId));
});

// GET /api/decision-intelligence/assurance/process/:instanceId — avalia o Outcome
// Contract de PROCESSO (PRD 8 / ADR-165 F2): success/failure_conditions da definição,
// antes inertes, agora avaliadas via evaluateCondition. Read-only (RN-OA-3).
router.get("/assurance/process/:instanceId", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json(ProcessOutcomeContractService.evaluate(orgId, req.params.instanceId));
});

// POST /api/decision-intelligence/assurance/reconcile — roda o Reconciler de outcome
// (PRD 8 / ADR-165 F6): sinaliza ações done-sem-outcome e resolve as já medidas. Fecha o
// achado (b) — o gap que o catch vazio do complete engolia. Não muda a FSM (RN-OA-3).
router.post("/assurance/reconcile", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json(OutcomeReconcilerService.reconcile(orgId));
});

// POST /api/decision-intelligence/assurance/correct — propõe correções GOVERNADAS pros
// gaps de garantia abertos (PRD 8 / ADR-165 F10). Só PROPÕE (awaiting_approval); nunca
// executa — a correção passa por DecisionAction→ApprovalPolicy→CommandExecutor (RN-OA-9).
router.post("/assurance/correct", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json(OutcomeCorrectionService.proposeCorrections(orgId, { actorId: req.user?.userId }));
});

// GET /api/decision-intelligence/impact-ledger — ledger de impacto UNIFICADO
// (ADR-158 F3): "quanto o ZapFlow produziu?" reunindo as fontes de impacto,
// derivado e read-only, com categorias SEMPRE separadas (nunca somadas).
router.get("/impact-ledger", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json(UnifiedImpactLedgerService.build(orgId));
});

// GET /api/decision-intelligence/risks?decisionId=&status= — riscos previstos.
router.get("/risks", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const decisionId = typeof req.query?.decisionId === "string" ? req.query.decisionId : undefined;
  const status = typeof req.query?.status === "string" ? req.query.status : undefined;
  res.json({ risks: DecisionRiskService.list(orgId, { decisionId, status }) });
});

// POST /api/decision-intelligence/risks/:id/resolve — o risco deixou de valer.
router.post("/risks/:id/resolve", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const out = DecisionRiskService.resolve(orgId, req.params.id);
  if (!out.ok) return res.status(404).json({ error: "Risco não encontrado ou já resolvido." });
  res.json(out);
});

// ── External Intelligence (ADR-156, DI-4.1) ──────────────────────────────────

// POST /api/decision-intelligence/vertical-intelligence/run — SÓ admin master
// (D5). Roda a pesquisa do nicho e grava no compartilhado. Body: { vertical,
// topic, region?, timeframe?, ttlDays?, provider? }.
router.post("/vertical-intelligence/run", requireMasterAdmin, async (req: AuthRequest, res): Promise<any> => {
  const b = req.body || {};
  if (!b.vertical || !b.topic) return res.status(400).json({ error: "vertical e topic são obrigatórios." });
  try {
    const out = await VerticalIntelligenceService.runResearch(
      { userId: req.user?.userId, organizationId: req.organizationId },
      { vertical: b.vertical, topic: b.topic, region: b.region, timeframe: b.timeframe, ttlDays: b.ttlDays },
      { providerName: typeof b.provider === "string" ? b.provider : undefined },
    );
    res.json({ verticalIntelligence: out });
  } catch (e: any) {
    res.status(400).json({ error: String(e?.message || e) });
  }
});

// POST /api/decision-intelligence/vertical-intelligence/manual — SÓ admin master
// (DI-4.4). O admin COLA a pesquisa do nicho (sem rede externa). Body: { vertical,
// topic, region?, timeframe?, summary, drivers?, sources?, confidence?, ttlDays? }.
router.post("/vertical-intelligence/manual", requireMasterAdmin, (req: AuthRequest, res): any => {
  const b = req.body || {};
  if (!b.vertical || !b.topic || !b.summary) return res.status(400).json({ error: "vertical, topic e summary são obrigatórios." });
  try {
    const out = VerticalIntelligenceService.runManual(
      { userId: req.user?.userId, organizationId: req.organizationId },
      { vertical: b.vertical, topic: b.topic, region: b.region, timeframe: b.timeframe, summary: b.summary, drivers: b.drivers, sources: b.sources, confidence: b.confidence, ttlDays: b.ttlDays },
    );
    res.json({ verticalIntelligence: out });
  } catch (e: any) {
    res.status(400).json({ error: String(e?.message || e) });
  }
});

// GET /api/decision-intelligence/research-refresh-due — nichos vencendo/vencidos
// (com consumidores) + estado do lembrete semanal. SÓ admin master (DI-4.5).
router.get("/research-refresh-due", requireMasterAdmin, (_req: AuthRequest, res): any => {
  res.json({ due: VerticalIntelligenceReminderService.dueNiches(), enabled: VerticalIntelligenceReminderService.isEnabled(), lastRun: VerticalIntelligenceReminderService.lastRun() });
});

// PUT /api/decision-intelligence/research-refresh-due — liga/desliga o lembrete
// semanal. Body: { enabled }. SÓ admin master.
router.put("/research-refresh-due", requireMasterAdmin, (req: AuthRequest, res): any => {
  if (typeof req.body?.enabled !== "boolean") return res.status(400).json({ error: "enabled (boolean) é obrigatório." });
  VerticalIntelligenceReminderService.setEnabled(req.body.enabled);
  res.json({ enabled: VerticalIntelligenceReminderService.isEnabled() });
});

// GET /api/decision-intelligence/vertical-intelligence?vertical= — SÓ admin master.
// DI-5.5: cada item vem enriquecido com a TENDÊNCIA (delta da última versão vs a
// anterior — cresceu/retraiu/novo/saiu) e com a flag `automated` (o nicho está
// sob pesquisa automática?).
router.get("/vertical-intelligence", requireMasterAdmin, (req: AuthRequest, res): any => {
  const vertical = typeof req.query?.vertical === "string" ? req.query.vertical : undefined;
  const items = VerticalIntelligenceService.list({ vertical }).map((it: any) => ({
    ...it,
    delta: VerticalIntelligenceService.latestDelta(it.fingerprint),
    automated: VerticalIntelligenceResearchService.isAutomated(it.fingerprint),
  }));
  res.json({ items });
});

// GET /api/decision-intelligence/vertical-intelligence/history?fingerprint= — histórico
// versionado de um nicho (com o delta de cada versão). SÓ admin master (DI-5.2/5.5).
router.get("/vertical-intelligence/history", requireMasterAdmin, (req: AuthRequest, res): any => {
  const fingerprint = typeof req.query?.fingerprint === "string" ? req.query.fingerprint : "";
  if (!fingerprint) return res.status(400).json({ error: "fingerprint é obrigatório." });
  res.json({ history: VerticalIntelligenceService.history(fingerprint) });
});

// ── Automação de pesquisa (ADR-157, DI-5.4/5.5) — SÓ admin master ────────────

// GET /api/decision-intelligence/research-schedule — agenda de nichos + estado do
// toggle global da automação.
router.get("/research-schedule", requireMasterAdmin, (_req: AuthRequest, res): any => {
  res.json({ items: VerticalIntelligenceResearchService.list(), enabled: VerticalIntelligenceResearchService.isEnabled() });
});

// PUT /api/decision-intelligence/research-schedule — liga/desliga a automação
// GLOBAL. Body: { enabled }.
router.put("/research-schedule", requireMasterAdmin, (req: AuthRequest, res): any => {
  if (typeof req.body?.enabled !== "boolean") return res.status(400).json({ error: "enabled (boolean) é obrigatório." });
  VerticalIntelligenceResearchService.setEnabled(req.body.enabled);
  res.json({ enabled: VerticalIntelligenceResearchService.isEnabled() });
});

// POST /api/decision-intelligence/research-schedule — registra/atualiza um nicho na
// agenda. Body: { vertical, topic, region?, timeframe?, intervalDays?, enabled? }.
router.post("/research-schedule/niche", requireMasterAdmin, (req: AuthRequest, res): any => {
  const b = req.body || {};
  if (!b.vertical || !b.topic) return res.status(400).json({ error: "vertical e topic são obrigatórios." });
  try {
    res.json({ schedule: VerticalIntelligenceResearchService.upsert({ vertical: b.vertical, topic: b.topic, region: b.region, timeframe: b.timeframe, intervalDays: b.intervalDays, enabled: b.enabled }) });
  } catch (e: any) {
    res.status(400).json({ error: String(e?.message || e) });
  }
});

// PUT /api/decision-intelligence/research-schedule/niche/:fingerprint — liga/desliga
// a automação de UM nicho. Body: { enabled }.
router.put("/research-schedule/niche/:fingerprint", requireMasterAdmin, (req: AuthRequest, res): any => {
  if (typeof req.body?.enabled !== "boolean") return res.status(400).json({ error: "enabled (boolean) é obrigatório." });
  VerticalIntelligenceResearchService.setNicheEnabled(req.params.fingerprint, req.body.enabled);
  res.json({ schedule: VerticalIntelligenceResearchService.get(req.params.fingerprint) });
});

// DELETE /api/decision-intelligence/research-schedule/niche/:fingerprint — remove
// o nicho da agenda (volta ao manual + lembrete).
router.delete("/research-schedule/niche/:fingerprint", requireMasterAdmin, (req: AuthRequest, res): any => {
  VerticalIntelligenceResearchService.remove(req.params.fingerprint);
  res.json({ ok: true });
});

// GET /api/decision-intelligence/research-budget — situação do orçamento de
// pesquisa de plataforma (DI-4.2). SÓ admin master.
router.get("/research-budget", requireMasterAdmin, (_req: AuthRequest, res): any => {
  res.json(ResearchBudgetService.status());
});

// PUT /api/decision-intelligence/research-budget — define o teto mensal em
// centavos (0 = ilimitado). SÓ admin master. Body: { monthlyBudgetCents }.
router.put("/research-budget", requireMasterAdmin, (req: AuthRequest, res): any => {
  const cents = Number(req.body?.monthlyBudgetCents);
  if (!Number.isFinite(cents) || cents < 0) return res.status(400).json({ error: "monthlyBudgetCents inválido." });
  ResearchBudgetService.setBudgetCents(cents);
  res.json(ResearchBudgetService.status());
});

// GET /api/decision-intelligence/external-evidence?vertical=&topic=&region=&timeframe=
// — leitura do TENANT (read-only; nunca dispara pesquisa). Requer opt-in.
router.get("/external-evidence", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const q = req.query || {};
  res.json(ResearchBrokerService.resolve(orgId, {
    vertical: typeof q.vertical === "string" ? q.vertical : "",
    topic: typeof q.topic === "string" ? q.topic : "",
    region: typeof q.region === "string" ? q.region : undefined,
    timeframe: typeof q.timeframe === "string" ? q.timeframe : undefined,
  }));
});

// GET /api/decision-intelligence/metrics?days= — métricas do loop fechado
// (valor protegido, acurácia de previsão, materialização de risco, aceitação,
// cache hit-rate). Alimenta o card do Diretor IA / Central de Saúde.
router.get("/metrics", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const days = typeof req.query?.days === "string" ? parseInt(req.query.days, 10) : undefined;
  res.json(DecisionMetricsService.summary(orgId, { days: Number.isFinite(days as number) ? days : undefined }));
});

// ADR-159 F5 (D5) — progressive autonomy: propostas de elevação (a IA propõe; o
// humano confirma). GET lista as abertas; POST /:id/accept aplica (exige motivo).
router.get("/autonomy-proposals", async (req: AuthRequest, res): Promise<any> => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const { ProgressiveAutonomyService } = await import("../ProgressiveAutonomyService.js");
  res.json({ proposals: ProgressiveAutonomyService.listProposals(orgId) });
});

router.post("/autonomy-proposals/:id/accept", async (req: AuthRequest, res): Promise<any> => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const { ProgressiveAutonomyService } = await import("../ProgressiveAutonomyService.js");
  try {
    res.json(ProgressiveAutonomyService.accept(orgId, req.params.id, { actorId: req.user?.userId, reason: req.body?.reason }));
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

export default router;
