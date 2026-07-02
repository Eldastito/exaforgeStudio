import { Router } from "express";
import db from "../db.js";
import { AuthRequest } from "../middleware/auth.js";
import { logAuthEvent } from "../auditLog.js";

const router = Router();

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
