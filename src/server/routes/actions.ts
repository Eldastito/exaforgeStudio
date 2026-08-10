import { Router } from "express";
import { AuthRequest } from "../middleware/auth.js";
import { DecisionActionService } from "../DecisionActionService.js";
import { OutcomeMeasurementService } from "../OutcomeMeasurementService.js";
import { CommandExecutorService } from "../CommandExecutorService.js";
import { StepUpMfaService } from "../StepUpMfaService.js";

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

// GET /api/actions/ledger — Impact Ledger unificado (esperado × realizado).
// Precisa vir ANTES de /:id para não ser capturada como id="ledger".
router.get("/ledger", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const domain = typeof req.query?.domain === "string" ? req.query.domain : undefined;
  res.json(OutcomeMeasurementService.ledger(orgId, { domain }));
});

router.get("/:id", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const a = DecisionActionService.get(orgId, req.params.id);
  if (!a) return res.status(404).json({ error: "Ação não encontrada." });
  res.json(a);
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
    }));
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

export default router;
