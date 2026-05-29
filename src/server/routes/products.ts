import { Router } from "express";
import db from "../db.js";
import { v4 as uuidv4 } from "uuid";
import { AuthRequest } from "../middleware/auth.js";

const router = Router();

const logAuthEvent = (orgId: string | undefined, actorId: string | undefined, targetId: string | undefined, eventType: string, meta: any = {}) => {
  try {
    db.prepare(`
      INSERT INTO auth_audit_logs (id, organization_id, actor_user_id, target_user_id, event_type, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(uuidv4(), orgId || null, actorId || null, targetId || null, eventType, JSON.stringify(meta));
  } catch(e) {
    console.error("Failed to log auth event", e);
  }
};

router.get("/", (req: AuthRequest, res) => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });

  try {
    const products = db.prepare('SELECT * FROM products_services WHERE organization_id = ?').all(orgId);
    res.json(products);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/", (req: AuthRequest, res) => {
  const orgId = req.organizationId;
  const userId = req.user?.userId;
  if (!orgId || !userId) return res.status(401).json({ error: "Unauthorized" });

  const { type, name, description, price, stock_control_enabled, duration_minutes } = req.body;
  const id = uuidv4();

  try {
    db.prepare(`
      INSERT INTO products_services (id, organization_id, type, name, description, price, stock_control_enabled, duration_minutes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, orgId, type || 'product', name, description || '', price || 0, stock_control_enabled ? 1 : 0, duration_minutes || null);

    if (stock_control_enabled) {
      db.prepare(`
         INSERT INTO inventory_items (id, organization_id, product_service_id, quantity_available)
         VALUES (?, ?, ?, ?)
      `).run(uuidv4(), orgId, id, req.body.initial_stock || 0);
    }
    
    logAuthEvent(orgId, userId, id, 'PRODUCT_CREATED', { name, type });
    
    res.json({ success: true, id });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
