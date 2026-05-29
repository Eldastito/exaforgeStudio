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
  const userId = req.user?.userId;
  if (!orgId || !userId) return res.status(401).json({ error: "Unauthorized" });

  try {
    const appointments = db.prepare('SELECT * FROM appointments WHERE organization_id = ?').all(orgId);
    res.json(appointments);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/", (req: AuthRequest, res) => {
  const orgId = req.organizationId;
  const userId = req.user?.userId;
  if (!orgId || !userId) return res.status(401).json({ error: "Unauthorized" });

  const { ticket_id, contact_id, product_service_id, title, description, scheduled_start, scheduled_end } = req.body;
  const id = uuidv4();

  try {
    db.prepare(`
      INSERT INTO appointments (id, organization_id, ticket_id, contact_id, product_service_id, title, description, scheduled_start, scheduled_end)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, orgId, ticket_id, contact_id, product_service_id, title, description || '', scheduled_start, scheduled_end);
    
    logAuthEvent(orgId, userId, id, 'APPOINTMENT_CREATED', { ticket_id });

    res.json({ success: true, id });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
