import { Router } from "express";
import db from "../db.js";
import { AuthRequest } from "../middleware/auth.js";
import { PurchaseRequisitionService } from "../PurchaseRequisitionService.js";
import { SupplierQuoteService } from "../SupplierQuoteService.js";
import { SupplyNetworkService } from "../SupplyNetworkService.js";

const router = Router();

// GET /api/procurement/suppliers — lista os fornecedores cadastrados.
router.get("/suppliers", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const rows = db.prepare(`SELECT id, name, identifier, supplier_categories FROM contacts WHERE organization_id = ? AND COALESCE(is_supplier,0) = 1 ORDER BY name ASC`).all(orgId);
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

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
// Aprovar envia automaticamente a cotação aos fornecedores cadastrados.
router.post("/requisition/:id/approve", async (req: AuthRequest, res): Promise<any> => {
  const orgId = req.organizationId;
  const userId = req.user?.userId;
  if (!orgId || !userId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const ok = PurchaseRequisitionService.approve(orgId, req.params.id, userId);
    if (!ok) return res.json({ success: false });
    let sent = 0;
    try {
      const r = await SupplierQuoteService.sendQuotes(orgId, req.params.id, (global as any).io);
      sent = r.sent;
    } catch (e) { console.error('[Supply] Falha ao disparar cotações', e); }
    res.json({ success: true, quotesSent: sent });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// GET /api/procurement/requisition/:id/quotes — comparativo de cotações.
router.get("/requisition/:id/quotes", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    res.json(SupplierQuoteService.listByRequisition(orgId, req.params.id));
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// POST /api/procurement/quote/:id/accept — escolhe o fornecedor vencedor.
router.post("/quote/:id/accept", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const ok = SupplierQuoteService.accept(orgId, req.params.id);
    res.json({ success: ok });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ============================================================================
// REDE ZAPPFLOW (Fase 3) — perfil de fornecedora + busca + inbox.
// ============================================================================

// GET /api/procurement/network/profile — perfil da org como fornecedora.
router.get("/network/profile", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(SupplyNetworkService.profile(orgId)); }
  catch (e: any) { res.status(500).json({ error: e.message }); }
});

// PUT /api/procurement/network/profile — liga/desliga + geocoda quando muda cidade.
router.put("/network/profile", async (req: AuthRequest, res): Promise<any> => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    await SupplyNetworkService.saveProfile(orgId, req.body || {});
    res.json({ success: true, profile: SupplyNetworkService.profile(orgId) });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// GET /api/procurement/network/suppliers — busca livre na rede (emergência).
// Query: category (csv), maxKm, q (texto).
router.get("/network/suppliers", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const categories = String((req.query as any).category || "").split(",").map(s => s.trim()).filter(Boolean);
    const maxKm = (req.query as any).maxKm ? parseInt(String((req.query as any).maxKm), 10) : undefined;
    const query = String((req.query as any).q || "");
    res.json(SupplyNetworkService.listSuppliers(orgId, { categories, maxDistanceKm: maxKm, query }));
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// GET /api/procurement/network/incoming — cotações recebidas pela org como fornecedora.
router.get("/network/incoming", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(SupplierQuoteService.incomingForNetwork(orgId)); }
  catch (e: any) { res.status(500).json({ error: e.message }); }
});

// POST /api/procurement/network/quote/:id/answer — fornecedor preenche e envia.
router.post("/network/quote/:id/answer", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const ok = SupplierQuoteService.submitNetworkAnswer(orgId, req.params.id, req.body || { items: [] });
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
