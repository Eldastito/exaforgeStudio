/**
 * Retail Ops — API (ADR-083). Montada em /api/retailops, gated pelo módulo
 * `retail` (ModuleService.MODULE_BY_ROUTE["retailops"]). Fase A: cadastro de
 * lojas. Fases seguintes acrescentam cotas, fechamentos, tarefas, etc.
 */
import { Router } from "express";
import db from "../db.js";
import multer from "multer";
import sharp from "sharp";
import fs from "fs";
import path from "path";
import { randomUUID } from "node:crypto";
import { AuthRequest, requireRole } from "../middleware/auth.js";
import { RetailStoreService } from "../RetailStoreService.js";
import { RetailStoreCostService, FIXED_COST_CATEGORIES, VARIABLE_COST_CATEGORIES } from "../RetailStoreCostService.js";
import { RetailQuotaService, RetailClosingService, RetailTaskService, RetailResponsibleService } from "../RetailOpsService.js";
import { RetailBoletaService } from "../RetailBoletaService.js";
import { BusinessTimeService } from "../BusinessTimeService.js";
import { RetailSellerDirectoryService } from "../RetailSellerDirectoryService.js";
import { RetailPosFeeService } from "../RetailPosFeeService.js";
import { RetailPdvCatalogResolver } from "../RetailPdvCatalogResolver.js";
import { RetailAnalyticsCache } from "../RetailAnalyticsCache.js";
import { RetailFeatureFlagService, type RetailFlagKey } from "../RetailFeatureFlagService.js";
import { RetailInventoryService } from "../RetailInventoryService.js";
import { RetailTransferService } from "../RetailTransferService.js";
import { RetailCommissionService } from "../RetailCommissionService.js";
import { RetailCommissionRaceService } from "../RetailCommissionRaceService.js";
import { RetailScheduleTemplateService } from "../RetailScheduleTemplateService.js";
import { RetailMonthWeeksService } from "../RetailMonthWeeksService.js";
import { RetailCardAcquirerService } from "../RetailCardAcquirerService.js";
import { RetailPdvCustomerService } from "../RetailPdvCustomerService.js";
import { RetailStockPolicyService } from "../RetailStockPolicyService.js";
import { RetailStoreScopeService } from "../RetailStoreScopeService.js";
import { ManagerSolutionService } from "../ManagerSolutionService.js";
import { ManagerSolutionRetrievalService } from "../ManagerSolutionRetrievalService.js";
import { RetailSellerSalesService } from "../RetailSellerSalesService.js";
import { RetailDashboardService } from "../RetailDashboardService.js";
import { RetailActivationService } from "../RetailActivationService.js";
import { RetailImpactService } from "../RetailImpactService.js";
import { RetailStockModeService } from "../RetailStockModeService.js";
import { RetailGraduationService } from "../RetailGraduationService.js";
import { RetailAdoptionService } from "../RetailAdoptionService.js";
import { RetailDiagnosticService } from "../RetailDiagnosticService.js";
import { RetailReconciliationService } from "../RetailReconciliationService.js";
import { RetailPdvSaleLinesService } from "../RetailPdvSaleLinesService.js";
import { RetailScanService } from "../RetailScanService.js";
import { RetailReceivingService } from "../RetailReceivingService.js";
import { RetailRevenueBridgeService } from "../RetailRevenueBridgeService.js";
import { RetailPatternMemoryService } from "../RetailPatternMemoryService.js";
import { RetailOnlineReserveService } from "../RetailOnlineReserveService.js";
import { RetailOpsSignalPublisher } from "../RetailOpsSignalPublisher.js";
import { ImpactPrioritizationService } from "../ImpactPrioritizationService.js";
import { BusinessSignalService } from "../BusinessSignalService.js";
import { DecisionActionService } from "../DecisionActionService.js";
import { isAIConfigured } from "../llm.js";
import { RetailPricingService } from "../RetailPricingService.js";

const router = Router();

const csvUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

const today = (req: AuthRequest) => String(req.query.date || new Date().toISOString().slice(0, 10));

/**
 * Envelope de erro das telas analíticas (PDR TOULON, Fatia 4C / PERF-006/007).
 * A tela precisa DISTINGUIR timeout (retryável) de erro do servidor de "lista
 * vazia" — nunca traduzir falha HTTP em "nenhuma loja com dados" (AC-13/14).
 * `SQLITE_BUSY`/`SQLITE_LOCKED` (contenção além do busy_timeout) é o timeout
 * REAL de uma consulta síncrona → 503 `analytics_timeout` retryável; qualquer
 * outra exceção → 500 `analytics_error` não-retryável. Sempre com correlationId.
 */
function analyticsError(res: any, err: any): any {
  const correlationId = randomUUID();
  const code = String(err?.code || "");
  const isBusy = code === "SQLITE_BUSY" || code === "SQLITE_LOCKED" || code.startsWith("SQLITE_BUSY");
  if (isBusy) {
    return res.status(503).json({
      error: "analytics_timeout",
      message: "A consulta excedeu o tempo esperado.",
      correlationId,
      retryable: true,
    });
  }
  // Loga o detalhe no servidor (correlacionável); NÃO vaza a mensagem crua.
  try { console.error(`[retail-analytics] ${correlationId}`, err?.message || err); } catch { /* noop */ }
  return res.status(500).json({
    error: "analytics_error",
    message: "Não foi possível calcular agora. Tente novamente.",
    correlationId,
    retryable: false,
  });
}

/**
 * Serve uma leitura analítica com cache curto por (org, chave) — PERF-005.
 * Miss → computa, guarda e devolve; erro → envelope distinto (PERF-006/007).
 */
function analyticsCached(res: any, orgId: string, key: string, compute: () => any): any {
  const cached = RetailAnalyticsCache.get(orgId, key);
  if (cached !== undefined) return res.json(cached);
  try {
    const value = compute();
    RetailAnalyticsCache.set(orgId, key, value);
    return res.json(value);
  } catch (e: any) {
    return analyticsError(res, e);
  }
}

// --- Ponte Fechamento → Faturamento (opt-in): estado + liga/desliga ---
// Quando ligada, os fechamentos de loja aprovados/conciliados viram entrada de
// caixa/receita — o Diretor IA / Pareto / DRE passam a enxergar o faturamento.
router.get("/revenue-bridge", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json({ enabled: RetailRevenueBridgeService.isEnabled(orgId) });
});

router.put("/revenue-bridge", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const enabled = RetailRevenueBridgeService.setEnabled(orgId, !!req.body?.enabled);
  res.json({ ok: true, enabled });
});

// --- Memória de Padrões do Varejo (ADR-142 Fatia 1): estado + lista + passe ---
router.get("/patterns", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json({
    enabled: RetailPatternMemoryService.isEnabled(orgId),
    patterns: RetailPatternMemoryService.list(orgId, { status: req.query.status ? String(req.query.status) : undefined }),
    typeStats: RetailPatternMemoryService.allTypeStats(orgId),
  });
});

// Desfecho de uma ação sobre um padrão (fecha o loop — ADR-142 Fatia 3).
router.post("/patterns/:id/outcome", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const r = RetailPatternMemoryService.recordOutcome(orgId, req.params.id, { outcome: req.body?.outcome, realizedImpact: req.body?.realizedImpact, note: req.body?.note }, (req as any).userId);
  if (!r.ok) return res.status(400).json(r);
  res.json({ ...r, patterns: RetailPatternMemoryService.list(orgId), typeStats: RetailPatternMemoryService.allTypeStats(orgId) });
});

// Analisa as operações e publica sinais p/ o Pareto/Diretor IA (ADR-136).
router.post("/signals/refresh", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json({ ok: true, ...RetailOpsSignalPublisher.run(orgId, { asOf: req.body?.asOf }) });
});

// Insights consolidados da loja: prioridades (o que atacar), padrões aprendidos
// e sinais abertos por severidade. Só leitura — reusa o Pareto e a memória.
router.get("/insights", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const storeId = req.query.storeId ? String(req.query.storeId) : null;
  // Filtro por loja: sinais retail carregam source_entity_type='retail_store' +
  // source_entity_id=<storeId>. IDs desses sinais entram numa `signalWhitelist`
  // pra prioritize considerar só eles quando o dono foca uma loja.
  let signalWhitelist: Set<string> | null = null;
  if (storeId) {
    const rows = db.prepare(
      `SELECT id FROM business_signals
        WHERE organization_id = ? AND status = 'open'
          AND source_entity_type = 'retail_store' AND source_entity_id = ?`
    ).all(orgId, storeId) as any[];
    signalWhitelist = new Set(rows.map((r) => r.id));
  }
  const allPriorities = ImpactPrioritizationService.prioritize(orgId, { globalLimit: 32 })?.global || [];
  const priorities = signalWhitelist ? allPriorities.filter((p: any) => signalWhitelist!.has(p.signalId)) : allPriorities.slice(0, 8);
  const patterns = RetailPatternMemoryService.list(orgId, { status: "validated" });
  const open = BusinessSignalService.list(orgId, { status: "open" });
  const openFiltered = signalWhitelist ? open.filter((s: any) => signalWhitelist!.has(s.id)) : open;
  const bySeverity: Record<string, number> = { critical: 0, risk: 0, attention: 0, info: 0 };
  for (const s of openFiltered) bySeverity[s.severity] = (bySeverity[s.severity] || 0) + 1;
  res.json({ priorities, patterns, openCount: openFiltered.length, bySeverity, storeId });
});

/**
 * Header do "Insights" — grandes números da REDE do dia + top/bottom 3 lojas.
 * Reusa `RetailDashboardService.daily` pros números macro e calcula o ranking
 * de lojas por desvio de cota no dia (top ganhando, bottom mais atrás).
 * Zero storeId = rede toda; com storeId, devolve só os números daquela loja.
 */
router.get("/insights/header", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const date = String(req.query.date || today(req)).slice(0, 10);
  const storeId = req.query.storeId ? String(req.query.storeId) : null;
  const daily = RetailDashboardService.daily(orgId, date);
  // Ranking de lojas do dia (só loja com fechamento não-rejeitado e com cota).
  const rows = db.prepare(
    `SELECT c.store_id, s.name AS store_name, c.informed_total AS realized,
            COALESCE(q.quota_amount, 0) AS quota
       FROM retail_daily_closings c
       JOIN retail_stores s ON s.id = c.store_id AND s.organization_id = c.organization_id
  LEFT JOIN retail_store_quotas q ON q.organization_id = c.organization_id AND q.store_id = c.store_id AND q.quota_date = c.closing_date
      WHERE c.organization_id = ? AND c.closing_date = ? AND c.status != 'rejected'`
  ).all(orgId, date) as any[];
  const scored = rows
    .filter((r) => Number(r.quota) > 0)
    .map((r) => ({
      storeId: r.store_id, storeName: r.store_name,
      realized: Number(r.realized) || 0, quota: Number(r.quota) || 0,
      variancePercent: Math.round(((Number(r.realized) / Number(r.quota)) - 1) * 1000) / 10, // 1 casa
    }))
    .sort((a, b) => b.variancePercent - a.variancePercent);
  const top3 = scored.slice(0, 3);
  const bottom3 = scored.slice(-3).reverse();
  res.json({
    date, storeId, daily, ranking: { top3, bottom3, ranked: scored.length, total: daily.activeStores },
  });
});

// Age a partir de um insight: propõe a AÇÃO recomendada do sinal (kernel C2).
// A política de aprovação decide se já nasce aprovada ou aguardando (nada
// executa sozinho). Retorna a ação criada.
router.post("/insights/act", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const signalId = String(req.body?.signalId || "");
  const sig = db.prepare("SELECT * FROM business_signals WHERE organization_id = ? AND id = ? AND status = 'open'").get(orgId, signalId) as any;
  if (!sig) return res.status(404).json({ error: "Sinal não encontrado ou já resolvido." });
  const action = ImpactPrioritizationService.actionFor(sig.signal_type);
  try {
    const proposed = DecisionActionService.propose(orgId, {
      signalId: sig.id, domain: sig.domain, actionType: action.actionType, title: action.label,
      description: `Ação a partir do sinal ${sig.signal_type}.`,
      expectedImpact: sig.impact_amount != null ? Number(sig.impact_amount) : null, impactUnit: sig.impact_unit || null,
      basis: sig.basis || "estimate", confidence: Number(sig.confidence) || 0.7, createdBy: (req as any).userId || "user",
    });
    // Fase 2: sugestão de transferência da IA vira uma transferência REAL (em
    // trânsito, baixa na origem), ligada ao sinal/ação, e o sinal é resolvido.
    // Falha aqui NÃO derruba a ação já proposta (fica só a recomendação).
    let transfer: any = null;
    if (action.actionType === "retail_transfer") {
      try { transfer = RetailTransferService.fromSignal(orgId, sig.id, req.user?.userId, proposed.id); }
      catch (e: any) { transfer = { error: e?.message || "não foi possível criar a transferência" }; }
    }
    res.status(201).json({ ok: true, action: proposed, transfer });
  } catch (e: any) {
    res.status(400).json({ ok: false, error: e?.message || "Falha ao criar a ação." });
  }
});

// Painel de ações do varejo (as criadas a partir de sinais da operação).
router.get("/insights/actions", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const actions = db.prepare(
    `SELECT a.id, a.title, a.domain, a.action_type, a.status, a.expected_impact, a.impact_unit, a.result_amount, a.created_at, a.approval_policy, a.approval_role
       FROM decision_actions a
       JOIN business_signals s ON s.id = a.signal_id
      WHERE a.organization_id = ? AND s.source_service IN ('RetailOpsSignalPublisher','RetailPatternMemoryService')
      ORDER BY CASE a.status WHEN 'awaiting_approval' THEN 0 WHEN 'approved' THEN 1 WHEN 'done' THEN 2 ELSE 3 END, a.created_at DESC
      LIMIT 50`
  ).all(orgId) as any[];
  res.json({ actions });
});

// --- Loja Virtual → PDV (ADR-143 Fase 0): reserva e-commerce + baixas pendentes ---
router.get("/online-reserve", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json({
    enabled: RetailOnlineReserveService.isEnabled(orgId),
    onlineStoreId: RetailOnlineReserveService.getOnlineStoreId(orgId),
    defaultSellerUserId: RetailOnlineReserveService.getDefaultOnlineSeller(orgId),
    users: db.prepare("SELECT id, name, email FROM users WHERE organization_id = ? AND global_status = 'active' ORDER BY name").all(orgId),
    reserves: RetailOnlineReserveService.listReserves(orgId, req.query.storeId ? String(req.query.storeId) : undefined),
    pending: RetailOnlineReserveService.listPending(orgId, { storeId: req.query.storeId ? String(req.query.storeId) : undefined }),
  });
});

// Vendedor padrão da loja online (comissão das vendas headless). "" = sem.
router.put("/online-reserve/default-seller", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json({ ok: true, defaultSellerUserId: RetailOnlineReserveService.setDefaultOnlineSeller(orgId, req.body?.userId || null) });
});

router.put("/online-reserve/flag", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const enabled = RetailOnlineReserveService.setEnabled(orgId, !!req.body?.enabled);
  // A filial da loja virtual pode ser definida junto (opcional).
  if (req.body?.onlineStoreId !== undefined) RetailOnlineReserveService.setOnlineStoreId(orgId, req.body.onlineStoreId || null);
  res.json({ ok: true, enabled, onlineStoreId: RetailOnlineReserveService.getOnlineStoreId(orgId) });
});

// Define a reserva e-commerce de um produto/variante numa loja.
router.put("/online-reserve/item", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const b = req.body || {};
  if (!b.storeId || !b.productId) return res.status(400).json({ error: "storeId e productId são obrigatórios." });
  const r = RetailOnlineReserveService.setReserve(orgId, String(b.storeId), String(b.productId), b.variantId ?? null, Number(b.qty || 0), (req as any).userId);
  res.json({ ok: true, reserve: r, available: RetailOnlineReserveService.available(orgId, String(b.storeId), String(b.productId), b.variantId ?? null) });
});

// Remove a reserva de um produto/variante numa loja.
router.delete("/online-reserve/item", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const b = req.body || {};
  if (!b.storeId || !b.productId) return res.status(400).json({ error: "storeId e productId são obrigatórios." });
  res.json({ ok: true, ...RetailOnlineReserveService.removeReserve(orgId, String(b.storeId), String(b.productId), b.variantId ?? null, (req as any).userId) });
});

// Confirma a baixa (operador lançou no PDV) — por pedido ou por item.
router.post("/online-reserve/confirm", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const b = req.body || {};
  const r = b.orderId ? RetailOnlineReserveService.confirmByOrder(orgId, String(b.orderId), (req as any).userId)
          : b.id ? RetailOnlineReserveService.confirmItem(orgId, String(b.id), (req as any).userId)
          : null;
  if (!r) return res.status(400).json({ error: "Informe orderId ou id." });
  res.json({ ok: true, ...r, pending: RetailOnlineReserveService.listPending(orgId) });
});

router.put("/patterns/flag", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json({ ok: true, enabled: RetailPatternMemoryService.setEnabled(orgId, !!req.body?.enabled) });
});

router.post("/patterns/learn", requireRole("owner", "admin"), async (req: AuthRequest, res): Promise<any> => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const result = await RetailPatternMemoryService.learnPass(orgId, { asOf: req.body?.asOf });
    res.json({ ok: true, ...result, patterns: RetailPatternMemoryService.list(orgId) });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e?.message || "Falha ao rodar o aprendizado de padrões." });
  }
});

// --- Recebimento de mercadoria / pré-estoque (ADR-086) ---
router.get("/receiving", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json({ receipts: RetailReceivingService.listReceipts(orgId, req.query.status ? String(req.query.status) : undefined) });
});

router.get("/receiving/:id", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const r = RetailReceivingService.getReceipt(orgId, req.params.id);
  if (!r) return res.status(404).json({ error: "receipt_not_found" });
  res.json(r);
});

router.post("/receiving", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.status(201).json(RetailReceivingService.createReceipt(orgId, req.body || {}, req.user?.userId));
});

router.post("/receiving/:id/scan", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(RetailReceivingService.scanItem(orgId, req.params.id, String(req.body?.ean || ""), Number(req.body?.qty || 1), req.user?.userId)); }
  catch (e: any) { res.status(e.message === "receipt_not_found" ? 404 : 400).json({ error: e.message }); }
});

router.post("/receiving/:id/confirm", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(RetailReceivingService.confirm(orgId, req.params.id, req.user?.userId)); }
  catch (e: any) { res.status(e.message === "receipt_not_found" ? 404 : 400).json({ error: e.message }); }
});

// --- Scan por código de barras (ADR-086, só-catálogo-próprio; zero token) ---
router.get("/scan/lookup", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json(RetailScanService.lookupByEan(orgId, String(req.query.ean || "")));
});

router.post("/scan/receive", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    res.json(RetailScanService.scanReceive(orgId, String(req.body?.ean || ""), Number(req.body?.qty || 0), { storeId: req.body?.storeId }, req.user?.userId));
  } catch (e: any) {
    res.status(e.message === "store_required" ? 400 : 400).json({ error: e.message });
  }
});

// --- Conciliação de vendas: import do Fechamento de Caixa do Alterdata (Fase E) ---
// Painel do mês: fechamentos conciliados (informado × sistema) + divergências.
router.get("/reconciliation", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const month = String(req.query.month || new Date().toISOString().slice(0, 7));
  res.json(RetailReconciliationService.report(orgId, month, String(req.query.onlyDivergent || "") === "1"));
});

router.post("/reconciliation/import", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  csvUpload.single("file")(req, res, (err: any) => {
    if (err) return res.status(400).json({ error: err.message || "Falha no upload." });
    const file = (req as any).file;
    const csv = file ? file.buffer.toString("utf-8") : String(req.body?.csv || "");
    if (!csv.trim()) return res.status(400).json({ error: "Envie o CSV (campo 'file' ou body.csv)." });
    try { res.json(RetailReconciliationService.importCaixaDiario(orgId, csv, { toleranceBRL: req.body?.toleranceBRL }, req.user?.userId)); }
    catch (e: any) { res.status(500).json({ error: e.message }); }
  });
});

// --- Diagnóstico de onboarding + motor de composição (ADR-084 D3/D6) ---
router.get("/diagnostic/questions", (_req: AuthRequest, res): any => {
  res.json({ questions: RetailDiagnosticService.questions() });
});

// Prévia (sem aplicar): respostas → recomendação de módulos/estoque/capacidades.
router.post("/diagnostic/recommend", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json(RetailDiagnosticService.recommend(req.body || {}));
});

// Confirmação: aplica a recomendação (módulos + modo de estoque + ativação).
router.post("/diagnostic/apply", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const out = RetailDiagnosticService.apply(orgId, req.body || {}, req.user?.userId);
  // Se ativou o Retail Ops, captura o baseline do dia 0 (ADR-085).
  if (out.applied.retailActivated) { try { RetailImpactService.captureBaseline(orgId); } catch { /* best-effort */ } }
  res.json(out);
});

// --- Adoção / uso correto (ADR-085): onde ainda falta configurar ---
router.get("/adoption", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json(RetailAdoptionService.status(orgId));
});

// Narrativa da IA de adoção (tom parceiro): orientação amigável do que falta.
router.get("/adoption/coach", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json(RetailAdoptionService.coach(orgId));
});

// --- Modo de estoque / fonte da verdade (ADR-084 D4) ---
router.get("/stock-mode", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json(RetailStockModeService.status(orgId));
});

router.post("/stock-mode", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json({ orgMode: RetailStockModeService.setOrgMode(orgId, String(req.body?.mode), req.user?.userId) }); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.post("/stock-mode/store/:storeId", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const mode = req.body?.mode === null || req.body?.mode === undefined ? null : String(req.body.mode);
  try { res.json({ storeId: req.params.storeId, override: RetailStockModeService.setStoreOverride(orgId, req.params.storeId, mode, req.user?.userId), resolved: RetailStockModeService.resolve(orgId, req.params.storeId) }); }
  catch (e: any) { res.status(e.message === "store_not_found" ? 404 : 400).json({ error: e.message }); }
});

// Graduação supervisor → nativo (ADR-084 D5): promove a loja e semeia o núcleo.
router.post("/stock-mode/graduate/:storeId", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(RetailGraduationService.graduate(orgId, req.params.storeId, req.user?.userId)); }
  catch (e: any) { res.status(e.message === "store_not_found" ? 404 : 400).json({ error: e.message }); }
});

// --- Ativação opt-in do Retail Network Ops (ADR-084 D2) ---
router.get("/activation", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json(RetailActivationService.status(orgId));
});

router.post("/activation/activate", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const out = RetailActivationService.activate(orgId, req.user?.userId);
  // Baseline do dia 0 (ADR-085): captura o "antes" no momento da ativação.
  try { RetailImpactService.captureBaseline(orgId); } catch { /* best-effort */ }
  res.json(out);
});

router.post("/activation/deactivate", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json(RetailActivationService.deactivate(orgId, req.user?.userId));
});

const MEDIA_DIR = path.join(process.env.DATA_DIR || process.cwd(), "media");
const closingUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (/^image\/(png|jpe?g|webp)$/.test(file.mimetype)) return cb(null, true);
    cb(new Error("Formato de imagem não suportado (use PNG, JPG ou WEBP)."));
  },
});

// --- Lojas ---
router.get("/stores", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    // CRM-002: só as lojas que o usuário pode ver (owner/admin e sem-atribuição → todas).
    const all = RetailStoreService.list(orgId);
    res.json({ stores: RetailStoreScopeService.filterStores(orgId, req.user?.userId, req.user?.role, all) });
  }
  catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ESCOPO DE LOJA POR USUÁRIO (CRM-002/ADR-173). Config = owner/admin.
router.get("/store-scope/me", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json(RetailStoreScopeService.allowed(orgId, req.user?.userId, req.user?.role));
});
router.get("/store-scope/:userId", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json({ storeIds: RetailStoreScopeService.forUser(orgId, req.params.userId) });
});
router.put("/store-scope/:userId", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const storeIds = Array.isArray(req.body?.storeIds) ? req.body.storeIds : [];
    res.json({ storeIds: RetailStoreScopeService.setForUser(orgId, req.params.userId, storeIds, req.user?.userId) });
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.get("/stores/:id", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const store = RetailStoreService.get(orgId, req.params.id);
  if (!store) return res.status(404).json({ error: "store_not_found" });
  res.json(store);
});

// Mutações: só owner/admin da organização.
router.post("/stores", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const store = RetailStoreService.create(orgId, req.body || {}, req.user?.userId);
    res.status(201).json(store);
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.patch("/stores/:id", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const store = RetailStoreService.update(orgId, req.params.id, req.body || {}, req.user?.userId);
    if (!store) return res.status(404).json({ error: "store_not_found" });
    res.json(store);
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

// EXCLUIR loja duplicada: se existir outra loja com o MESMO código, o histórico
// (estoque, fechamentos, cotas…) é UNIFICADO nela antes de apagar.
router.delete("/stores/:id", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    res.json(RetailStoreService.remove(orgId, req.params.id, req.user?.userId));
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

// --- Custos fixos + RESULTADO/LUCRO por loja ---
// Custos fixos cadastrados da loja (aluguel, luz, condomínio...) por categoria.
// SEC-F13 (FE3/RN-CG-06/§73): dinheiro absoluto é owner/admin — o GET é role-gated
// igual ao PUT abaixo (ler o custo é tão sensível quanto gravá-lo).
router.get("/stores/:id/costs", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  if (!RetailStoreService.get(orgId, req.params.id)) return res.status(404).json({ error: "store_not_found" });
  try { res.json({ costs: RetailStoreCostService.list(orgId, req.params.id), categories: FIXED_COST_CATEGORIES }); }
  catch (e: any) { res.status(500).json({ error: e.message }); }
});

// Salva os custos fixos da loja (só owner/admin). Body: { costs: { aluguel: 1200, ... } }.
router.put("/stores/:id/costs", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const costs = (req.body && req.body.costs) || {};
    res.json({ costs: RetailStoreCostService.setMany(orgId, req.params.id, costs) });
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

// Custos VARIÁVEIS da loja (taxa cartão, imposto, embalagem etc.) — ADR-083 E5.
// Body salvo é {costs: {card_fee: {percent, fixedPerSale}, ...}}.
// SEC-F13: role-gated (dinheiro absoluto — §73), como o PUT abaixo.
router.get("/stores/:id/variable-costs", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  if (!RetailStoreService.get(orgId, req.params.id)) return res.status(404).json({ error: "store_not_found" });
  try { res.json({ costs: RetailStoreCostService.listVariable(orgId, req.params.id), categories: VARIABLE_COST_CATEGORIES }); }
  catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.put("/stores/:id/variable-costs", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const costs = (req.body && req.body.costs) || {};
    res.json({ costs: RetailStoreCostService.setManyVariable(orgId, req.params.id, costs) });
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

// SAVE-001/003 (PDR TOULON, Fatia 1C) — config financeira COMPOSTA (margem +
// custos fixos + variáveis) num só GET/PUT atômico com versão otimista. A UI nova
// usa isto; os endpoints acima seguem para compatibilidade.
router.get("/stores/:id/financial-settings", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(RetailStoreCostService.financialSettings(orgId, req.params.id)); }
  catch (e: any) { res.status(404).json({ error: e.message }); }
});

router.put("/stores/:id/financial-settings", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    res.json(RetailStoreCostService.saveFinancialSettings(orgId, req.params.id, req.body || {}, req.user?.userId));
  } catch (e: any) {
    if (e?.code === "VERSION_CONFLICT") return res.status(409).json({ error: "version_conflict", currentVersion: e.currentVersion });
    res.status(400).json({ error: e.message });
  }
});

// Resultado gerencial + ponto de equilíbrio de UMA loja no mês (?period=YYYY-MM).
// SEC-F13: lucro/margem absolutos são owner/admin (§73).
router.get("/stores/:id/result", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const period = String(req.query.period || "").slice(0, 7) || undefined;
  const key = `store-result:${req.params.id}:${period || "current"}`;
  const cached = RetailAnalyticsCache.get(orgId, key);
  if (cached !== undefined) return res.json(cached);
  try {
    const result = RetailStoreCostService.storeResult(orgId, req.params.id, period);
    if (!result) return res.status(404).json({ error: "store_not_found" });
    RetailAnalyticsCache.set(orgId, key, result);
    res.json(result);
  } catch (e: any) { return analyticsError(res, e); }
});

// Resultado de TODAS as lojas + totais da rede (?period=YYYY-MM). Hífen no path
// para não colidir com /stores/:id (senão :id capturaria "result").
// SEC-F13: lucro/margem da rede são owner/admin (§73).
router.get("/stores-result", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const period = String(req.query.period || "").slice(0, 7) || undefined;
  return analyticsCached(res, orgId, `stores-result:${period || "current"}`,
    () => RetailStoreCostService.allStoresResult(orgId, period));
});

// MAIS VENDIDOS por produto (PDV — itens das vendas): quantidade e valor por
// produto no período, com o nome do produto do catálogo. ?store filtra a filial.
router.get("/pdv-top-products", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const start = String(req.query.start || "").slice(0, 10);
  const end = String(req.query.end || "").slice(0, 10);
  if (!start || !end) return res.status(400).json({ error: "start e end são obrigatórios (YYYY-MM-DD)" });
  const filial = String(req.query.store || "").trim();
  const args: any[] = [orgId, start, end];
  let filialClause = "";
  if (filial) { filialClause = "AND i.filial = ?"; args.push(filial); }
  const cacheKey = `top-products:${start}:${end}:${filial || "*"}`;
  const cachedTop = RetailAnalyticsCache.get(orgId, cacheKey);
  if (cachedTop !== undefined) return res.json(cachedTop);
  try {
    // Casa o produto do ERP (13 díg.) com a variante/produto do catálogo p/ o
    // nome; o dígito extra do saldo (13 vs 12) é tolerado com o prefixo.
    // Devolve tríade de identificação: SKU (do cadastro), EAN (barras do
    // produto pai), e o próprio código do ERP (13 díg.) — pra bater etiqueta
    // no caixa/estoque quando o dono suspeitar que "esse mais-vendido não é
    // o produto certo".
    // PERF-002/004 (escala): agrega PRIMEIRO por `produto` (colapsa milhares de
    // itens em poucos códigos distintos) e SÓ ENTÃO resolve o nome — assim o
    // prefixo LIKE roda no máximo uma vez por código, nunca por item. Itens já
    // resolvidos (4A) casam pelos ids persistidos (`rprod`/`rpv`, por índice); o
    // prefixo (`pv`/`ps`/`pp`/`p2`) só toca os códigos ainda não resolvidos.
    args.push(orgId, orgId, orgId, orgId, orgId); // um orgId por junção de catálogo
    // Kill-switch 6B: flag OFF força a resolução do nome pelo ramo LIKE (legado).
    const useResolvedTP = RetailFeatureFlagService.resolvedProductsV1(orgId);
    const rP = useResolvedTP ? "g.resolved_at IS NOT NULL" : "1 = 0";
    const fP = useResolvedTP ? "g.resolved_at IS NULL" : "1 = 1";
    const rows = db.prepare(
      `SELECT g.produto,
              COALESCE(rpv.name, rprod.name, pv.name, ps.name, p2.name) AS nome_variante,
              COALESCE(rprod.name, pp.name, p2.name) AS nome_produto,
              COALESCE(rpv.sku, pv.sku, rpv.external_ref, pv.external_ref) AS sku,
              COALESCE(rprod.ean, pp.ean, ps.ean, p2.ean) AS ean_produto,
              COALESCE(rpv.external_ref, pv.external_ref) AS ean_variante,
              g.pecas AS pecas, g.valor AS valor
         FROM (
           SELECT i.produto,
                  MAX(i.product_service_id) AS psid,
                  MAX(i.variant_id) AS vid,
                  MAX(i.catalog_resolved_at) AS resolved_at,
                  SUM(i.quantidade) AS pecas, SUM(i.valor) AS valor
             FROM retail_pdv_sale_items i
            WHERE i.organization_id = ? AND i.sale_date BETWEEN ? AND ? AND COALESCE(i.produto,'') <> '' ${filialClause}
            GROUP BY i.produto
         ) g
         LEFT JOIN product_variants rpv ON ${rP} AND rpv.organization_id = ? AND rpv.id = g.vid
         LEFT JOIN products_services rprod ON ${rP} AND rprod.organization_id = ? AND rprod.id = g.psid
         LEFT JOIN product_variants pv ON ${fP} AND pv.organization_id = ? AND (pv.external_ref = g.produto OR pv.sku = g.produto)
         LEFT JOIN products_services pp ON pp.id = pv.product_service_id
         LEFT JOIN products_services ps ON ${fP} AND ps.organization_id = ? AND ps.external_ref = g.produto
         LEFT JOIN products_services p2 ON ${fP} AND p2.organization_id = ? AND g.produto LIKE p2.external_ref || '%' AND length(p2.external_ref) >= 4
        ORDER BY g.pecas DESC, g.valor DESC
        LIMIT 100`
    ).all(...args) as any[];
    // Detecção de "sem match no catálogo": não achou variante nem produto —
    // a UI marca essas linhas em cor de alerta pra você cadastrar/corrigir.
    const payload = {
      start, end,
      products: rows.map((r) => {
        const catalogHit = !!(r.nome_produto || r.nome_variante);
        // EAN preferencial: o do produto pai (impressa na etiqueta); se não
        // tiver, cai no external_ref da variante (que costuma ser EAN também).
        const ean = r.ean_produto || r.ean_variante || null;
        return {
          produto: r.produto,                     // código do ERP (13 díg.)
          nome: r.nome_produto || r.nome_variante || null,
          variante: r.nome_variante || null,
          sku: r.sku || null,
          ean,
          catalogHit,
          pecas: Math.round(Number(r.pecas || 0)),
          valor: Math.round(Number(r.valor || 0) * 100) / 100,
        };
      }),
    };
    RetailAnalyticsCache.set(orgId, cacheKey, payload);
    res.json(payload);
  } catch (e: any) { return analyticsError(res, e); }
});

// DRILL-DOWN "vendas do dia" — linhas INDIVIDUAIS do PDV, CADA UMA com a DATA da
// venda (as abas Mais vendidos/Por vendedor mostram só totais do período). Filtra
// por produto (código do ERP), vendedor (CAI_USUARIO) e/ou loja. Isolado por org.
router.get("/pdv-sale-lines", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const start = String(req.query.start || "").slice(0, 10);
  const end = String(req.query.end || "").slice(0, 10);
  if (!start || !end) return res.status(400).json({ error: "start e end são obrigatórios (YYYY-MM-DD)" });
  try {
    res.json(RetailPdvSaleLinesService.lines(orgId, {
      start, end,
      produto: String(req.query.produto || "").trim() || undefined,
      vendedor: String(req.query.vendedor || "").trim() || undefined,
      store: String(req.query.store || "").trim() || undefined,
      limit: req.query.limit ? parseInt(String(req.query.limit), 10) : undefined,
    }));
  } catch (e: any) { return analyticsError(res, e); }
});

// CLIENTES DO PDV (Fase 3, opt-in): busca por nome/CPF/celular + aniversariantes
// do mês (?birthdayMonth=MM) + filtro por FILIAL (?store=<código da loja>, CRM-001).
// Base separada dos contatos do WhatsApp. Resposta enriquecida com loja e
// timestamp de sync (RetailPdvCustomerService). Isolado por organização.
router.get("/pdv-customers", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const scope = RetailStoreScopeService.allowed(orgId, req.user?.userId, req.user?.role);
    const store = String(req.query.store || "").trim();
    if (store && !scope.unrestricted && !scope.storeCodes.includes(store)) {
      return res.status(403).json({ error: "store_out_of_scope" });
    }
    res.json(RetailPdvCustomerService.list(orgId, req.query as any, scope.unrestricted ? {} : { restrictCodes: scope.storeCodes }));
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

/**
 * Códigos padrão da tabela de cartão do Alterdata (`ADQ_CODIGO`) mapeados
 * pras bandeiras que a recepção reconhece. Varia por instalação — quando o
 * código não bater, o retorno mostra o CRU (nunca esconde). O gestor pode
 * ver todos os códigos que estão chegando em `unknownBrands` no response.
 * Override futuro por organização em `organization_settings` (fase própria).
 */
const CARD_BRAND_MAP: Record<string, string> = {
  "01": "Visa", "02": "Visa",
  "03": "Master", "04": "Master",
  "05": "Amex",
  "06": "Diners",
  "07": "Elo", "08": "Elo",
  "09": "Hipercard",
  "10": "Aura",
  "11": "Sorocred",
  "99": "Outros",
};
function normalizeCardBrand(cod: any): { raw: string; label: string; matched: boolean } {
  const raw = String(cod ?? "").trim();
  if (!raw) return { raw: "", label: "Sem bandeira", matched: false };
  // Alterdata costuma vir só com dígitos (2 chars) OU já com o nome — cobre os dois.
  const twoDigits = /^\d+$/.test(raw) ? raw.padStart(2, "0").slice(-2) : raw.toUpperCase();
  const mapped = CARD_BRAND_MAP[twoDigits];
  if (mapped) return { raw, label: mapped, matched: true };
  return { raw, label: raw, matched: false };
}

// Conferência PDV × Adquirente (Fase R1): confronta as parcelas registradas
// pela loja (Alterdata) com o que o adquirente (Sicredi) confirma. Categoriza
// match / diverge / só PDV / só adquirente por (NSU, parcela).
router.get("/card-acquirer/reconciliation", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const start = String(req.query.start || "").slice(0, 10);
  const end = String(req.query.end || "").slice(0, 10);
  const source = req.query.source ? String(req.query.source) : "sicredi";
  if (!start || !end) return res.status(400).json({ error: "start e end (YYYY-MM-DD) obrigatórios" });
  try {
    res.json(RetailCardAcquirerService.reconcile(orgId, start, end, { source }));
  } catch (e: any) { res.status(400).json({ error: e?.message || "falha" }); }
});

// Carga MANUAL do lado do adquirente — enquanto a API da Sicredi não tem
// credenciais, o financeiro sobe o JSON do extrato do internet banking. Cada
// linha vira upsert por (source, numero_transacao, parcela).
router.post("/card-acquirer/import", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const { source, rows } = req.body || {};
  try {
    res.json(RetailCardAcquirerService.importManual(orgId, String(source || "manual"), Array.isArray(rows) ? rows : [], req.user?.userId));
  } catch (e: any) { res.status(400).json({ error: e?.message || "falha" }); }
});

// Sync API Sicredi — STUB até a Sicredi liberar credenciais/manual.
router.post("/card-acquirer/sync-sicredi", requireRole("owner", "admin"), async (req: AuthRequest, res): Promise<any> => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const start = String(req.body?.start || "").slice(0, 10);
  const end = String(req.body?.end || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) return res.status(400).json({ error: "start e end (YYYY-MM-DD) obrigatórios" });
  try {
    await RetailCardAcquirerService.syncFromSicrediApi(orgId, { start, end });
    res.json({ ok: true });
  } catch (e: any) {
    if (e?.message === "sicredi_api_not_configured") {
      return res.status(501).json({ error: "sicredi_api_not_configured", message: "Sicredi ainda não configurada. Enquanto isso, use 'Importar do extrato' (upload manual)." });
    }
    res.status(500).json({ error: e?.message || "falha" });
  }
});

// RECEBÍVEIS DE CARTÃO (parcelasCartao do PDV): por dia de VENCIMENTO — bruto,
// líquido (o que entra), taxa retida — + totais do período. ?store filtra
// filial; ?detailed=1 devolve a linha-a-linha com bandeira normalizada +
// parcela + valor + vencimento pra conferência com o extrato do banco.
router.get("/pdv-card-receivables", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const start = String(req.query.start || "").slice(0, 10);
  const end = String(req.query.end || "").slice(0, 10);
  if (!start || !end) return res.status(400).json({ error: "start e end são obrigatórios (YYYY-MM-DD)" });
  const filial = String(req.query.store || "").trim();
  const detailed = String(req.query.detailed || "") === "1";
  const args: any[] = [orgId, start, end];
  let filialClause = "";
  if (filial) { filialClause = "AND filial = ?"; args.push(filial); }
  try {
    // Bloco AGREGADO — sempre devolve (topo da tela, tiles + tabela por dia).
    const byDayRows = db.prepare(
      `SELECT vencimento, COUNT(*) AS parcelas, SUM(valor) AS bruto, SUM(liquido) AS liquido
         FROM retail_pdv_card_installments
        WHERE organization_id = ? AND vencimento BETWEEN ? AND ? ${filialClause}
        GROUP BY vencimento ORDER BY vencimento`
    ).all(...args) as any[];
    // Breakdown por BANDEIRA no período — pra mostrar "quanto Visa vs Master".
    const byBrandRows = db.prepare(
      `SELECT codigo_cartao, COUNT(*) AS parcelas, SUM(valor) AS bruto, SUM(liquido) AS liquido
         FROM retail_pdv_card_installments
        WHERE organization_id = ? AND vencimento BETWEEN ? AND ? ${filialClause}
        GROUP BY codigo_cartao ORDER BY SUM(valor) DESC`
    ).all(...args) as any[];
    const totals = byDayRows.reduce((a, r) => ({
      parcelas: a.parcelas + Number(r.parcelas || 0),
      bruto: a.bruto + Number(r.bruto || 0),
      liquido: a.liquido + Number(r.liquido || 0),
    }), { parcelas: 0, bruto: 0, liquido: 0 });
    (totals as any).taxa = Math.round((totals.bruto - totals.liquido) * 100) / 100;
    const byBrand = byBrandRows.map((r) => {
      const n = normalizeCardBrand(r.codigo_cartao);
      return { raw: n.raw, brand: n.label, matched: n.matched, parcelas: Number(r.parcelas), bruto: Math.round(Number(r.bruto) * 100) / 100, liquido: Math.round(Number(r.liquido) * 100) / 100 };
    });
    const unknownBrands = byBrand.filter((b) => !b.matched && b.raw).map((b) => b.raw);
    // Bloco DETALHADO — só se pedido; até 1000 linhas pra não travar a tela.
    let items: any[] | undefined;
    if (detailed) {
      const rowsD = db.prepare(
        `SELECT filial, vencimento, parcela, seq, numero, boleta, codigo_cartao, valor, liquido, taxa, sale_date
           FROM retail_pdv_card_installments
          WHERE organization_id = ? AND vencimento BETWEEN ? AND ? ${filialClause}
          ORDER BY vencimento, filial, numero, seq
          LIMIT 1000`
      ).all(...args) as any[];
      items = rowsD.map((r) => {
        const n = normalizeCardBrand(r.codigo_cartao);
        return {
          filial: r.filial, vencimento: r.vencimento, parcela: r.parcela, seq: r.seq,
          numero: r.numero, boleta: r.boleta, brand: n.label, brandRaw: n.raw, brandMatched: n.matched,
          valor: Math.round(Number(r.valor) * 100) / 100,
          liquido: Math.round(Number(r.liquido) * 100) / 100,
          taxa: Math.round(Number(r.taxa) * 100) / 100,
          saleDate: r.sale_date,
        };
      });
    }
    res.json({
      start, end,
      byDay: byDayRows.map((r) => ({ vencimento: r.vencimento, parcelas: Number(r.parcelas), bruto: Math.round(Number(r.bruto) * 100) / 100, liquido: Math.round(Number(r.liquido) * 100) / 100 })),
      byBrand, unknownBrands, totals,
      items, itemsTruncated: detailed && (items?.length || 0) === 1000,
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// DIAGNÓSTICO da anomalia do vendedor: por matrícula do CAIXA, mostra em quantas
// LOJAS ela aparece e se há vendedor por-linha nos itens — para descobrir se a
// matrícula é do operador (compartilhada) ou do vendedor real. `byFilial`
// (Toulon, pós-ADR-105) checa a MESMA anomalia agora pro CAI_USUARIO
// (`vendedor_codigo`): quantos códigos de vendedor DISTINTOS aparecem em cada
// loja — se uma loja com muitas vendas só tem 1 código, ele provavelmente não
// está individualizando vendedor real ali (é um login/terminal compartilhado,
// não a pessoa que atendeu) — dado concreto pra levar ao suporte da Alterdata.
router.get("/pdv-seller-diagnosis", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const byMatricula = db.prepare(
      `SELECT vendedor AS matricula, COUNT(DISTINCT filial) AS lojas, COUNT(*) AS vendas,
              COUNT(DISTINCT usuario) AS usuarios, MIN(sale_date) AS de, MAX(sale_date) AS ate
         FROM retail_pdv_sales WHERE organization_id = ? AND COALESCE(vendedor,'') <> ''
        GROUP BY vendedor ORDER BY vendas DESC LIMIT 20`
    ).all(orgId) as any[];
    const lineSellers = db.prepare(
      `SELECT COUNT(*) AS itens, COUNT(vendedor) AS itens_com_vendedor, COUNT(DISTINCT vendedor) AS vendedores_distintos
         FROM retail_pdv_sale_items WHERE organization_id = ?`
    ).get(orgId) as any;
    const byFilialRaw = db.prepare(
      `SELECT s.filial, COALESCE(st.name, 'Filial ' || s.filial) AS loja, st.seller_source AS seller_source, COUNT(*) AS vendas,
              COUNT(DISTINCT COALESCE(NULLIF(s.vendedor_codigo, ''), s.vendedor)) AS vendedores_distintos,
              COUNT(DISTINCT NULLIF(s.vendedor_codigo, '')) AS cai_usuario_distintos,
              COUNT(DISTINCT s.vendedor) AS operadores_distintos
         FROM retail_pdv_sales s
         LEFT JOIN retail_stores st ON st.organization_id = s.organization_id AND st.code = s.filial AND st.active = 1
        WHERE s.organization_id = ? AND COALESCE(s.status, 'N') <> 'C'
        GROUP BY s.filial ORDER BY vendas DESC`
    ).all(orgId) as any[];
    // risco = loja com volume razoável de vendas mas SÓ 1 código de vendedor —
    // sinal de que o campo não está individualizando (login/terminal comum).
    // Loja já marcada seller_source='manual' não é mais risco: o gestor já
    // resolveu, o PDV dela nem entra na comissão por vendedor.
    const byFilial = byFilialRaw.map((r) => ({ ...r, risco: r.seller_source !== "manual" && Number(r.vendedores_distintos) <= 1 && Number(r.vendas) > 5 }));
    res.json({ byMatricula, lineSellers, byFilial });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// MAPEAMENTO matrícula → vendedor (Fase 4): dá nome à matrícula do ERP.
// GET devolve os mapeados + as matrículas vistas nas vendas ainda sem nome.
router.get("/sellers", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const sellers = db.prepare(`SELECT matricula, name, user_id, active FROM retail_sellers WHERE organization_id = ? ORDER BY name`).all(orgId) as any[];
  // Chave = CÓDIGO DO VENDEDOR (CAI_USUARIO / `vendedor_codigo`) quando presente,
  // caindo no operador só quando ausente — casa com a agregação de /pdv-sellers.
  const unmapped = (db.prepare(
    `SELECT DISTINCT COALESCE(NULLIF(vendedor_codigo, ''), vendedor) AS vendedor FROM retail_pdv_sales
      WHERE organization_id = ? AND COALESCE(NULLIF(vendedor_codigo, ''), vendedor, '') <> ''
        AND COALESCE(NULLIF(vendedor_codigo, ''), vendedor) NOT IN (SELECT matricula FROM retail_sellers WHERE organization_id = ?)
      ORDER BY vendedor`
  ).all(orgId, orgId) as any[]).map((r) => r.vendedor);
  res.json({ sellers, unmapped });
});

router.put("/sellers/:matricula", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const matricula = String(req.params.matricula || "").trim();
  if (!matricula) return res.status(400).json({ error: "Matrícula é obrigatória." });
  const name = req.body?.name != null ? String(req.body.name).trim() : null;
  db.prepare(
    `INSERT INTO retail_sellers (id, organization_id, matricula, name, user_id, active)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(organization_id, matricula) DO UPDATE SET
       name = excluded.name, user_id = COALESCE(excluded.user_id, retail_sellers.user_id),
       active = excluded.active, updated_at = CURRENT_TIMESTAMP`
  ).run(randomUUID(), orgId, matricula, name, req.body?.userId || null, req.body?.active === false ? 0 : 1);
  res.json(db.prepare(`SELECT id, matricula, name, user_id, active FROM retail_sellers WHERE organization_id = ? AND matricula = ?`).get(orgId, matricula));
});

// SELL-002 — lotação do vendedor por loja (owner/admin). sellerId = retail_sellers.id.
router.get("/sellers/:sellerId/stores", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json({ stores: RetailSellerDirectoryService.storesForSeller(orgId, req.params.sellerId) }); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.put("/sellers/:sellerId/stores", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const storeIds = Array.isArray(req.body?.storeIds) ? req.body.storeIds.map(String) : [];
    res.json({ stores: RetailSellerDirectoryService.setStores(orgId, req.params.sellerId, storeIds, req.body?.primaryStoreId ?? null, req.user?.userId) });
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

// PERF-001 (Fatia 4) — backfill da resolução de catálogo dos itens do PDV
// (em lotes idempotentes/interrompíveis). owner/admin.
router.post("/pdv-catalog/backfill", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const limit = Math.max(1, Math.min(5000, parseInt(String(req.body?.limit || "1000"), 10) || 1000));
  const r = RetailPdvCatalogResolver.backfill(orgId, { limit });
  res.json({ ...r, pending: RetailPdvCatalogResolver.pendingCount(orgId) });
});

// Fase 6B — kill-switches de runtime (data comercial · analíticas resolvidas).
// Reverter no piloto sem deploy. owner/admin. GET lê; PUT liga/desliga um flag.
router.get("/feature-flags", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json({ flags: RetailFeatureFlagService.status(orgId) });
});
router.put("/feature-flags/:key", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const key = String(req.params.key || "") as RetailFlagKey;
  if (key !== "business_date" && key !== "resolved_products") return res.status(400).json({ error: "flag desconhecida (business_date | resolved_products)." });
  if (typeof req.body?.enabled !== "boolean") return res.status(400).json({ error: "enabled (boolean) é obrigatório." });
  const flags = RetailFeatureFlagService.set(orgId, key, req.body.enabled);
  RetailAnalyticsCache.invalidate(orgId); // trocar o caminho de query muda os números em cache
  res.json({ flags });
});

// POS-002/003 (Fatia 3) — tarifas POS por loja × meio de pagamento (crédito/
// débito) + custo esperado a partir do resumo do POS.
router.get("/stores/:id/pos-fees", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(RetailPosFeeService.rules(orgId, req.params.id)); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.put("/stores/:id/pos-fees", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(RetailPosFeeService.set(orgId, req.params.id, req.body || {}, req.user?.userId)); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.get("/stores/:id/pos-fees/expected", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const q = req.query;
  try { res.json(RetailPosFeeService.expectedCost(orgId, req.params.id, { creditValue: Number(q.creditValue), creditQty: Number(q.creditQty), debitValue: Number(q.debitValue), debitQty: Number(q.debitQty) })); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

// SELL-003/005/006 — cobertura de vendedores da loja: lotados + pendências de
// nome + suspeitos de código compartilhado (diagnóstico, nunca cria vendedor).
router.get("/seller-coverage", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const storeId = String(req.query.storeId || "");
  if (!storeId) return res.status(400).json({ error: "storeId obrigatório" });
  try { res.json(RetailSellerDirectoryService.coverage(orgId, storeId)); }
  catch (e: any) { res.status(404).json({ error: e.message }); }
});

// VENDAS POR VENDEDOR do PDV (Fase 4 / Homologação Toulon ADR-105): agregado do
// stream VendaMalote. O VENDEDOR da comissão é o CAI_USUARIO (`vendedor_codigo`),
// NÃO a matrícula do operador de caixa (`vendedor`) — a matrícula é do operador e
// pode cobrir a rede toda. Usa o código do vendedor quando presente e cai no
// operador só quando ausente (retrocompatível: bases sem re-sync mantêm o
// comportamento antigo). O alias `vendedor` continua sendo a CHAVE exibida.
router.get("/pdv-sellers", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const start = String(req.query.start || "").slice(0, 10);
  const end = String(req.query.end || "").slice(0, 10);
  if (!start || !end) return res.status(400).json({ error: "start e end são obrigatórios (YYYY-MM-DD)" });
  try {
    const rows = db.prepare(
      `SELECT COALESCE(NULLIF(s.vendedor_codigo, ''), s.vendedor) AS vendedor, s.filial,
              COALESCE(st.name, 'Filial ' || s.filial) AS store_name,
              rs.name AS seller_name,
              SUM(s.valor) AS sales, COUNT(*) AS orders, SUM(s.pecas) AS pecas
         FROM retail_pdv_sales s
         LEFT JOIN retail_stores st ON st.organization_id = s.organization_id AND st.code = s.filial AND st.active = 1
         LEFT JOIN retail_sellers rs ON rs.organization_id = s.organization_id AND rs.matricula = COALESCE(NULLIF(s.vendedor_codigo, ''), s.vendedor)
        WHERE s.organization_id = ? AND s.sale_date BETWEEN ? AND ?
          AND COALESCE(s.status, 'N') <> 'C' AND COALESCE(NULLIF(s.vendedor_codigo, ''), s.vendedor, '') <> ''
        GROUP BY COALESCE(NULLIF(s.vendedor_codigo, ''), s.vendedor), s.filial
        ORDER BY sales DESC LIMIT 300`
    ).all(orgId, start, end) as any[];
    // Comissão ESTIMADA por vendedor: usa a regra percentual ativa (preferindo
    // escopo vendedor; senão a da loja como estimativa) sobre as vendas do PDV.
    const rule = db.prepare(
      `SELECT scope, config_json FROM retail_commission_rules
        WHERE organization_id = ? AND active = 1 AND calculation_type = 'percent_sales'
        ORDER BY CASE scope WHEN 'seller' THEN 0 ELSE 1 END LIMIT 1`
    ).get(orgId) as any;
    let pct = 0;
    try { pct = Number(JSON.parse(rule?.config_json || "{}").percent || 0); } catch { /* noop */ }
    const sellers = rows.map((r) => ({ ...r, commission: pct > 0 ? Math.round(Number(r.sales) * pct) / 100 : null }));
    res.json({ start, end, commissionPercent: pct || null, commissionRuleScope: rule?.scope || null, sellers });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// --- Vendas por VENDEDOR lançadas à mão / por foto (Cenário B) ---------------
// Quando o ERP não traz o vendedor por venda, a loja anota no papel e o gestor
// lança aqui (digitando ou enviando a foto p/ a IA ler). Alimenta a comissão
// por vendedor (RetailCommissionService.combinedSalesBySeller).
router.get("/seller-sales", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const start = String(req.query.start || "").slice(0, 10);
  const end = String(req.query.end || "").slice(0, 10);
  if (!start || !end) return res.status(400).json({ error: "start e end são obrigatórios (YYYY-MM-DD)" });
  const storeId = req.query.storeId ? String(req.query.storeId) : null;
  res.json({ start, end, entries: RetailSellerSalesService.list(orgId, start, end, storeId) });
});

router.post("/seller-sales", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const { storeId, saleDate, entries, source, imageUrl } = req.body || {};
  if (!saleDate) return res.status(400).json({ error: "saleDate é obrigatório (YYYY-MM-DD)" });
  if (!Array.isArray(entries) || entries.length === 0) return res.status(400).json({ error: "Informe ao menos um vendedor." });
  if (storeId && !RetailStoreService.get(orgId, String(storeId))) return res.status(404).json({ error: "store_not_found" });
  try {
    const created = RetailSellerSalesService.bulkCreate(orgId, { storeId, saleDate, entries, source, imageUrl }, req.user?.userId);
    if (!created.length) return res.status(400).json({ error: "Nenhuma linha válida (precisa de nome e valor ou peças)." });
    res.status(201).json({ created });
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.patch("/seller-sales/:id", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const b = req.body || {};
  if (b.storeId && !RetailStoreService.get(orgId, String(b.storeId))) return res.status(404).json({ error: "store_not_found" });
  try {
    const patch: any = {};
    if (b.sellerName !== undefined) patch.sellerName = b.sellerName;
    if (b.valor !== undefined) patch.valor = Number(b.valor) || 0;
    if (b.pecas !== undefined) patch.pecas = Number(b.pecas) || 0;
    if (b.atendimentos !== undefined) patch.atendimentos = Number(b.atendimentos) || 0;
    if (b.saleDate !== undefined) patch.saleDate = b.saleDate;
    if (b.storeId !== undefined) patch.storeId = b.storeId || null;
    if (b.matricula !== undefined) patch.matricula = b.matricula || null;
    const updated = RetailSellerSalesService.update(orgId, String(req.params.id), patch, req.user?.userId);
    if (!updated) return res.status(404).json({ error: "not_found" });
    res.json(updated);
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.delete("/seller-sales/:id", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const ok = RetailSellerSalesService.remove(orgId, String(req.params.id), req.user?.userId);
  if (!ok) return res.status(404).json({ error: "not_found" });
  res.json({ ok: true });
});

// Leitura por FOTO: a IA lê a folha e devolve as linhas para o gestor CONFERIR —
// NÃO salva. O salvamento é o POST /seller-sales, após a confirmação humana.
router.post("/seller-sales/scan", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  if (!isAIConfigured()) return res.status(400).json({ error: "IA não configurada nesta instância." });
  closingUpload.single("file")(req, res, async (err: any) => {
    if (err) return res.status(400).json({ error: err.message || "Falha no upload." });
    const file = (req as any).file;
    if (!file) return res.status(400).json({ error: "Nenhuma imagem enviada." });
    try {
      const processed = await sharp(file.buffer).rotate().resize(2000, 2000, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 88 }).toBuffer();
      let imageUrl: string | null = null;
      try { fs.mkdirSync(MEDIA_DIR, { recursive: true }); const name = `${randomUUID()}.jpg`; fs.writeFileSync(path.join(MEDIA_DIR, name), processed); imageUrl = `/media/${name}`; } catch { /* best-effort */ }
      const out = await RetailSellerSalesService.extractFromImage(processed.toString("base64"), "image/jpeg");
      res.json({ ...out, imageUrl });
    } catch (e: any) {
      console.error("[Retail Seller Sales Scan] erro", e);
      res.status(500).json({ error: "Falha ao ler a folha de vendas com a IA. Tente uma foto mais nítida ou lance os valores manualmente." });
    }
  });
});

// --- Responsáveis por loja (cobrança por pessoa, ADR-108) ---
router.get("/stores/:id/responsibles", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json({ responsibles: RetailResponsibleService.list(orgId, req.params.id) });
});

router.post("/stores/:id/responsibles", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const r = RetailResponsibleService.add(orgId, req.params.id, req.body || {}, req.user?.userId);
    res.status(201).json(r);
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.patch("/responsibles/:rid", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const r = RetailResponsibleService.update(orgId, req.params.rid, req.body || {}, req.user?.userId);
  if (!r) return res.status(404).json({ error: "responsible_not_found" });
  res.json(r);
});

router.delete("/responsibles/:rid", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const ok = RetailResponsibleService.remove(orgId, req.params.rid, req.user?.userId);
  res.json({ ok });
});

// --- Cotas ---
router.get("/quotas", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json({ date: today(req), quotas: RetailQuotaService.listByDate(orgId, today(req)) });
});

router.post("/quotas", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const { storeId, quotaDate, quotaAmount } = req.body || {};
  if (!storeId || !quotaDate) return res.status(400).json({ error: "storeId e quotaDate são obrigatórios" });
  res.status(201).json(RetailQuotaService.set(orgId, { storeId, quotaDate, quotaAmount }, req.user?.userId));
});

router.post("/quotas/import", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  res.json({ imported: RetailQuotaService.import(orgId, rows, req.user?.userId) });
});

// COTA SUGERIDA PELO PDV (Alterdata Fase 2+): média do MESMO dia da semana nas
// últimas 8 semanas (system_total > 0); sem amostra do dia da semana, cai na
// média geral dos últimos 28 dias. { date?, apply? } — apply=true grava as
// cotas (source 'pdv_suggest'); sem apply, só devolve as sugestões.
router.post("/quotas/suggest", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const date = String(req.body?.date || today(req)).slice(0, 10);
  const apply = !!req.body?.apply;
  const stores = db.prepare(`SELECT id, name FROM retail_stores WHERE organization_id = ? AND active = 1 ORDER BY name`).all(orgId) as any[];
  const suggestions: any[] = [];
  for (const s of stores) {
    // strftime('%w') = dia da semana (0=domingo) — compara com o do dia-alvo.
    const dow = (db.prepare(`SELECT strftime('%w', ?) w`).get(date) as any)?.w;
    const sameDow = db.prepare(
      `SELECT AVG(system_total) avg, COUNT(*) n FROM retail_daily_closings
        WHERE organization_id = ? AND store_id = ? AND COALESCE(system_total, 0) > 0
          AND closing_date >= date(?, '-56 days') AND closing_date < ? AND strftime('%w', closing_date) = ?`
    ).get(orgId, s.id, date, date, dow) as any;
    const overall = db.prepare(
      `SELECT AVG(system_total) avg, COUNT(*) n FROM retail_daily_closings
        WHERE organization_id = ? AND store_id = ? AND COALESCE(system_total, 0) > 0
          AND closing_date >= date(?, '-28 days') AND closing_date < ?`
    ).get(orgId, s.id, date, date) as any;
    const pick = Number(sameDow?.n || 0) >= 2 ? sameDow : overall;
    const suggested = Math.round(Number(pick?.avg || 0) * 100) / 100;
    if (suggested <= 0) continue; // sem histórico do PDV para esta loja
    suggestions.push({ storeId: s.id, storeName: s.name, suggested, samples: Number(pick?.n || 0), basis: Number(sameDow?.n || 0) >= 2 ? "mesmo dia da semana (8 sem.)" : "média 28 dias" });
    if (apply) {
      RetailQuotaService.set(orgId, { storeId: s.id, quotaDate: date, quotaAmount: suggested, source: "pdv_suggest" }, req.user?.userId);
      // O fechamento guarda a cota como SNAPSHOT na criação — fechamentos já
      // existentes do dia ficariam com a cota antiga (0) e a tela "não muda".
      // Atualiza o snapshot e recalcula o desvio de quem já informou.
      db.prepare(
        `UPDATE retail_daily_closings SET quota_amount = ?,
            variance_amount = CASE WHEN COALESCE(informed_total, 0) > 0 THEN informed_total - ? ELSE variance_amount END,
            variance_percent = CASE WHEN COALESCE(informed_total, 0) > 0 AND ? > 0 THEN (informed_total - ?) * 100.0 / ? ELSE variance_percent END,
            updated_at = CURRENT_TIMESTAMP
          WHERE organization_id = ? AND store_id = ? AND closing_date = ?`
      ).run(suggested, suggested, suggested, suggested, suggested, orgId, s.id, date);
    }
  }
  res.json({ date, applied: apply, suggestions });
});

// GRADE FURADA / REPOSIÇÃO (dados do estoque por loja do ERP): loja que
// TRABALHA o produto (tem outros tamanhos com saldo) mas está ZERADA numa
// variação que outra loja tem sobrando (>= minDonor) → sugestão de
// transferência entre filiais.
router.get("/replenishment", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const scope = RetailStoreScopeService.allowed(orgId, req.user?.userId, req.user?.role);
    res.json(RetailTransferService.replenishmentSuggestions(orgId, {
      minDonor: req.query.minDonor ? parseInt(String(req.query.minDonor), 10) : undefined,
      limit: req.query.limit ? parseInt(String(req.query.limit), 10) : undefined,
      restrictNeedyStoreIds: scope.unrestricted ? undefined : scope.storeIds,
    }));
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// --- Transferências entre lojas (ADR-083, Fase G) ---
// Gated pelo módulo `retail` (como todo /api/retailops). Mutações exigem
// owner/admin, igual às demais operações da rede.
router.get("/transfers", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const status = req.query.status ? String(req.query.status) : undefined;
  try {
    res.json({
      transfers: RetailTransferService.list(orgId, {
        status,
        limit: req.query.limit ? parseInt(String(req.query.limit), 10) : undefined,
        offset: req.query.offset ? parseInt(String(req.query.offset), 10) : undefined,
      }),
      total: RetailTransferService.count(orgId, { status }),
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.get("/transfers/:id", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const t = RetailTransferService.get(orgId, req.params.id);
  if (!t) return res.status(404).json({ error: "transferência não encontrada" });
  res.json(t);
});

router.post("/transfers", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const t = RetailTransferService.create(orgId, req.body || {}, req.user?.userId);
    res.status(201).json(t);
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.post("/transfers/:id/receive", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(RetailTransferService.receive(orgId, req.params.id, { items: req.body?.items }, req.user?.userId)); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.post("/transfers/:id/cancel", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(RetailTransferService.cancel(orgId, req.params.id, req.user?.userId)); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

// --- Fechamentos ---
router.get("/closings", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json({ date: today(req), closings: RetailClosingService.listByDate(orgId, today(req)) });
});

router.get("/closings/:id", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const c = RetailClosingService.get(orgId, req.params.id);
  if (!c) return res.status(404).json({ error: "closing_not_found" });
  res.json(c);
});

// Abre (ou devolve) o fechamento pendente de uma loja no dia.
router.post("/closings", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const { storeId, closingDate } = req.body || {};
  if (!storeId || !closingDate) return res.status(400).json({ error: "storeId e closingDate são obrigatórios" });
  res.status(201).json(RetailClosingService.getOrCreate(orgId, storeId, closingDate));
});

// Registra o total informado + itens e calcula o desvio vs cota (manual; a via
// WhatsApp/IA entra na Fase C chamando este mesmo caminho).
router.post("/closings/:id/inform", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const { informedTotal, items } = req.body || {};
  const c = RetailClosingService.setInformed(orgId, req.params.id, { informedTotal: Number(informedTotal || 0), items, source: "manual" }, req.user?.userId);
  if (!c) return res.status(404).json({ error: "closing_not_found" });
  res.json(c);
});

router.post("/closings/:id/approve", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const c = RetailClosingService.setStatus(orgId, req.params.id, "approved", req.user?.userId);
  if (!c) return res.status(404).json({ error: "closing_not_found" });
  // Fase C2: o ranking da folha aprovada vira vendas por vendedor (base da
  // comissão/corrida) — best-effort, a aprovação não falha por causa disso.
  let syncedSellers = 0;
  try { syncedSellers = RetailClosingService.syncRankingToSellerSales(orgId, req.params.id, req.user?.userId); } catch { /* noop */ }
  res.json({ ...c, syncedSellers });
});

router.post("/closings/:id/reject", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const c = RetailClosingService.setStatus(orgId, req.params.id, "rejected", req.user?.userId);
  if (!c) return res.status(404).json({ error: "closing_not_found" });
  res.json(c);
});

// Fase C2 — fechamento noturno COMPLETO (a folha da loja em forma estruturada):
// dinheiro/PIX, crédito e débito POR BANDEIRA, despesas, ranking por vendedor
// (valor/AT/peças), cadastros, boletas, malote, prêmio do dia e conferência
// com o resumo do POS. O total é derivado; divergências viram flags (D4).
router.post("/closings/:id/detailed", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const c = RetailClosingService.get(orgId, req.params.id);
  if (!c) return res.status(404).json({ error: "closing_not_found" });
  try {
    res.json(RetailClosingService.submitDetailed(orgId, c.store_id, c.closing_date, req.body?.details || {}, { source: "manual" }, req.user?.userId));
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

// Bandeiras de cartão da loja (o formulário da folha monta os campos por elas).
router.get("/stores/:id/card-brands", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  if (!RetailStoreService.get(orgId, req.params.id)) return res.status(404).json({ error: "store_not_found" });
  res.json(RetailClosingService.getCardBrands(orgId, req.params.id));
});

router.put("/stores/:id/card-brands", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  if (!RetailStoreService.get(orgId, req.params.id)) return res.status(404).json({ error: "store_not_found" });
  try { res.json(RetailClosingService.setCardBrands(orgId, req.params.id, req.body || {}, req.user?.userId)); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

// --- Boletas em tempo real (Fase C3) ----------------------------------------
// O talão manuscrito continua; o clique registra a HORA real de cada venda.
router.get("/boletas/day", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const storeId = String(req.query.storeId || "");
  if (!storeId) return res.status(400).json({ error: "storeId obrigatório" });
  // TIME-003/BOL-001: se o cliente não pedir um dia histórico específico, o
  // servidor usa a DATA COMERCIAL do fuso da org (não o "hoje" UTC do navegador).
  const rawDay = String(req.query.day || "").slice(0, 10);
  const day = /^\d{4}-\d{2}-\d{2}$/.test(rawDay) ? rawDay : BusinessTimeService.businessDate(orgId);
  if (!RetailStoreService.get(orgId, storeId)) return res.status(404).json({ error: "store_not_found" });
  const report = RetailBoletaService.dayReport(orgId, storeId, day) as any;
  res.json({ ...report, businessDate: BusinessTimeService.businessDate(orgId), timezone: BusinessTimeService.timezoneFor(orgId), serverTimestamp: new Date().toISOString() });
});

// Abre o dia com o nº inicial do talão (gestão).
router.post("/boletas/day/open", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const { storeId, initialNumber } = req.body || {};
  if (!storeId) return res.status(400).json({ error: "storeId obrigatório" });
  if (!RetailStoreService.get(orgId, String(storeId))) return res.status(404).json({ error: "store_not_found" });
  // TIME-003: o servidor determina o dia comercial; o cliente não abre outro dia.
  const day = BusinessTimeService.writeDay(orgId);
  try { res.json(RetailBoletaService.openDay(orgId, String(storeId), day, String(initialNumber || ""), req.user?.userId)); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

// O CLIQUE da venda — SEM requireRole de propósito: o vendedor no balcão
// também registra (a segurança é o gate do módulo + org). Hora é do servidor.
router.post("/boletas/click", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const { storeId, sellerName, idempotencyKey } = req.body || {};
  if (!storeId) return res.status(400).json({ error: "storeId obrigatório" });
  if (!RetailStoreService.get(orgId, String(storeId))) return res.status(404).json({ error: "store_not_found" });
  // TIME-003: dia comercial autoritativo do servidor; a hora do clique é do servidor.
  const day = BusinessTimeService.writeDay(orgId);
  // BOL-002: idempotencyKey (gerada no dispositivo) faz retry/double-click
  // devolverem o mesmo evento em vez de consumir outro número.
  try { res.status(201).json(RetailBoletaService.click(orgId, String(storeId), day, { sellerName, idempotencyKey }, req.user?.userId)); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

// BOL-005: histórico curto (leitura) — últimos N dias com boletas da loja.
router.get("/boletas/history", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const storeId = String(req.query.storeId || "");
  if (!storeId) return res.status(400).json({ error: "storeId obrigatório" });
  if (!RetailStoreService.get(orgId, storeId)) return res.status(404).json({ error: "store_not_found" });
  const limit = Math.max(1, Math.min(31, parseInt(String(req.query.limit || "7"), 10) || 7));
  res.json({ history: RetailBoletaService.history(orgId, storeId, limit) });
});

// Desfaz o ÚLTIMO clique (misclick) — gestão.
router.post("/boletas/click/:id/cancel", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(RetailBoletaService.cancelClick(orgId, req.params.id, req.user?.userId)); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

// Fechamento por FOTO (Fase C): a IA lê a folha e preenche o fechamento do dia
// da loja, calculando o desvio vs cota. NÃO aprova — baixa confiança vira
// 'needs_review' para a conferência humana. Body: storeId, date (opcional).
router.post("/closings/scan", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  if (!isAIConfigured()) return res.status(400).json({ error: "IA não configurada nesta instância." });
  closingUpload.single("file")(req, res, async (err: any) => {
    if (err) return res.status(400).json({ error: err.message || "Falha no upload." });
    const file = (req as any).file;
    if (!file) return res.status(400).json({ error: "Nenhuma imagem enviada." });
    const storeId = String(req.body?.storeId || "");
    const date = String(req.body?.date || new Date().toISOString().slice(0, 10));
    if (!storeId) return res.status(400).json({ error: "storeId é obrigatório" });
    if (!RetailStoreService.get(orgId, storeId)) return res.status(404).json({ error: "store_not_found" });
    try {
      const processed = await sharp(file.buffer).rotate().resize(2000, 2000, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 88 }).toBuffer();
      let imageUrl: string | null = null;
      try { fs.mkdirSync(MEDIA_DIR, { recursive: true }); const name = `${randomUUID()}.jpg`; fs.writeFileSync(path.join(MEDIA_DIR, name), processed); imageUrl = `/media/${name}`; } catch { /* best-effort */ }
      const out = await RetailClosingService.submitFromImage(orgId, storeId, date, processed.toString("base64"), "image/jpeg", { source: "image_ocr", imageUrl }, req.user?.userId);
      res.json(out);
    } catch (e: any) {
      console.error("[Retail Closing Scan] erro", e);
      res.status(500).json({ error: "Falha ao ler a folha de fechamento com a IA. Tente uma foto mais nítida ou informe os valores manualmente." });
    }
  });
});

// --- Checklist diário ---
router.get("/tasks", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json({ date: today(req), tasks: RetailTaskService.listByDate(orgId, today(req)) });
});

router.post("/tasks/generate-day", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const date = String(req.body?.date || today(req));
  res.json({ date, created: RetailTaskService.generateDay(orgId, date) });
});

router.post("/tasks/:id/mark-submitted", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const t = RetailTaskService.markSubmitted(orgId, req.params.id, { contactId: req.body?.contactId, attachmentUrl: req.body?.attachmentUrl }, req.user?.userId);
  if (!t) return res.status(404).json({ error: "task_not_found" });
  res.json(t);
});

// --- Estoque por loja + alertas de negativo (Fase F) ---
router.get("/stock/negative", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const scope = RetailStoreScopeService.allowed(orgId, req.user?.userId, req.user?.role);
  const reqStore = req.query.storeId ? String(req.query.storeId) : undefined;
  if (reqStore && !scope.unrestricted && !scope.storeIds.includes(reqStore)) {
    return res.status(403).json({ error: "store_out_of_scope" });
  }
  const { total, items } = RetailInventoryService.listNegative(orgId, {
    storeId: reqStore,
    q: req.query.q ? String(req.query.q) : undefined,
    limit: req.query.limit ? parseInt(String(req.query.limit), 10) : undefined,
    offset: req.query.offset ? parseInt(String(req.query.offset), 10) : undefined,
    restrictStoreIds: scope.unrestricted ? undefined : scope.storeIds,
  });
  res.json({ total, items });
});

router.get("/stock/by-store/:storeId", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json({ items: RetailInventoryService.byStore(orgId, req.params.storeId) });
});

// PROPOSTAS DE SOLUÇÃO DO GERENTE (LEARN, ADR-174). Criar/listar/submeter: qualquer
// usuário autenticado (o gerente propõe). Aprovar/promover/rejeitar: owner/admin.
const authorized = (req: AuthRequest) => ["owner", "admin"].includes(req.user?.role);
router.get("/solution-proposals", (req: AuthRequest, res): any => {
  const orgId = req.organizationId; if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json({ proposals: ManagerSolutionService.list(orgId, { state: req.query.state ? String(req.query.state) : undefined }) });
});
router.get("/solution-proposals/:id", (req: AuthRequest, res): any => {
  const orgId = req.organizationId; if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const p = ManagerSolutionService.get(orgId, req.params.id);
  if (!p) return res.status(404).json({ error: "not_found" });
  res.json(p);
});
router.post("/solution-proposals", (req: AuthRequest, res): any => {
  const orgId = req.organizationId; if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.status(201).json(ManagerSolutionService.create(orgId, req.body || {}, req.user?.userId)); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});
router.post("/patterns/:patternId/solution-proposals", (req: AuthRequest, res): any => {
  const orgId = req.organizationId; if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.status(201).json(ManagerSolutionService.create(orgId, { ...(req.body || {}), refType: "pattern", refId: req.params.patternId }, req.user?.userId)); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});
// LEARN-006: recupera soluções validadas relevantes a um padrão (com procedência
// + cautela). Read-only; qualquer usuário autenticado.
router.get("/patterns/:patternId/solutions", (req: AuthRequest, res): any => {
  const orgId = req.organizationId; if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json({ solutions: ManagerSolutionRetrievalService.forPattern(orgId, req.params.patternId) });
});
const solutionOp = (name: string, fn: (orgId: string, id: string, req: AuthRequest) => any, gated: boolean) => {
  const handler = (req: AuthRequest, res: any): any => {
    const orgId = req.organizationId; if (!orgId) return res.status(401).json({ error: "Unauthorized" });
    try {
      const out = fn(orgId, req.params.id, req);
      if (!out) return res.status(404).json({ error: "not_found" });
      res.json(out);
    } catch (e: any) { res.status(400).json({ error: e.message }); }
  };
  gated ? router.post(`/solution-proposals/:id/${name}`, requireRole("owner", "admin"), handler) : router.post(`/solution-proposals/:id/${name}`, handler);
};
solutionOp("submit", (o, id, req) => ManagerSolutionService.submit(o, id, req.user?.userId), false);
solutionOp("approve-test", (o, id, req) => ManagerSolutionService.approveForTest(o, id, req.user?.userId, authorized(req)), true);
solutionOp("start-test", (o, id, req) => ManagerSolutionService.startTest(o, id, req.body?.actionTaskId, req.user?.userId), true);
solutionOp("record-outcome", (o, id, req) => ManagerSolutionService.recordOutcome(o, id, { final: req.body?.final, confidence: req.body?.confidence, period: req.body?.period }, req.user?.userId), true);
solutionOp("promote", (o, id, req) => ManagerSolutionService.promote(o, id, req.user?.userId, authorized(req)), true);
solutionOp("reject", (o, id, req) => ManagerSolutionService.reject(o, id, req.body?.reason, req.user?.userId), true);
solutionOp("revoke", (o, id, req) => ManagerSolutionService.revoke(o, id, req.body?.reason, req.user?.userId), true);
solutionOp("archive", (o, id, req) => ManagerSolutionService.archive(o, id, req.user?.userId), true);

// POLÍTICA DE ESTOQUE (INV-004): mínimo/alvo por loja/produto/variante. É o que
// dá sentido a "quanto falta" no estoque negativo. Config = owner/admin (§12.1).
router.get("/stock-policies", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json({
    policies: RetailStockPolicyService.list(orgId, {
      storeId: req.query.storeId !== undefined ? String(req.query.storeId) : undefined,
      productId: req.query.productId ? String(req.query.productId) : undefined,
    }),
  });
});

router.post("/stock-policies", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    res.status(201).json(RetailStockPolicyService.set(orgId, req.body || {}, req.user?.userId));
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.delete("/stock-policies/:id", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const ok = RetailStockPolicyService.remove(orgId, req.params.id, req.user?.userId);
  if (!ok) return res.status(404).json({ error: "policy_not_found" });
  res.json({ ok: true });
});

router.get("/stock/alerts", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json({ alerts: RetailInventoryService.listAlerts(orgId, String(req.query.status || "open")) });
});

// Ajuste de saldo por loja (permite negativo → gera alerta). owner/admin.
router.post("/stock/adjust", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const { storeId, productServiceId, variantId, quantityAvailable, delta } = req.body || {};
  if (!storeId || !productServiceId) return res.status(400).json({ error: "storeId e productServiceId são obrigatórios" });
  const row = (delta !== undefined && delta !== null)
    ? RetailInventoryService.applyMovement(orgId, storeId, productServiceId, variantId, Number(delta), req.user?.userId)
    : RetailInventoryService.setQuantity(orgId, storeId, productServiceId, variantId, Number(quantityAvailable || 0), 0, req.user?.userId);
  res.json(row);
});

router.post("/stock/alerts/:id/resolve", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const a = RetailInventoryService.resolveAlert(orgId, req.params.id, req.body?.note, req.user?.userId);
  if (!a) return res.status(404).json({ error: "alert_not_found" });
  res.json(a);
});

// --- Premiação / comissão (Fase G) ---
router.get("/commission/rules", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json({ rules: RetailCommissionService.listRules(orgId) });
});

router.post("/commission/rules", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const { name, scope, period, calculationType, config, storeId } = req.body || {};
  if (!name || !calculationType) return res.status(400).json({ error: "name e calculationType são obrigatórios" });
  res.status(201).json(RetailCommissionService.createRule(orgId, { name, scope, period, calculationType, config, storeId }, req.user?.userId));
});

router.patch("/commission/rules/:id", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const r = RetailCommissionService.setRuleActive(orgId, req.params.id, req.body?.active !== false, req.user?.userId);
  if (!r) return res.status(404).json({ error: "rule_not_found" });
  res.json(r);
});

router.get("/commission/runs", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json({ runs: RetailCommissionService.listRuns(orgId) });
});

// Relatório consolidado do período (por vendedor/produto/loja) — só leitura.
router.get("/commission/report", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const start = String(req.query.start || ""), end = String(req.query.end || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) return res.status(400).json({ error: "start e end (YYYY-MM-DD) obrigatórios" });
  res.json(RetailCommissionService.report(orgId, start, end));
});

// Extrato por LOJA e por VENDEDOR ("rodar o comando" do dono da rede): loja e
// vendedor opcionais (sem filtro = rede toda); período qualquer, inclusive
// parcial dentro do mês (ex.: 1º ao dia 15) para saber o quanto já acumulou.
router.get("/commission/store-report", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const start = String(req.query.start || ""), end = String(req.query.end || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) return res.status(400).json({ error: "start e end (YYYY-MM-DD) obrigatórios" });
  const storeId = req.query.storeId ? String(req.query.storeId) : null;
  const sellerKey = req.query.sellerKey ? String(req.query.sellerKey) : null;
  res.json(RetailCommissionService.storeSellerExtract(orgId, start, end, { storeId, sellerKey }));
});

router.get("/commission/runs/:id", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const run = RetailCommissionService.getRun(orgId, req.params.id);
  if (!run) return res.status(404).json({ error: "run_not_found" });
  res.json(run);
});

// Gera a PRÉVIA do período (draft).
router.post("/commission/runs", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const { periodStart, periodEnd } = req.body || {};
  if (!periodStart || !periodEnd) return res.status(400).json({ error: "periodStart e periodEnd são obrigatórios" });
  res.status(201).json(RetailCommissionService.createRun(orgId, periodStart, periodEnd, req.user?.userId));
});

// Compara com a premiação informada manualmente (divergências).
router.post("/commission/runs/:id/compare", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const run = RetailCommissionService.compare(orgId, req.params.id, req.body?.expected || [], req.user?.userId);
  if (!run) return res.status(404).json({ error: "run_not_found" });
  res.json(run);
});

// Aprovação SEMPRE humana (D7).
router.post("/commission/runs/:id/approve", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const run = RetailCommissionService.setStatus(orgId, req.params.id, "approved", req.user?.userId);
  if (!run) return res.status(404).json({ error: "run_not_found" });
  res.json(run);
});

router.post("/commission/runs/:id/reject", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const run = RetailCommissionService.setStatus(orgId, req.params.id, "rejected", req.user?.userId);
  if (!run) return res.status(404).json({ error: "run_not_found" });
  res.json(run);
});

// Ajuste manual do gerente/dono em item DRAFT: sobrescreve o valor calculado
// (ex.: acordo com o vendedor, correção pontual) — recalcula o total do run.
router.patch("/commission/runs/:runId/items/:itemId", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const amount = Number(req.body?.commissionAmount);
  if (!Number.isFinite(amount) || amount < 0) return res.status(400).json({ error: "commissionAmount inválido (não pode ser negativo)" });
  try {
    const run = RetailCommissionService.updateItem(orgId, req.params.runId, req.params.itemId, { commissionAmount: amount }, req.user?.userId);
    res.json(run);
  } catch (e: any) {
    const map: Record<string, number> = { run_not_found: 404, run_not_editable: 409, item_not_found: 404, negative_commission: 400 };
    res.status(map[e?.message] || 400).json({ error: e?.message || "falha" });
  }
});

// Remove um item DRAFT (vendedor/loja fora da apuração) — recalcula o total.
router.delete("/commission/runs/:runId/items/:itemId", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const run = RetailCommissionService.deleteItem(orgId, req.params.runId, req.params.itemId, req.user?.userId);
    res.json(run);
  } catch (e: any) {
    const map: Record<string, number> = { run_not_found: 404, run_not_editable: 409, item_not_found: 404 };
    res.status(map[e?.message] || 400).json({ error: e?.message || "falha" });
  }
});

// --- Corrida de comissão (Fase G2 — modelo CARIOCA) + escala semanal ---------
// Plano efetivo (loja específica > rede '*' > default da planilha CARIOCA).
router.get("/commission/plan", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const storeId = req.query.storeId ? String(req.query.storeId) : null;
  res.json(RetailCommissionRaceService.getPlan(orgId, storeId));
});

router.put("/commission/plan", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const { storeId, config } = req.body || {};
  if (storeId && !RetailStoreService.get(orgId, String(storeId))) return res.status(404).json({ error: "store_not_found" });
  try {
    res.json(RetailCommissionRaceService.savePlan(orgId, storeId ? String(storeId) : null, config, req.user?.userId));
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

// Apuração da corrida do mês — SÓ LEITURA, nada persiste (RN-G2-001).
router.get("/commission/race", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const month = String(req.query.month || "");
  if (!/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: "month (YYYY-MM) é obrigatório" });
  const storeId = req.query.storeId ? String(req.query.storeId) : null;
  try { res.json(RetailCommissionRaceService.raceMonth(orgId, month, { storeId })); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

// Materializa a corrida num RUN draft (aprovação segue humana — D7).
router.post("/commission/race/run", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const month = String(req.body?.month || "");
  if (!/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: "month (YYYY-MM) é obrigatório" });
  try { res.status(201).json(RetailCommissionRaceService.createRaceRun(orgId, month, req.user?.userId)); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

// Escala semanal da loja (quadro dia × vendedor).
router.get("/schedule", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const storeId = String(req.query.storeId || "");
  const start = String(req.query.start || ""), end = String(req.query.end || "");
  if (!storeId || !/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) return res.status(400).json({ error: "storeId, start e end (YYYY-MM-DD) obrigatórios" });
  if (!RetailStoreService.get(orgId, storeId)) return res.status(404).json({ error: "store_not_found" });
  res.json({ storeId, start, end, entries: RetailCommissionRaceService.getSchedule(orgId, storeId, start, end) });
});

router.put("/schedule", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const { storeId, start, end, entries } = req.body || {};
  if (!storeId || !/^\d{4}-\d{2}-\d{2}$/.test(String(start)) || !/^\d{4}-\d{2}-\d{2}$/.test(String(end))) return res.status(400).json({ error: "storeId, start e end (YYYY-MM-DD) obrigatórios" });
  if (!Array.isArray(entries)) return res.status(400).json({ error: "entries deve ser uma lista" });
  if (!RetailStoreService.get(orgId, String(storeId))) return res.status(404).json({ error: "store_not_found" });
  res.json({ entries: RetailCommissionRaceService.saveSchedule(orgId, String(storeId), String(start), String(end), entries, req.user?.userId) });
});

router.post("/schedule/copy-week", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const { storeId, fromStart, toStart, days } = req.body || {};
  if (!storeId || !/^\d{4}-\d{2}-\d{2}$/.test(String(fromStart)) || !/^\d{4}-\d{2}-\d{2}$/.test(String(toStart))) return res.status(400).json({ error: "storeId, fromStart e toStart (YYYY-MM-DD) obrigatórios" });
  if (!RetailStoreService.get(orgId, String(storeId))) return res.status(404).json({ error: "store_not_found" });
  res.json({ entries: RetailCommissionRaceService.copyScheduleWeek(orgId, String(storeId), String(fromStart), String(toStart), Number(days) || 7, req.user?.userId) });
});

// Template de folga por vendedor (Fase G2b) — "Rafaela sempre segunda".
router.get("/schedule/off-pattern", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const storeId = String(req.query.storeId || "");
  if (!storeId) return res.status(400).json({ error: "storeId obrigatório" });
  if (!RetailStoreService.get(orgId, storeId)) return res.status(404).json({ error: "store_not_found" });
  res.json({ storeId, patterns: RetailScheduleTemplateService.list(orgId, storeId) });
});

router.put("/schedule/off-pattern", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const { storeId, patterns } = req.body || {};
  if (!storeId) return res.status(400).json({ error: "storeId obrigatório" });
  if (!Array.isArray(patterns)) return res.status(400).json({ error: "patterns deve ser uma lista" });
  if (!RetailStoreService.get(orgId, String(storeId))) return res.status(404).json({ error: "store_not_found" });
  res.json({ patterns: RetailScheduleTemplateService.save(orgId, String(storeId), patterns as any[], req.user?.userId) });
});

// Aplica o template no intervalo (só insere 'off' onde a grade tá vazia).
router.post("/schedule/apply-template", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const { storeId, start, end } = req.body || {};
  if (!storeId || !/^\d{4}-\d{2}-\d{2}$/.test(String(start)) || !/^\d{4}-\d{2}-\d{2}$/.test(String(end))) return res.status(400).json({ error: "storeId, start e end (YYYY-MM-DD) obrigatórios" });
  if (!RetailStoreService.get(orgId, String(storeId))) return res.status(404).json({ error: "store_not_found" });
  try {
    res.json(RetailScheduleTemplateService.applyToRange(orgId, String(storeId), String(start), String(end), req.user?.userId));
  } catch (e: any) { res.status(400).json({ error: e?.message || "falha" }); }
});

// Corte VARIÁVEL das semanas do mês (Fase G2c). GET devolve o override
// cadastrado + o padrão CARIOCA lado a lado, pra UI mostrar "usando o
// override" ou "usando o padrão".
router.get("/month-weeks", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const month = String(req.query.month || "");
  if (!/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: "month (YYYY-MM) obrigatório" });
  const override = RetailMonthWeeksService.getOverride(orgId, month);
  const defaultWeeks = RetailCommissionRaceService.weeksOfMonth(month);
  res.json({ month, override, defaultWeeks, effective: override || defaultWeeks, source: override ? "override" : "default" });
});

router.put("/month-weeks", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const { month, weeks } = req.body || {};
  if (!/^\d{4}-\d{2}$/.test(String(month))) return res.status(400).json({ error: "month (YYYY-MM) obrigatório" });
  try {
    const saved = RetailMonthWeeksService.save(orgId, String(month), Array.isArray(weeks) ? weeks : [], req.user?.userId);
    res.json({ month, weeks: saved, source: saved.length > 0 ? "override" : "default" });
  } catch (e: any) { res.status(400).json({ error: e?.message || "falha" }); }
});

// "Quem folga hoje/amanhã" — junta grade lançada 'off' + template do dia.
router.get("/schedule/who-off", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const date = String(req.query.date || "");
  const storeId = req.query.storeId ? String(req.query.storeId) : null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: "date (YYYY-MM-DD) obrigatório" });
  try {
    res.json({ date, sellers: RetailScheduleTemplateService.whoIsOff(orgId, date, { storeId }) });
  } catch (e: any) { res.status(400).json({ error: e?.message || "falha" }); }
});

// Cota individual do vendedor por semana da corrida.
router.get("/seller-quotas", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const storeId = String(req.query.storeId || "");
  const month = String(req.query.month || "");
  if (!storeId || !/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: "storeId e month (YYYY-MM) obrigatórios" });
  if (!RetailStoreService.get(orgId, storeId)) return res.status(404).json({ error: "store_not_found" });
  const weeks = RetailCommissionRaceService.weeksOfMonthFor(orgId, month);
  res.json({ storeId, month, weeks, quotas: RetailCommissionRaceService.listSellerQuotas(orgId, storeId, weeks.map((w) => w.start)) });
});

router.put("/seller-quotas", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const { storeId, weekStart, quotas } = req.body || {};
  if (!storeId || !/^\d{4}-\d{2}-\d{2}$/.test(String(weekStart))) return res.status(400).json({ error: "storeId e weekStart (YYYY-MM-DD) obrigatórios" });
  if (!Array.isArray(quotas)) return res.status(400).json({ error: "quotas deve ser uma lista" });
  if (!RetailStoreService.get(orgId, String(storeId))) return res.status(404).json({ error: "store_not_found" });
  res.json({ quotas: RetailCommissionRaceService.setSellerQuotas(orgId, String(storeId), String(weekStart), quotas, req.user?.userId) });
});

// --- Dashboard + acumulado mensal + export (Fase H) ---
router.get("/dashboard/daily", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json(RetailDashboardService.daily(orgId, today(req)));
});

router.get("/dashboard/monthly", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const month = String(req.query.month || new Date().toISOString().slice(0, 7));
  res.json(RetailDashboardService.monthly(orgId, month));
});

// Impact Ledger (ADR-085): valor COMPROVADO em R$ + atividade do mês.
router.get("/impact", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const month = String(req.query.month || new Date().toISOString().slice(0, 7));
  res.json(RetailImpactService.monthly(orgId, month));
});

// Capital parado em estoque + produtos sem giro (fato, não estimativa).
router.get("/impact/stock-capital", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json(RetailImpactService.stockCapital(orgId, Number(req.query.days) || 60));
});

// Painel de valor consolidado (comprovado + atividade + capital parado).
router.get("/impact/summary", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const month = String(req.query.month || new Date().toISOString().slice(0, 7));
  res.json(RetailImpactService.summary(orgId, month, Number(req.query.days) || 60));
});

// Valor ESTIMADO (tempo devolvido + ruptura evitada) — premissa à vista.
router.get("/impact/estimated", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const month = String(req.query.month || new Date().toISOString().slice(0, 7));
  const q = req.query;
  res.json(RetailImpactService.estimated(orgId, month, {
    minutesPerReminder: q.minReminder != null ? Number(q.minReminder) : undefined,
    minutesPerAiMessage: q.minAi != null ? Number(q.minAi) : undefined,
    minutesPerClosing: q.minClosing != null ? Number(q.minClosing) : undefined,
    stockMarginPercent: q.margin != null ? Number(q.margin) : undefined,
  }));
});

// Baseline dia-0: comparação "antes → agora" (capital parado, alertas, adoção).
router.get("/impact/baseline", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json(RetailImpactService.baseline(orgId));
});

// Captura explícita do baseline (orgs que ativaram antes deste recurso).
router.post("/impact/baseline/capture", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json({ captured: RetailImpactService.captureBaseline(orgId), baseline: RetailImpactService.baseline(orgId) });
});

// Tendência: série histórica do painel de valor/adoção (últimos N dias).
router.get("/impact/trend", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json({ days: Number(req.query.days) || 30, series: RetailImpactService.getTrend(orgId, Number(req.query.days) || 30) });
});

// Export do mês: JSON (rows) por padrão, ou CSV com ?format=csv.
router.get("/dashboard/monthly/export", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const month = String(req.query.month || new Date().toISOString().slice(0, 7));
  const rows = RetailDashboardService.monthlyClosingRows(orgId, month);
  if (String(req.query.format) === "csv") {
    const csv = rows.map((r) => r.map((c) => `"${String(c ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="fechamentos-${month}.csv"`);
    return res.send(csv);
  }
  res.json({ month, rows });
});

// --- Precificação em lote (ADR-083 E7) — tela "Precificar" no varejo ---
// GET lista: produto + custo médio (notas) + preço + sugestão do motor + venda
// do mês, com semáforo de risco. POST aplica em lote (só owner/admin), com
// histórico versionado (ADR-033) e sem abortar o batch por linha ruim.
// SEC-F13: custo médio + margem absoluta são owner/admin (§73), como o POST /pricing/apply.
router.get("/pricing/products", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    res.json(
      RetailPricingService.listProducts(orgId, {
        markup: req.query.markup != null ? Number(req.query.markup) : undefined,
        period: req.query.period ? String(req.query.period) : undefined,
        limit: req.query.limit != null ? Number(req.query.limit) : undefined,
      })
    );
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/pricing/apply", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  const userId = req.user?.userId;
  if (!orgId || !userId) return res.status(401).json({ error: "Unauthorized" });
  const raw = Array.isArray(req.body?.items) ? req.body.items : [];
  if (raw.length === 0) return res.status(400).json({ error: "items_required" });
  if (raw.length > 500) return res.status(400).json({ error: "too_many_items" });
  try {
    const out = RetailPricingService.applyBulk(orgId, userId, raw);
    res.json({ ok: true, ...out });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;
