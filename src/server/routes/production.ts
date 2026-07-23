import { Router } from "express";
import { AuthRequest, requirePermission } from "../middleware/auth.js";
import { ProductionService } from "../ProductionService.js";
import { ProductionOrderService } from "../ProductionOrderService.js";
import { ProductionShopFloorService } from "../ProductionShopFloorService.js";
import { ProductionSignalPublisher } from "../ProductionSignalPublisher.js";

// Produção (Supervisor de Produção IA, ADR-141) — produto fabricado + BOM +
// necessidade de materiais. Gateado pelo módulo `production` (só gestores por
// padrão; via fallback, owner/admin). Isolado por organização.
const router = Router();
const orgOf = (req: AuthRequest) => req.organizationId as string;

router.get("/products", requirePermission("production", "read"), (req: AuthRequest, res): any => {
  res.json({ products: ProductionService.listProducts(orgOf(req)) });
});
router.post("/products", requirePermission("production", "write"), (req: AuthRequest, res): any => {
  const r = ProductionService.createProduct(orgOf(req), { productServiceId: req.body?.productServiceId, name: req.body?.name });
  if (!r.ok) return res.status(400).json({ error: r.error });
  res.status(201).json(r);
});

router.post("/products/:id/bom", requirePermission("production", "write"), (req: AuthRequest, res): any => {
  const r = ProductionService.createBom(orgOf(req), req.params.id, req.body?.name);
  if (!r.ok) return res.status(400).json({ error: r.error });
  res.status(201).json(r);
});

router.get("/bom/:id", requirePermission("production", "read"), (req: AuthRequest, res): any => {
  const bom = ProductionService.getBom(orgOf(req), req.params.id);
  if (!bom) return res.status(404).json({ error: "BOM não encontrada." });
  res.json(bom);
});
router.post("/bom/:id/items", requirePermission("production", "write"), (req: AuthRequest, res): any => {
  const b = req.body || {};
  const r = ProductionService.addBomItem(orgOf(req), req.params.id, { materialProductServiceId: b.materialProductServiceId, quantity: b.quantity, unit: b.unit });
  if (!r.ok) return res.status(400).json({ error: r.error });
  res.status(201).json(r);
});

// GET /api/production/bom/:id/requirements?quantity=100 — necessidade de materiais.
router.get("/bom/:id/requirements", requirePermission("production", "read"), (req: AuthRequest, res): any => {
  const quantity = Number(req.query?.quantity) || 0;
  const r = ProductionService.materialRequirements(orgOf(req), req.params.id, quantity);
  if (!r) return res.status(404).json({ error: "BOM não encontrada." });
  res.json(r);
});

// ── Ordens de produção (fatia 2) ──
router.get("/orders", requirePermission("production", "read"), (req: AuthRequest, res): any => {
  const status = typeof req.query?.status === "string" ? req.query.status : undefined;
  res.json({ orders: ProductionOrderService.list(orgOf(req), { status }) });
});
router.post("/orders", requirePermission("production", "write"), (req: AuthRequest, res): any => {
  const b = req.body || {};
  const r = ProductionOrderService.create(orgOf(req), { manufacturedProductId: b.manufacturedProductId, bomId: b.bomId, qtyPlanned: b.qtyPlanned, promisedDate: b.promisedDate, expectedDate: b.expectedDate, createdBy: req.user?.userId });
  if (!r.ok) return res.status(400).json({ error: r.error });
  res.status(201).json(r);
});
router.get("/orders/:id", requirePermission("production", "read"), (req: AuthRequest, res): any => {
  const o = ProductionOrderService.get(orgOf(req), req.params.id);
  if (!o) return res.status(404).json({ error: "Ordem não encontrada." });
  res.json(o);
});

router.post("/orders/:id/steps", requirePermission("production", "write"), (req: AuthRequest, res): any => {
  const b = req.body || {};
  const r = ProductionOrderService.addStep(orgOf(req), req.params.id, { name: b.name, seq: b.seq, assignedTo: b.assignedTo });
  if (!r.ok) return res.status(400).json({ error: r.error });
  res.status(201).json(r);
});
router.put("/steps/:id", requirePermission("production", "write"), (req: AuthRequest, res): any => {
  const r = ProductionOrderService.setStepStatus(orgOf(req), req.params.id, req.body?.status);
  if (!r.ok) return res.status(400).json({ error: r.error });
  res.json(r);
});

// Liberar a ordem (aprovação por perfil — gestor de produção).
router.post("/orders/:id/release", requirePermission("production", "write"), (req: AuthRequest, res): any => {
  const r = ProductionOrderService.release(orgOf(req), req.params.id, { createdBy: req.user?.userId });
  if (!r.ok) return res.status(400).json({ error: r.error });
  res.json(r);
});
// Apontamento de progresso/refugo.
router.post("/orders/:id/report", requirePermission("production", "write"), (req: AuthRequest, res): any => {
  const b = req.body || {};
  const r = ProductionOrderService.report(orgOf(req), req.params.id, { producedQty: b.producedQty, scrappedQty: b.scrappedQty, stepId: b.stepId, note: b.note, createdBy: req.user?.userId });
  if (!r.ok) return res.status(400).json({ error: r.error });
  res.json(r);
});
router.post("/orders/:id/cancel", requirePermission("production", "write"), (req: AuthRequest, res): any => {
  const r = ProductionOrderService.cancel(orgOf(req), req.params.id, { createdBy: req.user?.userId });
  if (!r.ok) return res.status(400).json({ error: r.error });
  res.json(r);
});

// ── Chão de fábrica (fatia 3): consumo / qualidade / parada ──
router.post("/orders/:id/consume", requirePermission("production", "write"), (req: AuthRequest, res): any => {
  const b = req.body || {};
  const r = b.fromBom
    ? ProductionShopFloorService.consumeForBom(orgOf(req), req.params.id, b.quantity, { createdBy: req.user?.userId })
    : ProductionShopFloorService.consumeMaterial(orgOf(req), req.params.id, { materialProductServiceId: b.materialProductServiceId, quantity: b.quantity, note: b.note, createdBy: req.user?.userId });
  if (!r.ok) return res.status(400).json({ error: r.error });
  res.status(201).json(r);
});
router.post("/orders/:id/quality", requirePermission("production", "write"), (req: AuthRequest, res): any => {
  const b = req.body || {};
  const r = ProductionShopFloorService.addQualityCheck(orgOf(req), req.params.id, { name: b.name, passed: b.passed, stepId: b.stepId, notes: b.notes, createdBy: req.user?.userId });
  if (!r.ok) return res.status(400).json({ error: r.error });
  res.status(201).json(r);
});
router.post("/orders/:id/downtime", requirePermission("production", "write"), (req: AuthRequest, res): any => {
  const b = req.body || {};
  const r = ProductionShopFloorService.addDowntime(orgOf(req), req.params.id, { reason: b.reason, minutes: b.minutes, note: b.note, createdBy: req.user?.userId });
  if (!r.ok) return res.status(400).json({ error: r.error });
  res.status(201).json(r);
});

// Publica os sinais de produção (atraso/falta/refugo) no ledger transversal
// — de onde já fluem para o Pareto e o briefing. Idempotente por dia.
router.post("/signals/refresh", requirePermission("production", "write"), (req: AuthRequest, res): any => {
  res.json(ProductionSignalPublisher.run(orgOf(req), { asOfDate: req.body?.asOfDate, scrapTargetPct: req.body?.scrapTargetPct }));
});

export default router;
