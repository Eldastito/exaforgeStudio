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
import { RetailQuotaService, RetailClosingService, RetailTaskService } from "../RetailOpsService.js";
import { RetailInventoryService } from "../RetailInventoryService.js";
import { RetailCommissionService } from "../RetailCommissionService.js";
import { isAIConfigured } from "../llm.js";

const router = Router();

const today = (req: AuthRequest) => String(req.query.date || new Date().toISOString().slice(0, 10));

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

export default router;
