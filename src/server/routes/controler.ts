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

export default router;
