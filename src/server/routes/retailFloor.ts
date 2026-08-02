/**
 * Retail Floor — API (ADR-150). Montada em /api/retail-floor, gated pelo módulo
 * `retail_floor` (ModuleService.MODULE_BY_ROUTE["retail-floor"]). Fatia 1:
 * contexto por escopo + settings. Fatia 2: turno + lista da vez (posição
 * derivada). As fatias seguintes acrescentam atendimento, scan, conciliação e
 * analytics.
 */
import { Router } from "express";
import { AuthRequest, requireRole } from "../middleware/auth.js";
import { RetailFloorService, RetailFloorSettingsService } from "../RetailFloorService.js";
import { RetailFloorShiftService, RetailFloorQueueService } from "../RetailFloorShiftService.js";
import { RetailFloorAttendanceService } from "../RetailFloorAttendanceService.js";
import { RetailFloorScanService } from "../RetailFloorScanService.js";
import { RetailFloorReconciliationService } from "../RetailFloorReconciliationService.js";
import { RetailFloorSignalPublisher } from "../RetailFloorSignalPublisher.js";
import { RetailFloorAnalyticsService, RetailFloorNetworkAnalytics } from "../RetailFloorAnalyticsService.js";
import { RetailFloorDigestService } from "../RetailFloorDigestService.js";

const router = Router();
const actor = (req: any) => req.user?.userId || req.user?.id;

// Converte o erro padronizado de escopo (RN-150-005) em 403; o resto é 400.
const fail = (res: any, e: any) => {
  const msg = e?.message || "Requisição inválida";
  res.status(msg === "store_scope_denied" ? 403 : 400).json({ error: msg });
};

// Contexto do usuário no módulo (qualquer papel — o escopo é resolvido dentro).
router.get("/context", (req: AuthRequest, res) => {
  try {
    res.json(RetailFloorService.context(req.organizationId!, req.user));
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "Erro ao montar contexto" });
  }
});

// Settings da org (globais ao módulo) — só owner/admin configuram.
router.get("/settings", requireRole("owner", "admin"), (req: AuthRequest, res) => {
  try {
    res.json(RetailFloorSettingsService.get(req.organizationId!));
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "Erro ao ler settings" });
  }
});

router.put("/settings", requireRole("owner", "admin"), (req: AuthRequest, res) => {
  try {
    res.json(RetailFloorSettingsService.update(req.organizationId!, req.body || {}, actor(req)));
  } catch (e: any) {
    res.status(400).json({ error: e?.message || "Settings inválidas" });
  }
});

// ---- Fatia 2: turno + lista da vez ----

// Abre o turno da loja (gestor da loja — RN-150-005).
router.post("/shifts", (req: AuthRequest, res) => {
  try {
    const storeId = String(req.body?.storeId || "");
    if (!storeId) return res.status(400).json({ error: "storeId é obrigatório" });
    res.json(RetailFloorShiftService.open(req.organizationId!, storeId, req.user));
  } catch (e: any) { fail(res, e); }
});

// Fecha o turno (gestor da loja).
router.post("/shifts/:id/close", (req: AuthRequest, res) => {
  try {
    res.json(RetailFloorShiftService.close(req.organizationId!, req.params.id, req.user));
  } catch (e: any) { fail(res, e); }
});

// Turno aberto da loja + lista da vez ordenada (qualquer papel — é o Kanban).
router.get("/shifts/current", (req: AuthRequest, res) => {
  try {
    const storeId = String(req.query.storeId || "");
    if (!storeId) return res.status(400).json({ error: "storeId é obrigatório" });
    const shift = RetailFloorShiftService.currentForStore(req.organizationId!, storeId);
    if (!shift) return res.json({ shift: null, queue: null });
    res.json({ shift, queue: RetailFloorQueueService.ordered(req.organizationId!, shift.id) });
  } catch (e: any) { fail(res, e); }
});

// Entra na lista da vez (o próprio vendedor; gestor pode adicionar terceiro).
router.post("/queue/join", (req: AuthRequest, res) => {
  try {
    const storeId = String(req.body?.storeId || "");
    if (!storeId) return res.status(400).json({ error: "storeId é obrigatório" });
    res.json(RetailFloorQueueService.join(req.organizationId!, { storeId, sellerId: req.body?.sellerId || null }, req.user));
  } catch (e: any) { fail(res, e); }
});

// Muda status na fila (próprio: waiting|break|unavailable|offline; gestor: + skipped).
router.post("/queue/:sellerId/status", (req: AuthRequest, res) => {
  try {
    const storeId = String(req.body?.storeId || "");
    if (!storeId) return res.status(400).json({ error: "storeId é obrigatório" });
    res.json(RetailFloorQueueService.setStatus(req.organizationId!, { storeId, sellerId: req.params.sellerId, status: String(req.body?.status || "") }, req.user));
  } catch (e: any) { fail(res, e); }
});

// ---- Fatia 3: atendimento (cronômetro server-side) ----

// Inicia atendimento (self quando é o próximo; gestor pode override — auditado).
router.post("/attendances/start", (req: AuthRequest, res) => {
  try {
    const storeId = String(req.body?.storeId || "");
    if (!storeId) return res.status(400).json({ error: "storeId é obrigatório" });
    res.json(RetailFloorAttendanceService.start(req.organizationId!, { storeId, sellerId: req.body?.sellerId || null }, req.user));
  } catch (e: any) { fail(res, e); }
});

// Encerra com desfecho (converted → conciliação pendente, RN-150-004;
// not_converted exige motivo hierárquico — Fatia 4; returnTo waiting|break).
router.post("/attendances/:id/finish", (req: AuthRequest, res) => {
  try {
    res.json(RetailFloorAttendanceService.finish(req.organizationId!, req.params.id, {
      outcome: String(req.body?.outcome || ""),
      reason: req.body?.reason ?? null,
      returnTo: req.body?.returnTo ?? null,
      declaredValue: req.body?.declaredValue ?? null,
      declaredPieces: req.body?.declaredPieces ?? null,
      notes: req.body?.notes || null,
    }, req.user));
  } catch (e: any) { fail(res, e); }
});

// Atendimentos ativos da loja com tempo decorrido derivado (Kanban).
router.get("/attendances/active", (req: AuthRequest, res) => {
  try {
    const storeId = String(req.query.storeId || "");
    if (!storeId) return res.status(400).json({ error: "storeId é obrigatório" });
    res.json({ attendances: RetailFloorAttendanceService.active(req.organizationId!, storeId) });
  } catch (e: any) { fail(res, e); }
});

// ---- Fatia 5: scan no atendimento + demanda não atendida ----

// Bipa um EAN dentro do atendimento ativo (congela estoque + carimbo de sync).
router.post("/attendances/:id/scan", (req: AuthRequest, res) => {
  try {
    const ean = String(req.body?.ean || "");
    if (!ean) return res.status(400).json({ error: "ean é obrigatório" });
    res.json(RetailFloorScanService.scan(req.organizationId!, req.params.id, ean, { action: req.body?.action ?? null }, req.user));
  } catch (e: any) { fail(res, e); }
});

// Demanda por input do vendedor (faltou tamanho/cor/categoria) — exige scanId.
router.post("/attendances/:id/unmet-demand", (req: AuthRequest, res) => {
  try {
    res.json(RetailFloorScanService.registerUnmet(req.organizationId!, req.params.id, {
      scanId: String(req.body?.scanId || ""),
      reason: String(req.body?.reason || ""),
      size: req.body?.size ?? null,
      color: req.body?.color ?? null,
      categoryLabel: req.body?.categoryLabel ?? null,
    }, req.user));
  } catch (e: any) { fail(res, e); }
});

// Timeline de consultas do atendimento.
router.get("/attendances/:id/scans", (req: AuthRequest, res) => {
  try {
    res.json({ scans: RetailFloorScanService.scans(req.organizationId!, req.params.id) });
  } catch (e: any) { fail(res, e); }
});

// ---- Fatia 6: conciliação declarado × PDV ----

// Resumo do dia (painel do gerente): estados + declarado × ERP + gap.
router.get("/reconciliation", (req: AuthRequest, res) => {
  try {
    const storeId = String(req.query.storeId || "");
    const date = String(req.query.date || "");
    if (!storeId || !date) return res.status(400).json({ error: "storeId e date são obrigatórios" });
    res.json(RetailFloorReconciliationService.summary(req.organizationId!, storeId, date));
  } catch (e: any) { fail(res, e); }
});

// Roda a conciliação do dia sob demanda (gestor da loja).
router.post("/reconciliation/run", (req: AuthRequest, res) => {
  try {
    const storeId = String(req.body?.storeId || "");
    const date = String(req.body?.date || "");
    if (!storeId || !date) return res.status(400).json({ error: "storeId e date são obrigatórios" });
    RetailFloorService.assertStoreManager(req.organizationId!, req.user, storeId);
    res.json(RetailFloorReconciliationService.runDay(req.organizationId!, storeId, date, actor(req)));
  } catch (e: any) { fail(res, e); }
});

// Override manual (gestor): força confirmed|unmatched — auditado.
router.post("/reconciliation/:attendanceId/state", (req: AuthRequest, res) => {
  try {
    res.json(RetailFloorReconciliationService.override(req.organizationId!, req.params.attendanceId, String(req.body?.state || ""), req.user));
  } catch (e: any) { fail(res, e); }
});

// ---- Fatia 8: sinais pro Orquestrador (sob demanda; o Scheduler roda por hora) ----
// Sem requireRole de propósito: é um recompute idempotente de fatos (dedupe no
// ledger) e a resposta só traz a contagem — não expõe dado além do gate do módulo.
router.post("/signals/scan", (req: AuthRequest, res) => {
  try {
    const date = req.body?.date ? String(req.body.date) : undefined;
    res.json(RetailFloorSignalPublisher.sweep(req.organizationId!, date));
  } catch (e: any) { fail(res, e); }
});

// ---- Fatia 9: indicadores da loja (gestor — RN-150-005) ----
router.get("/analytics/store", (req: AuthRequest, res) => {
  try {
    const storeId = String(req.query.storeId || "");
    const start = String(req.query.start || "");
    const end = String(req.query.end || "");
    if (!storeId || !start || !end) return res.status(400).json({ error: "storeId, start e end são obrigatórios" });
    RetailFloorService.assertStoreManager(req.organizationId!, req.user, storeId);
    res.json(RetailFloorAnalyticsService.store(req.organizationId!, storeId, start, end));
  } catch (e: any) { fail(res, e); }
});

// ---- Fatia 10 (pós-piloto): comparativo de rede + preview do resumo diário ----

// Rede inteira lado a lado — visão regional, só owner/admin.
router.get("/analytics/network", requireRole("owner", "admin"), (req: AuthRequest, res) => {
  try {
    const start = String(req.query.start || "");
    const end = String(req.query.end || "");
    if (!start || !end) return res.status(400).json({ error: "start e end são obrigatórios" });
    res.json(RetailFloorNetworkAnalytics.network(req.organizationId!, start, end));
  } catch (e: any) { fail(res, e); }
});

// Preview do resumo diário (gestor da loja confere o texto antes de opt-in).
router.get("/digest/preview", (req: AuthRequest, res) => {
  try {
    const storeId = String(req.query.storeId || "");
    const date = String(req.query.date || new Date().toISOString().slice(0, 10));
    if (!storeId) return res.status(400).json({ error: "storeId é obrigatório" });
    RetailFloorService.assertStoreManager(req.organizationId!, req.user, storeId);
    res.json({ message: RetailFloorDigestService.buildMessage(req.organizationId!, storeId, date) });
  } catch (e: any) { fail(res, e); }
});

export default router;
