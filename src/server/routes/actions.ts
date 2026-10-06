import { Router } from "express";
import { AuthRequest } from "../middleware/auth.js";
import { DecisionActionService } from "../DecisionActionService.js";
import { OutcomeMeasurementService } from "../OutcomeMeasurementService.js";
import { CommandExecutorService } from "../CommandExecutorService.js";
import { StepUpMfaService } from "../StepUpMfaService.js";
import { UxPresentationService } from "../UxPresentationService.js";
import { ApprovalPolicyService } from "../ApprovalPolicyService.js";
import { ExecutionTraceService } from "../ExecutionTraceService.js";
import { ContextProjectionService } from "../ContextProjectionService.js";
import { AutonomyKillSwitchService } from "../AutonomyKillSwitchService.js";
import { PermissionService } from "../PermissionService.js";
import { MASTER_ADMIN_EMAIL } from "../config/secret.js";

// Decision & Action Ledger (ADR-136, Epic 2 — C2). Rota core.
const router = Router();
const actor = (req: AuthRequest) => req.user?.userId;

// GET /api/actions?status=awaiting_approval&domain=finance
router.get("/", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const status = typeof req.query?.status === "string" ? req.query.status : undefined;
  const domain = typeof req.query?.domain === "string" ? req.query.domain : undefined;
  res.json({ actions: DecisionActionService.list(orgId, { status, domain }) });
});

// ── ADR-204 F3.1c — kill switch + travas de segurança. Pausar/retomar/configurar: só o DONO (ou o admin master da plataforma).
const canGovernAutonomy = (req: AuthRequest): boolean =>
  !!req.organizationId && (PermissionService.isOwner(req.organizationId, req.user) || !!(req.user?.email && req.user.email === MASTER_ADMIN_EMAIL));

// GET /api/actions/autonomy/overview — ADR-204 F3.1d: o que a tela Empresa → Autonomia da IA mostra (piso por categoria,
// política e nível de cada tipo, pausa e travas). Leitura p/ qualquer usuário da empresa; `canGovern` diz se pode alterar.
router.get("/autonomy/overview", (req: AuthRequest, res): any => {
  if (!req.organizationId) return res.status(401).json({ error: "Unauthorized" });
  res.json({ ...ApprovalPolicyService.overview(req.organizationId), canGovern: canGovernAutonomy(req) });
});

// GET /api/actions/autonomy/status — pausas ativas + histórico recente (qualquer usuário da empresa lê; só o dono altera).
router.get("/autonomy/status", (req: AuthRequest, res): any => {
  if (!req.organizationId) return res.status(401).json({ error: "Unauthorized" });
  res.json({ ...AutonomyKillSwitchService.status(req.organizationId), canGovern: canGovernAutonomy(req) });
});

// POST /api/actions/autonomy/pause { reason, domain?, actionType? } — sem domain/actionType = a empresa inteira.
router.post("/autonomy/pause", (req: AuthRequest, res): any => {
  if (!req.organizationId) return res.status(401).json({ error: "Unauthorized" });
  if (!canGovernAutonomy(req)) return res.status(403).json({ error: "Só o dono pode pausar a autonomia." });
  try { res.status(201).json(AutonomyKillSwitchService.pause(req.organizationId, { domain: req.body?.domain, actionType: req.body?.actionType, reason: req.body?.reason, by: String(req.user?.userId || "") })); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

// POST /api/actions/autonomy/resume { domain?, actionType? } — retoma a abrangência indicada.
router.post("/autonomy/resume", (req: AuthRequest, res): any => {
  if (!req.organizationId) return res.status(401).json({ error: "Unauthorized" });
  if (!canGovernAutonomy(req)) return res.status(403).json({ error: "Só o dono pode retomar a autonomia." });
  try { res.json(AutonomyKillSwitchService.resume(req.organizationId, { domain: req.body?.domain, actionType: req.body?.actionType, by: String(req.user?.userId || "") })); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

// GET /api/actions/autonomy/gates?domain=&actionType= — travas configuradas (vazio = nenhuma, comportamento de sempre).
router.get("/autonomy/gates", (req: AuthRequest, res): any => {
  if (!req.organizationId) return res.status(401).json({ error: "Unauthorized" });
  const domain = typeof req.query?.domain === "string" ? req.query.domain : "";
  const actionType = typeof req.query?.actionType === "string" ? req.query.actionType : "";
  if (!domain || !actionType) return res.status(400).json({ error: "domain e actionType são obrigatórios." });
  res.json({ domain, actionType, gates: ApprovalPolicyService.gatesFor(req.organizationId, domain, actionType) });
});

// PUT /api/actions/autonomy/gates { domain, actionType, minConfidence?, maxExecuteAmount?, maxDataAgeMinutes? } — null limpa a trava.
router.put("/autonomy/gates", (req: AuthRequest, res): any => {
  if (!req.organizationId) return res.status(401).json({ error: "Unauthorized" });
  if (!canGovernAutonomy(req)) return res.status(403).json({ error: "Só o dono pode configurar as travas de segurança." });
  const { domain, actionType } = req.body || {};
  if (!domain || !actionType) return res.status(400).json({ error: "domain e actionType são obrigatórios." });
  try {
    const b = req.body || {};
    const gates = ApprovalPolicyService.setGates(req.organizationId, String(domain), String(actionType), { minConfidence: b.minConfidence, maxExecuteAmount: b.maxExecuteAmount, maxDataAgeMinutes: b.maxDataAgeMinutes });
    res.json({ domain, actionType, gates });
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

// GET /api/actions/ledger — Impact Ledger unificado (esperado × realizado).
// Precisa vir ANTES de /:id para não ser capturada como id="ledger".
router.get("/ledger", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const domain = typeof req.query?.domain === "string" ? req.query.domain : undefined;
  res.json(OutcomeMeasurementService.ledger(orgId, { domain }));
});

// GET /api/actions/cards — PRD 6 F4: Decision Cards (o-que/por-que/impacto/
// recomendo/posso-fazer/regra) das ações que pedem atenção, já role-scoped +
// dinheiro role-gated (§73). Antes de /:id pra não ser capturada como id="cards".
router.get("/cards", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const statuses = typeof req.query?.status === "string" ? req.query.status.split(",") : undefined;
  res.json({ cards: UxPresentationService.cards(orgId, req.user, { statuses }) });
});

// GET /api/actions/autonomy-floor — ADR-204 F3.1a: tipos de ação que SEMPRE exigem aprovação de
// uma pessoa (PRD Fase 3 §4) + o significado dos níveis 0–4 (mapa derivado, sem enum novo).
// Antes de /:id pra não ser capturada como id="autonomy-floor".
router.get("/autonomy-floor", (req: AuthRequest, res): any => {
  if (!req.organizationId) return res.status(401).json({ error: "Unauthorized" });
  res.json({
    humanOnly: ApprovalPolicyService.humanOnlyTypes(),
    levels: [
      { level: 0, label: "observar", meaning: "A IA identifica e relata." },
      { level: 1, label: "recomendar", meaning: "A IA apresenta a solução; a pessoa decide." },
      { level: 2, label: "preparar", meaning: "A IA faz o trabalho e aguarda autorização." },
      { level: 3, label: "executar dentro de limites", meaning: "A IA executa o que o dono autorizou previamente, dentro do limite." },
      { level: 4, label: "autonomia avançada", meaning: "Não habilitado nesta fase.", enabled: false },
    ],
  });
});

// GET /api/actions/autonomy-level?domain=&actionType= — nível 0–4 derivado p/ (domínio, tipo) + o porquê.
router.get("/autonomy-level", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const domain = typeof req.query?.domain === "string" ? req.query.domain : "";
  const actionType = typeof req.query?.actionType === "string" ? req.query.actionType : "";
  if (!domain || !actionType) return res.status(400).json({ error: "domain e actionType são obrigatórios." });
  res.json(ApprovalPolicyService.autonomyLevel(orgId, { domain, actionType }));
});

router.get("/:id", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const a = DecisionActionService.get(orgId, req.params.id);
  if (!a) return res.status(404).json({ error: "Ação não encontrada." });
  res.json(a);
});

// GET /api/actions/:id/card — o Decision Card de uma ação (progressive disclosure).
// 404 quando o domínio é invisível ao papel (RN-UX-2) — não vaza existência.
router.get("/:id/card", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const a = DecisionActionService.get(orgId, req.params.id);
  if (!a) return res.status(404).json({ error: "Ação não encontrada." });
  const card = UxPresentationService.card(orgId, a, req.user);
  if (!card) return res.status(404).json({ error: "Ação não encontrada." });
  res.json(card);
});

// GET /api/actions/:id/why — ADR-204 F3.1b: "por que o ZapFlow fez isso?" em evidência de negócio (recomendação+base,
// sinal de origem, política que governou, quem autorizou, execução ou "não executei porque…", resultado).
// 404 quando o domínio é invisível ao papel (RN-UX-2); dinheiro role-gated (§73).
router.get("/:id/why", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const a = DecisionActionService.get(orgId, req.params.id);
  if (!a || !ContextProjectionService.canSeeDomain(orgId, req.user, a.domain)) return res.status(404).json({ error: "Ação não encontrada." });
  res.json(ExecutionTraceService.explain(orgId, a.id, { canSeeMoney: ContextProjectionService.hasFullBusinessVisibility(orgId, req.user) }));
});

// POST /api/actions — propõe uma ação (a política define se exige aprovação).
router.post("/", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    res.status(201).json(DecisionActionService.propose(orgId, { ...(req.body || {}), createdBy: req.body?.createdBy || "user" }));
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

// POST /api/actions/:id/approve — aprova (gestor/perfil exigido).
router.post("/:id/approve", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const a = DecisionActionService.get(orgId, req.params.id);
  if (!a) return res.status(404).json({ error: "Ação não encontrada." });
  // ADR-159 F1 (D2): RBAC granular via porta única (DecisionActionService.canApprove)
  // — mesma checagem que o Approval Center do Fala Tu usa; nenhuma superfície burla.
  if (!DecisionActionService.canApprove(orgId, req.user, a)) return res.status(403).json({ error: `Aprovação exige permissão de execução${a.approval_role ? ` (perfil ${a.approval_role})` : ""}.` });
  try {
    res.json(DecisionActionService.approve(orgId, req.params.id, actor(req), { reason: req.body?.reason }));
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

// POST /api/actions/:id/reject
router.post("/:id/reject", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  // ADR-159 F1 (D2): RBAC granular via porta única (mesma checagem do Fala Tu).
  if (!DecisionActionService.canReject(orgId, req.user)) return res.status(403).json({ error: "Rejeição exige permissão de execução." });
  try {
    res.json(DecisionActionService.reject(orgId, req.params.id, actor(req), { reason: req.body?.reason }));
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

// POST /api/actions/:id/assign { userId }
router.post("/:id/assign", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(DecisionActionService.assign(orgId, req.params.id, req.body?.userId || null)); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

// POST /api/actions/:id/reschedule { dueAt }
router.post("/:id/reschedule", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(DecisionActionService.reschedule(orgId, req.params.id, req.body?.dueAt || null)); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

// POST /api/actions/:id/complete { resultAmount? }
router.post("/:id/complete", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(DecisionActionService.complete(orgId, req.params.id, { resultAmount: req.body?.resultAmount })); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

// POST /api/actions/:id/cancel
router.post("/:id/cancel", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(DecisionActionService.cancel(orgId, req.params.id)); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

// POST /api/actions/:id/prepare — executor governado (Maestro 2.0): prepara o
// comando tipado de uma ação APROVADA (rascunho auditável, sem efeito externo).
router.post("/:id/prepare", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  if (!["owner", "admin"].includes(req.user?.role)) return res.status(403).json({ error: "Apenas gestores podem preparar a execução." });
  try { res.json(CommandExecutorService.prepare(orgId, req.params.id)); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

// POST /api/actions/:id/execute — ADR-152 F2.2: executor governado no modo
// EXECUTE. 3 guardas obrigatórias (autonomy=execute + execution_mode≥approved
// + policy=approved). Nesta fatia, handlers são NO-OP; a 2.3 pluga efeitos
// reais. Falha nas guardas retorna 400 auditado.
router.post("/:id/execute", async (req: AuthRequest, res): Promise<any> => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  if (!["owner", "admin"].includes(req.user?.role)) return res.status(403).json({ error: "Apenas gestores podem executar." });
  // ADR-159 F6 (D6) — step-up MFA em ação crítica/financeira acima do limiar.
  // Só a rota HUMANA passa aqui; os reroutes F2 chamam execute() direto (isentos).
  const act = DecisionActionService.get(orgId, req.params.id);
  if (act && StepUpMfaService.requiresStepUp(orgId, act)) {
    try { StepUpMfaService.assertVerified(orgId, req.user?.userId, req.body?.mfaToken); }
    catch (e: any) { return res.status(e?.code === "STEP_UP_LOCKED" ? 429 : 401).json({ error: e.message, mfaRequired: true, code: e?.code }); }
  }
  try { res.json(await CommandExecutorService.execute(orgId, req.params.id)); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

// GET /api/actions/:id/executions — trilha de execução (auditoria).
router.get("/:id/executions", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json({ executions: CommandExecutorService.executions(orgId, req.params.id) });
});

// GET /api/actions/:id/outcomes — outcomes medidos de uma ação.
router.get("/:id/outcomes", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json({ outcomes: OutcomeMeasurementService.forAction(orgId, req.params.id) });
});

// POST /api/actions/:id/outcomes — registra um outcome manual (esperado × realizado).
router.post("/:id/outcomes", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const b = req.body || {};
  try {
    res.status(201).json(OutcomeMeasurementService.record(orgId, req.params.id, {
      expectedValue: b.expectedValue, realizedValue: b.realizedValue, basis: b.basis,
      measurementMethod: b.measurementMethod, attributionWindowDays: b.attributionWindowDays, evidence: b.evidence,
      interventionCost: b.interventionCost, confidence: b.confidence,
    }));
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

export default router;
