import { Router } from "express";
import db from "../db.js";
import { AuthRequest } from "../middleware/auth.js";
import { PurchaseRequisitionService } from "../PurchaseRequisitionService.js";

const router = Router();

// GET /api/procurement/settings — opt-in + alvo de cobertura em dias.
router.get("/settings", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const o = db.prepare(`SELECT procurement_enabled, procurement_target_days FROM organization_settings WHERE organization_id = ?`).get(orgId) as any || {};
    res.json({ enabled: !!o.procurement_enabled, targetDays: o.procurement_target_days || 14 });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.put("/settings", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const { enabled, targetDays } = req.body || {};
    const days = Math.min(180, Math.max(1, parseInt(String(targetDays), 10) || 14));
    db.prepare(`UPDATE organization_settings SET procurement_enabled = ?, procurement_target_days = ? WHERE organization_id = ?`)
      .run(enabled ? 1 : 0, days, orgId);
    res.json({ success: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// GET /api/procurement/requisition — a requisição aberta da org (com itens enriquecidos).
router.get("/requisition", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const o = db.prepare(`SELECT COALESCE(procurement_target_days,14) AS target FROM organization_settings WHERE organization_id = ?`).get(orgId) as any || {};
    // Recalcula a cada GET para refletir o estoque atual (idempotente).
    const r = PurchaseRequisitionService.syncDraft(orgId, o.target);
    if (!r) return res.json({ requisition: null, items: [] });
    const req = db.prepare(`SELECT * FROM purchase_requisitions WHERE id = ?`).get(r.id) as any;
    const items = db.prepare(`
      SELECT i.*, p.name AS product_name, pv.name AS variant_name, p.price AS unit_price
      FROM purchase_requisition_items i
      JOIN products_services p ON p.id = i.product_service_id
      LEFT JOIN product_variants pv ON pv.id = i.variant_id
      WHERE i.requisition_id = ?
      ORDER BY i.days_of_cover ASC NULLS FIRST, i.current_stock ASC
    `).all(r.id) as any[];
    res.json({ requisition: req, items });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// POST /api/procurement/requisition/:id/approve
router.post("/requisition/:id/approve", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  const userId = req.user?.userId;
  if (!orgId || !userId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const ok = PurchaseRequisitionService.approve(orgId, req.params.id, userId);
    res.json({ success: ok });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// POST /api/procurement/requisition/:id/dismiss
router.post("/requisition/:id/dismiss", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const ok = PurchaseRequisitionService.dismiss(orgId, req.params.id);
    res.json({ success: ok });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;
