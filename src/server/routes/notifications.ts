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
    const notifications = db.prepare(`
      SELECT * FROM notifications 
      WHERE organization_id = ? OR organization_id IS NULL OR organization_id = 'global'
      ORDER BY created_at DESC 
      LIMIT 20
    `).all(orgId);
    res.json(notifications);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post("/:id/read", (req: AuthRequest, res) => {
  const id = req.params.id;
  const orgId = req.organizationId;
  const userId = req.user?.userId;
  
  if (!orgId || !userId) return res.status(401).json({ error: "Unauthorized" });

  try {
    const result = db.prepare('UPDATE notifications SET is_read = 1 WHERE id = ? AND (organization_id = ? OR organization_id IS NULL OR organization_id = "global")').run(id, orgId);
    
    if (result.changes > 0) {
      logAuthEvent(orgId, userId, id, 'NOTIFICATION_READ', {});
    }

    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
