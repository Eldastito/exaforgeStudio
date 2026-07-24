/**
 * Retail Ops — API (ADR-083). Montada em /api/retailops, gated pelo módulo
 * `retail` (ModuleService.MODULE_BY_ROUTE["retailops"]). Fase A: cadastro de
 * lojas. Fases seguintes acrescentam cotas, fechamentos, tarefas, etc.
 */
import { Router } from "express";
import multer from "multer";
import sharp from "sharp";
import fs from "fs";
import path from "path";
import { randomUUID } from "node:crypto";
import { AuthRequest, requireRole } from "../middleware/auth.js";
import { RetailStoreService } from "../RetailStoreService.js";
import { RetailQuotaService, RetailClosingService, RetailTaskService, RetailResponsibleService } from "../RetailOpsService.js";
import { RetailInventoryService } from "../RetailInventoryService.js";
import { RetailCommissionService } from "../RetailCommissionService.js";
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
  const store = RetailStoreService.update(orgId, req.params.id, req.body || {}, req.user?.userId);
  if (!store) return res.status(404).json({ error: "store_not_found" });
  res.json(store);
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
  res.json({ items: RetailInventoryService.listNegative(orgId) });
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
