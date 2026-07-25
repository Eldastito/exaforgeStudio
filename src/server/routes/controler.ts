/**
 * CONTROLER — API (PRD-E-007). Controladoria Operacional de Consumo e Custos.
 * Montada em /api/controler. Fatia 1a: fundação de Departamentos e Centros de
 * Custo (dimensões em que todo consumo/custo futuro será apropriado).
 *
 * Aditivo e opt-in — não altera nenhum fluxo existente. Escrita é owner/admin
 * (RBAC por perfil vem numa fatia dedicada, junto do módulo `controler`).
 * Isolado por organização (organizationId do JWT). Auditável.
 */
import { Router } from "express";
import { AuthRequest, requireRole } from "../middleware/auth.js";
import { DepartmentService } from "../DepartmentService.js";
import { CostCenterService } from "../CostCenterService.js";
import { InventoryLocationService } from "../InventoryLocationService.js";
import { OperationalItemService } from "../OperationalItemService.js";
import { MaterialRequestService } from "../MaterialRequestService.js";
import { ConsumptionLedgerService } from "../ConsumptionLedgerService.js";

const router = Router();
const actor = (req: AuthRequest) => req.user?.userId;
const truthy = (v: any) => v === "1" || v === "true" || v === true;

// ─── Departamentos ────────────────────────────────────────────────────────────
router.get("/departments", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const includeInactive = truthy(req.query?.includeInactive);
  res.json({ departments: DepartmentService.list(orgId, { includeInactive }) });
});

router.get("/departments/tree", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json({ tree: DepartmentService.tree(orgId, { includeInactive: truthy(req.query?.includeInactive) }) });
});

router.post("/departments", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.status(201).json(DepartmentService.create(orgId, req.body || {}, actor(req))); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.put("/departments/:id", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(DepartmentService.update(orgId, req.params.id, req.body || {}, actor(req))); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.post("/departments/:id/active", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(DepartmentService.setActive(orgId, req.params.id, !!req.body?.active, actor(req))); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

// ─── Centros de custo ───────────────────────────────────────────────────────────
router.get("/cost-centers", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json({ costCenters: CostCenterService.list(orgId, { includeInactive: truthy(req.query?.includeInactive), departmentId: typeof req.query?.departmentId === "string" ? req.query.departmentId : undefined }) });
});

router.post("/cost-centers", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.status(201).json(CostCenterService.create(orgId, req.body || {}, actor(req))); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.put("/cost-centers/:id", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(CostCenterService.update(orgId, req.params.id, req.body || {}, actor(req))); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.post("/cost-centers/:id/active", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(CostCenterService.setActive(orgId, req.params.id, !!req.body?.active, actor(req))); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

// ─── Localizações de estoque (Fatia 1b) ─────────────────────────────────────────
router.get("/inventory-locations", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json({ locations: InventoryLocationService.list(orgId, { includeInactive: truthy(req.query?.includeInactive), type: typeof req.query?.type === "string" ? req.query.type : undefined }) });
});

router.post("/inventory-locations", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.status(201).json(InventoryLocationService.create(orgId, req.body || {}, actor(req))); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.put("/inventory-locations/:id", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(InventoryLocationService.update(orgId, req.params.id, req.body || {}, actor(req))); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.post("/inventory-locations/:id/active", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(InventoryLocationService.setActive(orgId, req.params.id, !!req.body?.active, actor(req))); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.get("/inventory-locations/balances", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json({ balances: InventoryLocationService.balances(orgId, { locationId: typeof req.query?.locationId === "string" ? req.query.locationId : undefined, productId: typeof req.query?.productId === "string" ? req.query.productId : undefined }) });
});

router.post("/inventory-locations/receive", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const b = req.body || {};
  try { res.status(201).json(InventoryLocationService.receive(orgId, { locationId: b.locationId, productId: b.productId, variantId: b.variantId, quantity: Number(b.quantity) }, actor(req))); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.post("/inventory-locations/transfer", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const b = req.body || {};
  try { res.status(201).json(InventoryLocationService.transfer(orgId, { fromLocationId: b.fromLocationId, toLocationId: b.toLocationId, productId: b.productId, variantId: b.variantId, quantity: Number(b.quantity) }, actor(req))); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

// ─── Classificação operacional do item (Fatia 1c) ───────────────────────────────
router.get("/items/types", (_req: AuthRequest, res): any => {
  res.json({ types: OperationalItemService.ITEM_TYPES });
});

router.get("/items", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const consumptionControlled = req.query?.consumptionControlled === undefined ? undefined : truthy(req.query.consumptionControlled);
  res.json({ items: OperationalItemService.list(orgId, { type: typeof req.query?.type === "string" ? req.query.type : undefined, consumptionControlled }) });
});

router.get("/items/:id", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const it = OperationalItemService.get(orgId, req.params.id);
  if (!it) return res.status(404).json({ error: "Produto não encontrado." });
  res.json(it);
});

router.put("/items/:id/classification", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(OperationalItemService.classify(orgId, req.params.id, req.body || {}, actor(req))); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

// ─── Requisição interna e consumo (Fatia 2) ─────────────────────────────────────
router.get("/material-requests", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json({ requests: MaterialRequestService.list(orgId, { status: typeof req.query?.status === "string" ? req.query.status : undefined, departmentId: typeof req.query?.departmentId === "string" ? req.query.departmentId : undefined }) });
});

router.get("/material-requests/:id", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const r = MaterialRequestService.get(orgId, req.params.id);
  if (!r) return res.status(404).json({ error: "Requisição não encontrada." });
  res.json(r);
});

// Criar requisição: qualquer usuário autenticado pode solicitar.
router.post("/material-requests", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.status(201).json(MaterialRequestService.create(orgId, req.body || {}, actor(req))); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

// Ações do ciclo de vida (aprovar/retirar/etc.): owner/admin (RBAC de perfil vem depois).
const lifecycle: Array<[string, (orgId: string, id: string, req: AuthRequest) => any]> = [
  ["approve", (o, id, r) => MaterialRequestService.approve(o, id, actor(r), { items: r.body?.items })],
  ["reject", (o, id, r) => MaterialRequestService.reject(o, id, actor(r), r.body?.reason)],
  ["cancel", (o, id, r) => MaterialRequestService.cancel(o, id, actor(r))],
  ["issue", (o, id, r) => MaterialRequestService.issue(o, id, actor(r), { fromLocationId: r.body?.fromLocationId })],
  ["acknowledge", (o, id, r) => MaterialRequestService.acknowledge(o, id, actor(r))],
  ["return", (o, id, r) => MaterialRequestService.returnItems(o, id, { items: r.body?.items, toLocationId: r.body?.toLocationId }, actor(r))],
];
for (const [action, fn] of lifecycle) {
  router.post(`/material-requests/:id/${action}`, requireRole("owner", "admin"), (req: AuthRequest, res): any => {
    const orgId = req.organizationId;
    if (!orgId) return res.status(401).json({ error: "Unauthorized" });
    try { res.json(fn(orgId, req.params.id, req)); }
    catch (e: any) { res.status(400).json({ error: e.message }); }
  });
}

// Médias/cobertura de consumo de um produto (derivadas do ledger).
router.get("/consumption/:productId/average", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const windowDays = Number(req.query?.windowDays) || 30;
  const avg = ConsumptionLedgerService.dailyAverage(orgId, req.params.productId, { windowDays });
  const balanceRaw = req.query?.balance;
  const coverage = balanceRaw !== undefined ? ConsumptionLedgerService.coverageDays(orgId, req.params.productId, Number(balanceRaw), { windowDays }) : null;
  res.json({ ...avg, coverageDays: coverage });
});

router.get("/consumption/by-cost-center", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json({ items: ConsumptionLedgerService.byCostCenter(orgId, { from: typeof req.query?.from === "string" ? req.query.from : undefined, to: typeof req.query?.to === "string" ? req.query.to : undefined }) });
});

export default router;
