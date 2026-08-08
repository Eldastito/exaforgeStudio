import { Router, Response, NextFunction } from "express";
import { AuthRequest } from "../middleware/auth.js";
import { MASTER_ADMIN_EMAIL } from "../config/secret.js";
import db from "../db.js";
import { ProcessRuntimeService } from "../ProcessRuntimeService.js";
import { RuntimeExceptionsService } from "../RuntimeExceptionsService.js";
import { OutcomeMeasurementService } from "../OutcomeMeasurementService.js";
import { RetailClosingPlaybookService } from "../RetailClosingPlaybook.js";
import { CollectionPlaybookService } from "../CollectionPlaybook.js";
import { SalesRecoveryPlaybookService } from "../SalesRecoveryPlaybook.js";
import { BusinessSignalService } from "../BusinessSignalService.js";

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

// ADR-155 F4.2 — clientes em risco de churn (sinais abertos do ChurnRiskDetector
// F4.1). Advisory (RN-014): o card mostra score + explicabilidade; o humano
// decide acknowledge (vou cuidar) ou dismiss (não é risco).
router.get("/operations/churn", (req: AuthRequest, res): any => {
  const signals = BusinessSignalService.list(req.organizationId!, { status: "open", domain: "churn" })
    .filter((s: any) => s.signal_type === "churn_risk_high");
  res.json({ signals });
});
router.post("/operations/churn/:id/:action", (req: AuthRequest, res): any => {
  const { id, action } = req.params;
  if (action !== "acknowledge" && action !== "dismiss") return res.status(400).json({ error: "ação inválida (acknowledge|dismiss)." });
  const r = action === "acknowledge"
    ? BusinessSignalService.acknowledge(req.organizationId!, id)
    : BusinessSignalService.dismiss(req.organizationId!, id);
  res.json(r);
});

// ADR-155 — KPIs de copy calibrada (A/B de cobrança F2.3 + recuperação F3.2) +
// programa de indicação (F6). São sinais `info` upsertados por query (um por org
// por tipo), publicados pelos *MeasurementService no Scheduler. SÓ LEITURA: um
// KPI não se "resolve" (diferente do churn, que é advisory acionável) — a UI só
// mostra o placar vivo pro dono acompanhar o que a copy calibrada está rendendo.
router.get("/operations/kpis", (req: AuthRequest, res): any => {
  const TYPES = new Set(["collection_ab_result", "sales_recovery_ab_result", "referral_program_result"]);
  const signals = BusinessSignalService.list(req.organizationId!, { status: "open" })
    .filter((s: any) => TYPES.has(s.signal_type));
  res.json({ signals });
});

// ADR-155 — série temporal do A/B (control × calibrada) pro gráfico da aba
// Operações. `kind` = collection | sales_recovery. Só leitura (snapshots).
router.get("/operations/kpi-trend", async (req: AuthRequest, res): Promise<any> => {
  const kind = req.query.kind === "sales_recovery" ? "sales_recovery" : "collection";
  const days = req.query.days ? Number(req.query.days) : 30;
  const { AbTrendService } = await import("../AbTrendService.js");
  res.json(AbTrendService.series(req.organizationId!, kind, { days }));
});

// ── Piloto F4a: Retail Closing ────────────────────────────────────────────

// Seed idempotente do playbook `retail_daily_closing_v1` na org. Master admin
// entra sempre (via runtimeGate); demais precisam de RBAC do módulo runtime.
router.post("/retail-closing/seed", (req: AuthRequest, res): any => {
  try { res.json(RetailClosingPlaybookService.seed(req.organizationId!, actorId(req))); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

// Inicia um fechamento (storeId + date). Delega dedupe conservador ao
// ProcessRuntimeService (se já existe instance viva pro par, devolve).
router.post("/retail-closing/start", (req: AuthRequest, res): any => {
  const b = req.body || {};
  if (typeof b.storeId !== "string" || typeof b.date !== "string") return res.status(400).json({ error: "storeId e date (YYYY-MM-DD) são obrigatórios." });
  try { res.json(RetailClosingPlaybookService.start(req.organizationId!, { storeId: b.storeId, date: b.date, tolerancePct: b.tolerancePct }, actorId(req))); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

// ── Piloto F4b: Cobrança MVP ──────────────────────────────────────────────

// Seed idempotente do playbook `receivable_collection_v1` na org. Mesma
// governança do F4a (runtimeGate + RBAC do módulo runtime).
router.post("/collection/seed", (req: AuthRequest, res): any => {
  try { res.json(CollectionPlaybookService.seed(req.organizationId!, actorId(req))); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

// Inicia uma cobrança pro receivable (payload composto: receivableId,
// phone, channelId, customerId Asaas, amount, dueDate). Dedupe por subject
// vivo (ProcessRuntimeService.startForSubject) impede cobrança dupla no
// mesmo receivable.
router.post("/collection/start", (req: AuthRequest, res): any => {
  const b = req.body || {};
  if (typeof b.receivableId !== "string") return res.status(400).json({ error: "receivableId (string) obrigatório." });
  if (typeof b.phone !== "string") return res.status(400).json({ error: "phone (string) obrigatório." });
  if (typeof b.channelId !== "string") return res.status(400).json({ error: "channelId (string) obrigatório." });
  if (typeof b.customerId !== "string") return res.status(400).json({ error: "customerId (string, Asaas) obrigatório." });
  if (typeof b.dueDate !== "string") return res.status(400).json({ error: "dueDate (YYYY-MM-DD) obrigatório." });
  if (!(Number(b.amount) > 0)) return res.status(400).json({ error: "amount > 0 obrigatório." });
  try {
    res.json(CollectionPlaybookService.start(req.organizationId!, {
      receivableId: b.receivableId, contactId: b.contactId, phone: b.phone,
      channelId: b.channelId, customerId: b.customerId,
      amount: Number(b.amount), dueDate: b.dueDate,
      description: b.description, messageTemplate: b.messageTemplate,
      confirmationDeadline: b.confirmationDeadline,
    }, actorId(req)));
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

// ── Piloto F4c: Recuperação Comercial ─────────────────────────────────────

// Seed idempotente do playbook `sales_recovery_v1` na org.
router.post("/sales-recovery/seed", (req: AuthRequest, res): any => {
  try { res.json(SalesRecoveryPlaybookService.seed(req.organizationId!, actorId(req))); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

// Detecção manual: varre deals parados + cria propostas (padrão do
// Scheduler.salesRecoveryDetectionPass). Útil pro "Detectar agora" na UI.
router.post("/sales-recovery/detect", async (req: AuthRequest, res): Promise<any> => {
  const b = req.body || {};
  const stalledDays = b.stalledDays != null ? Number(b.stalledDays) : undefined;
  const limit = b.limit != null ? Number(b.limit) : undefined;
  try { res.json(await SalesRecoveryPlaybookService.detectAndProposeAll(req.organizationId!, { stalledDays, limit })); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

// Lista propostas em aberto pra UI.
router.get("/sales-recovery/proposals", (req: AuthRequest, res): any => {
  const limit = req.query.limit ? Number(req.query.limit) : undefined;
  try { res.json({ items: SalesRecoveryPlaybookService.listOpenProposals(req.organizationId!, { limit }) }); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

// F4c.5 — Métricas agregadas do painel Recuperação.
router.get("/sales-recovery/metrics", (req: AuthRequest, res): any => {
  try { res.json(SalesRecoveryPlaybookService.metrics(req.organizationId!)); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

// F4c.5 — Últimos touches (envios aprovados) com status de reply.
router.get("/sales-recovery/touches", (req: AuthRequest, res): any => {
  const limit = req.query.limit ? Number(req.query.limit) : undefined;
  try { res.json({ items: SalesRecoveryPlaybookService.listTouches(req.organizationId!, { limit }) }); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

// F4c.5 — Últimas atribuições de revenue (F4c.4).
router.get("/sales-recovery/attributions", (req: AuthRequest, res): any => {
  const limit = req.query.limit ? Number(req.query.limit) : undefined;
  const windowDays = req.query.window ? Number(req.query.window) : undefined;
  try { res.json({ items: SalesRecoveryPlaybookService.listAttributions(req.organizationId!, { limit, windowDays }) }); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

// APROVAÇÃO HUMANA — o dono revisa a proposta e clica "aprovar" (com ou
// sem editar o texto). AQUI é onde a mensagem sai. G-4c-1: sem esta rota
// batida, NADA é enviado pelo Runtime.
router.post("/sales-recovery/proposals/:id/approve", async (req: AuthRequest, res): Promise<any> => {
  const b = req.body || {};
  const messageOverride = typeof b.messageOverride === "string" ? b.messageOverride : undefined;
  try { res.json(await SalesRecoveryPlaybookService.approve(req.organizationId!, req.params.id, { messageOverride, actorId: actorId(req) })); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

// DISPENSA — dono descarta sem enviar. Registra motivo pra audit.
router.post("/sales-recovery/proposals/:id/dismiss", (req: AuthRequest, res): any => {
  const b = req.body || {};
  const reason = typeof b.reason === "string" ? b.reason.slice(0, 500) : undefined;
  try { res.json(SalesRecoveryPlaybookService.dismiss(req.organizationId!, req.params.id, { reason, actorId: actorId(req) })); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

// Runner: roda o playbook até completar / falhar / esperar externo.
// Idempotente (o próprio runStep respeita FSM + o executor de step é
// governado). Útil pro Scheduler futuro e pro botão "Rodar agora".
router.post("/instances/:id/run", async (req: AuthRequest, res): Promise<any> => {
  try { res.json(await ProcessRuntimeService.runToCompletion(req.organizationId!, req.params.id, { actor: actorId(req) })); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

export default router;
