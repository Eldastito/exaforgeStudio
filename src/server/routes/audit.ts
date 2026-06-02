import { Router } from "express";
import db from "../db.js";
import { AuthRequest } from "../middleware/auth.js";

const router = Router();

// Only master admins or authorized roles can access this
router.get("/", (req: AuthRequest, res) => {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: "Forbidden" });
  }

  try {
    const logs = db.prepare(`
      SELECT l.*, u.username as actor_name 
      FROM auth_audit_logs l 
      LEFT JOIN users u ON l.actor_user_id = u.id 
      ORDER BY l.created_at DESC LIMIT 100
    `).all();
    res.json(logs);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
