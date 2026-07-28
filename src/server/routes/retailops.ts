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
import { RetailQuotaService, RetailClosingService, RetailTaskService, RetailResponsibleService } from "../RetailOpsService.js";
import { RetailInventoryService } from "../RetailInventoryService.js";
import { RetailTransferService } from "../RetailTransferService.js";
import { haversineKm } from "../geo.js";
import { RetailCommissionService } from "../RetailCommissionService.js";
import { RetailSellerSalesService } from "../RetailSellerSalesService.js";
import { RetailDashboardService } from "../RetailDashboardService.js";
import { RetailActivationService } from "../RetailActivationService.js";
import { RetailImpactService } from "../RetailImpactService.js";
import { RetailStockModeService } from "../RetailStockModeService.js";
import { RetailGraduationService } from "../RetailGraduationService.js";
import { RetailAdoptionService } from "../RetailAdoptionService.js";
import { RetailDiagnosticService } from "../RetailDiagnosticService.js";
import { RetailReconciliationService } from "../RetailReconciliationService.js";
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

const router = Router();

const csvUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

const today = (req: AuthRequest) => String(req.query.date || new Date().toISOString().slice(0, 10));

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
  const priorities = ImpactPrioritizationService.prioritize(orgId, { globalLimit: 8 })?.global || [];
  const patterns = RetailPatternMemoryService.list(orgId, { status: "validated" });
  const open = BusinessSignalService.list(orgId, { status: "open" });
  const bySeverity: Record<string, number> = { critical: 0, risk: 0, attention: 0, info: 0 };
  for (const s of open) bySeverity[s.severity] = (bySeverity[s.severity] || 0) + 1;
  res.json({ priorities, patterns, openCount: open.length, bySeverity });
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
  try { res.json({ stores: RetailStoreService.list(orgId) }); }
  catch (e: any) { res.status(500).json({ error: e.message }); }
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
  try {
    // Casa o produto do ERP (13 díg.) com a variante/produto do catálogo p/ o
    // nome; o dígito extra do saldo (13 vs 12) é tolerado com o prefixo.
    const rows = db.prepare(
      `SELECT i.produto,
              COALESCE(pv.name, ps.name, p2.name) AS nome_variante,
              COALESCE(pp.name, p2.name) AS nome_produto,
              SUM(i.quantidade) AS pecas, SUM(i.valor) AS valor, COUNT(*) AS linhas
         FROM retail_pdv_sale_items i
         LEFT JOIN product_variants pv ON pv.organization_id = i.organization_id AND (pv.external_ref = i.produto OR pv.sku = i.produto)
         LEFT JOIN products_services pp ON pp.id = pv.product_service_id
         LEFT JOIN products_services ps ON ps.organization_id = i.organization_id AND ps.external_ref = i.produto
         LEFT JOIN products_services p2 ON p2.organization_id = i.organization_id AND i.produto LIKE p2.external_ref || '%' AND length(p2.external_ref) >= 4
        WHERE i.organization_id = ? AND i.sale_date BETWEEN ? AND ? AND COALESCE(i.produto,'') <> '' ${filialClause}
        GROUP BY i.produto
        ORDER BY pecas DESC, valor DESC
        LIMIT 100`
    ).all(...args) as any[];
    res.json({ start, end, products: rows.map((r) => ({ produto: r.produto, nome: r.nome_produto || r.nome_variante || null, variante: r.nome_variante, pecas: Math.round(Number(r.pecas || 0)), valor: Math.round(Number(r.valor || 0) * 100) / 100 })) });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// CLIENTES DO PDV (Fase 3, opt-in): busca por nome/CPF/celular + aniversariantes
// do mês (?birthdayMonth=MM). Base separada dos contatos do WhatsApp.
router.get("/pdv-customers", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const q = String(req.query.q || "").trim();
  const bMonth = String(req.query.birthdayMonth || "").trim().padStart(2, "0");
  const limit = Math.min(500, Math.max(1, parseInt(String(req.query.limit || "100"), 10) || 100));
  const offset = Math.max(0, parseInt(String(req.query.offset || "0"), 10) || 0);
  const where: string[] = ["organization_id = ?"]; const args: any[] = [orgId];
  if (q) { where.push("(nome LIKE ? OR cpf LIKE ? OR celular LIKE ?)"); const like = `%${q}%`; args.push(like, like, like); }
  if (/^\d{2}$/.test(bMonth)) { where.push("substr(nascimento, 6, 2) = ?"); args.push(bMonth); }
  try {
    const total = Number((db.prepare(`SELECT COUNT(*) c FROM retail_pdv_customers WHERE ${where.join(" AND ")}`).get(...args) as any)?.c || 0);
    const rows = db.prepare(
      `SELECT codigo_n, nome, cpf, celular, email, nascimento, filial, cidade, ultima_compra
         FROM retail_pdv_customers WHERE ${where.join(" AND ")}
        ORDER BY nome LIMIT ? OFFSET ?`
    ).all(...args, limit, offset) as any[];
    res.json({ total, customers: rows });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// RECEBÍVEIS DE CARTÃO (parcelasCartao do PDV): por dia de VENCIMENTO — bruto,
// líquido (o que entra), taxa retida — + totais do período. ?store filtra filial.
router.get("/pdv-card-receivables", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const start = String(req.query.start || "").slice(0, 10);
  const end = String(req.query.end || "").slice(0, 10);
  if (!start || !end) return res.status(400).json({ error: "start e end são obrigatórios (YYYY-MM-DD)" });
  const filial = String(req.query.store || "").trim();
  const args: any[] = [orgId, start, end];
  let filialClause = "";
  if (filial) { filialClause = "AND filial = ?"; args.push(filial); }
  try {
    const rows = db.prepare(
      `SELECT vencimento, COUNT(*) AS parcelas, SUM(valor) AS bruto, SUM(liquido) AS liquido
         FROM retail_pdv_card_installments
        WHERE organization_id = ? AND vencimento BETWEEN ? AND ? ${filialClause}
        GROUP BY vencimento ORDER BY vencimento`
    ).all(...args) as any[];
    const totals = rows.reduce((a, r) => ({
      parcelas: a.parcelas + Number(r.parcelas || 0),
      bruto: a.bruto + Number(r.bruto || 0),
      liquido: a.liquido + Number(r.liquido || 0),
    }), { parcelas: 0, bruto: 0, liquido: 0 });
    totals.taxa = Math.round((totals.bruto - totals.liquido) * 100) / 100;
    res.json({ start, end, byDay: rows.map((r) => ({ vencimento: r.vencimento, parcelas: Number(r.parcelas), bruto: Math.round(Number(r.bruto) * 100) / 100, liquido: Math.round(Number(r.liquido) * 100) / 100 })), totals });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// DIAGNÓSTICO da anomalia do vendedor: por matrícula do CAIXA, mostra em quantas
// LOJAS ela aparece e se há vendedor por-linha nos itens — para descobrir se a
// matrícula é do operador (compartilhada) ou do vendedor real.
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
    res.json({ byMatricula, lineSellers });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// MAPEAMENTO matrícula → vendedor (Fase 4): dá nome à matrícula do ERP.
// GET devolve os mapeados + as matrículas vistas nas vendas ainda sem nome.
router.get("/sellers", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const sellers = db.prepare(`SELECT matricula, name, user_id, active FROM retail_sellers WHERE organization_id = ? ORDER BY name`).all(orgId) as any[];
  const unmapped = (db.prepare(
    `SELECT DISTINCT vendedor FROM retail_pdv_sales
      WHERE organization_id = ? AND COALESCE(vendedor, '') <> ''
        AND vendedor NOT IN (SELECT matricula FROM retail_sellers WHERE organization_id = ?)
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
  res.json(db.prepare(`SELECT matricula, name, user_id, active FROM retail_sellers WHERE organization_id = ? AND matricula = ?`).get(orgId, matricula));
});

// VENDAS POR VENDEDOR do PDV (Fase 4): agregado do stream VendaMalote —
// matrícula, loja, total vendido, nº de vendas e peças no período.
router.get("/pdv-sellers", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const start = String(req.query.start || "").slice(0, 10);
  const end = String(req.query.end || "").slice(0, 10);
  if (!start || !end) return res.status(400).json({ error: "start e end são obrigatórios (YYYY-MM-DD)" });
  try {
    const rows = db.prepare(
      `SELECT s.vendedor, s.filial, COALESCE(st.name, 'Filial ' || s.filial) AS store_name,
              rs.name AS seller_name,
              SUM(s.valor) AS sales, COUNT(*) AS orders, SUM(s.pecas) AS pecas
         FROM retail_pdv_sales s
         LEFT JOIN retail_stores st ON st.organization_id = s.organization_id AND st.code = s.filial AND st.active = 1
         LEFT JOIN retail_sellers rs ON rs.organization_id = s.organization_id AND rs.matricula = s.vendedor
        WHERE s.organization_id = ? AND s.sale_date BETWEEN ? AND ?
          AND COALESCE(s.status, 'N') <> 'C' AND COALESCE(s.vendedor, '') <> ''
        GROUP BY s.vendedor, s.filial
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
  const minDonor = Math.max(1, parseInt(String(req.query.minDonor || "2"), 10) || 2);
  const limit = Math.min(500, Math.max(10, parseInt(String(req.query.limit || "200"), 10) || 200));
  try {
    const rows = db.prepare(`
      WITH carrier AS (
        SELECT rsi.store_id, rsi.product_service_id,
               SUM(CASE WHEN rsi.quantity_available > 0 THEN rsi.quantity_available ELSE 0 END) AS tot
          FROM retail_store_inventory rsi
          JOIN retail_stores s ON s.id = rsi.store_id AND s.active = 1
         WHERE rsi.organization_id = ?
         GROUP BY rsi.store_id, rsi.product_service_id
        HAVING tot > 0
      )
      SELECT p.name AS product_name, COALESCE(v.name, '—') AS variant_name, v.size, v.color,
             sn.name AS needy_store, sd.name AS donor_store, sd.code AS donor_code, d.quantity_available AS donor_qty,
             c.store_id AS needy_store_id, d.store_id AS donor_store_id,
             d.product_service_id, d.variant_id,
             sn.latitude AS needy_lat, sn.longitude AS needy_lng, sd.latitude AS donor_lat, sd.longitude AS donor_lng
        FROM retail_store_inventory d
        JOIN retail_stores sd ON sd.id = d.store_id AND sd.active = 1
        JOIN carrier c ON c.product_service_id = d.product_service_id AND c.store_id <> d.store_id
        JOIN retail_stores sn ON sn.id = c.store_id
        JOIN products_services p ON p.id = d.product_service_id
        LEFT JOIN product_variants v ON v.id = d.variant_id
        LEFT JOIN retail_store_inventory n ON n.store_id = c.store_id AND n.product_service_id = d.product_service_id AND COALESCE(n.variant_id, '') = COALESCE(d.variant_id, '')
       WHERE d.organization_id = ? AND d.quantity_available >= ? AND d.variant_id IS NOT NULL AND d.variant_id <> ''
         AND COALESCE(n.quantity_available, 0) <= 0
       ORDER BY d.quantity_available DESC, p.name ASC
       LIMIT ?
    `).all(orgId, orgId, minDonor, limit) as any[];
    // Fase 3: anota a DISTÂNCIA (loja com sobra ↔ loja com falta) e o melhor
    // horário da loja de origem; ordena as mais PRÓXIMAS primeiro (sem coords
    // vai para o fim). O código da loja alimenta o melhor horário via PDV.
    const timeCache = new Map<string, string>();
    const suggestions = rows.map((r) => {
      const dist = haversineKm(r.needy_lat, r.needy_lng, r.donor_lat, r.donor_lng);
      const code = String(r.donor_code || "");
      if (!timeCache.has(code)) timeCache.set(code, RetailTransferService.suggestBestWindow(orgId, code));
      const { needy_lat, needy_lng, donor_lat, donor_lng, ...rest } = r;
      return { ...rest, distance_km: Number.isFinite(dist) ? dist : null, best_time: timeCache.get(code) };
    }).sort((a, b) => (a.distance_km == null ? Infinity : a.distance_km) - (b.distance_km == null ? Infinity : b.distance_km));
    res.json({ count: suggestions.length, suggestions });
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
  res.json(c);
});

router.post("/closings/:id/reject", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const c = RetailClosingService.setStatus(orgId, req.params.id, "rejected", req.user?.userId);
  if (!c) return res.status(404).json({ error: "closing_not_found" });
  res.json(c);
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
  const { total, items } = RetailInventoryService.listNegative(orgId, {
    storeId: req.query.storeId ? String(req.query.storeId) : undefined,
    q: req.query.q ? String(req.query.q) : undefined,
    limit: req.query.limit ? parseInt(String(req.query.limit), 10) : undefined,
    offset: req.query.offset ? parseInt(String(req.query.offset), 10) : undefined,
  });
  res.json({ total, items });
});

router.get("/stock/by-store/:storeId", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json({ items: RetailInventoryService.byStore(orgId, req.params.storeId) });
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
  const { name, scope, period, calculationType, config } = req.body || {};
  if (!name || !calculationType) return res.status(400).json({ error: "name e calculationType são obrigatórios" });
  res.status(201).json(RetailCommissionService.createRule(orgId, { name, scope, period, calculationType, config }, req.user?.userId));
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

export default router;
