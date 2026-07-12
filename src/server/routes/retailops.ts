/**
 * Retail Ops — API (ADR-083). Montada em /api/retailops, gated pelo módulo
 * `retail` (ModuleService.MODULE_BY_ROUTE["retailops"]). Fase A: cadastro de
 * lojas. Fases seguintes acrescentam cotas, fechamentos, tarefas, etc.
 */
import { Router } from "express";
import { AuthRequest, requireRole } from "../middleware/auth.js";
import { RetailStoreService } from "../RetailStoreService.js";
import { RetailQuotaService, RetailClosingService, RetailTaskService } from "../RetailOpsService.js";

const router = Router();

const today = (req: AuthRequest) => String(req.query.date || new Date().toISOString().slice(0, 10));

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

export default router;
