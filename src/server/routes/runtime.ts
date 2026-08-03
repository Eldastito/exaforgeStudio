import { Router, Response, NextFunction } from "express";
import { AuthRequest } from "../middleware/auth.js";
import { MASTER_ADMIN_EMAIL } from "../config/secret.js";
import db from "../db.js";
import { ProcessRuntimeService } from "../ProcessRuntimeService.js";
import { RuntimeExceptionsService } from "../RuntimeExceptionsService.js";
import { OutcomeMeasurementService } from "../OutcomeMeasurementService.js";

/**
 * Rotas do Execution Runtime (ADR-152 F1.1). Duas camadas de gate:
 *
 *   (a) `runtimeGate` — flag opt-in `organization_settings.execution_runtime_
 *       enabled` (default 0). Master Admin entra sempre (mesmo racional do
 *       falatuGate). Org sem flag: 403.
 *   (b) RBAC granular do módulo `runtime` — aplicado GLOBALMENTE pelo
 *       `enforceModulePermission` do `protectedApi` a partir do 1º segmento
 *       (/runtime → módulo `runtime`, via `ROUTE_MODULE` no PermissionService).
 *
 * A rota valida FORMA; invariantes de negócio ficam no service (convenção
 * do repo). Auditoria: o service já loga `RUNTIME_*` em cada operação.
 */

export const runtimeGate = (req: AuthRequest, res: Response, next: NextFunction): any => {
  if (req.user?.email && req.user.email === MASTER_ADMIN_EMAIL) return next();
  const orgId = req.organizationId!;
  const row = db.prepare(`SELECT execution_runtime_enabled FROM organization_settings WHERE organization_id = ?`).get(orgId) as any;
  if (!Number(row?.execution_runtime_enabled)) {
    return res.status(403).json({ error: "Execution Runtime não está habilitado para esta organização." });
  }
  next();
};

const router = Router();
router.use(runtimeGate);

const actorId = (req: any) => req.user?.userId || req.user?.id;

// ── Definitions ──────────────────────────────────────────────────────────

router.post("/definitions", (req: AuthRequest, res): any => {
  const b = req.body || {};
  if (typeof b.processType !== "string" || typeof b.name !== "string") {
    return res.status(400).json({ error: "processType e name (string) são obrigatórios." });
  }
  if (b.steps == null || typeof b.steps !== "object") {
    return res.status(400).json({ error: "steps (definição do playbook) obrigatória." });
  }
  try {
    res.json(ProcessRuntimeService.defineProcess(req.organizationId!, b, actorId(req)));
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.get("/definitions", (req: AuthRequest, res): any => {
  const processType = typeof req.query.processType === "string" ? req.query.processType : undefined;
  const includeInactive = req.query.includeInactive === "1" || req.query.includeInactive === "true";
  res.json(ProcessRuntimeService.listDefinitions(req.organizationId!, { processType, includeInactive }));
});

router.get("/definitions/:id", (req: AuthRequest, res): any => {
  const d = ProcessRuntimeService.getDefinition(req.organizationId!, req.params.id);
  if (!d) return res.status(404).json({ error: "Definição não encontrada." });
  res.json(d);
});

router.post("/definitions/:id/active", (req: AuthRequest, res): any => {
  if (typeof req.body?.active !== "boolean") return res.status(400).json({ error: "active (boolean) é obrigatório." });
  try { res.json(ProcessRuntimeService.setActive(req.organizationId!, req.params.id, req.body.active, actorId(req))); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

// ── Instances ────────────────────────────────────────────────────────────

router.post("/instances", (req: AuthRequest, res): any => {
  const b = req.body || {};
  if (typeof b.processType !== "string") return res.status(400).json({ error: "processType obrigatório." });
  try {
    if (typeof b.signalId === "string" && b.signalId) {
      res.json(ProcessRuntimeService.startFromSignal(req.organizationId!, b.signalId, b, actorId(req)));
    } else {
      res.json(ProcessRuntimeService.startForSubject(req.organizationId!, b, actorId(req)));
    }
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.get("/instances", (req: AuthRequest, res): any => {
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  const processType = typeof req.query.processType === "string" ? req.query.processType : undefined;
  const subjectType = typeof req.query.subjectType === "string" ? req.query.subjectType : undefined;
  const subjectId = typeof req.query.subjectId === "string" ? req.query.subjectId : undefined;
  const limit = req.query.limit ? Number(req.query.limit) : undefined;
  res.json(ProcessRuntimeService.listInstances(req.organizationId!, { status, processType, subjectType, subjectId, limit }));
});

router.get("/instances/:id", (req: AuthRequest, res): any => {
  const inst = ProcessRuntimeService.getInstance(req.organizationId!, req.params.id);
  if (!inst) return res.status(404).json({ error: "Instância não encontrada." });
  const transitions = ProcessRuntimeService.listTransitions(req.organizationId!, req.params.id);
  res.json({ ...inst, transitions });
});

router.post("/instances/:id/advance", (req: AuthRequest, res): any => {
  try { res.json(ProcessRuntimeService.advance(req.organizationId!, req.params.id)); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

// Só usado pelo executor (Fase 2). Nesta fatia fica disponível para testes/
// depuração e para o dono poder simular a conclusão de um step manualmente.
router.post("/instances/:id/complete-step", (req: AuthRequest, res): any => {
  const b = req.body || {};
  try {
    res.json(ProcessRuntimeService.completeStep(req.organizationId!, req.params.id, {
      stepResult: b.stepResult,
      success: b.success,
      evidence: b.evidence,
      actor: actorId(req),
    }));
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.post("/instances/:id/cancel", (req: AuthRequest, res): any => {
  try { res.json(ProcessRuntimeService.cancel(req.organizationId!, req.params.id, { actor: actorId(req), reason: req.body?.reason })); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

// Transição livre — necessária pra rota administrativa/depuração e pra rota
// da Fase 2 do executor. FSM validada no service (transição inválida → 400).
router.post("/instances/:id/transition", (req: AuthRequest, res): any => {
  const b = req.body || {};
  if (typeof b.toState !== "string") return res.status(400).json({ error: "toState obrigatório." });
  try {
    res.json(ProcessRuntimeService.transition(req.organizationId!, req.params.id, b.toState, {
      actor: actorId(req), reason: b.reason, evidence: b.evidence, stepResult: b.stepResult,
    }));
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

// ── Operations (Fatia 3.1) — alimentam a aba Operações da Fatia 3.2 ──
router.get("/operations/overview", (req: AuthRequest, res): any => {
  res.json(RuntimeExceptionsService.overview(req.organizationId!));
});
router.get("/operations/exceptions", (req: AuthRequest, res): any => {
  const limit = req.query.limit ? Number(req.query.limit) : undefined;
  res.json({
    total: RuntimeExceptionsService.count(req.organizationId!).total,
    exceptions: RuntimeExceptionsService.list(req.organizationId!, { limit }),
  });
});
router.get("/operations/indicators", (req: AuthRequest, res): any => {
  res.json(RuntimeExceptionsService.indicators(req.organizationId!));
});
// Ledger unificado com categorias (F3.1). Alimenta "Concluído hoje".
router.get("/operations/ledger", (req: AuthRequest, res): any => {
  const domain = typeof req.query.domain === "string" ? req.query.domain : undefined;
  const limit = req.query.limit ? Number(req.query.limit) : undefined;
  res.json(OutcomeMeasurementService.ledger(req.organizationId!, { domain, limit }));
});

export default router;
