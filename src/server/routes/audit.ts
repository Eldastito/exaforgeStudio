import { Router } from "express";
import db from "../db.js";
import { AuthRequest, requireRole } from "../middleware/auth.js";

const router = Router();

// Já protegida por requireMasterAdmin (cross-tenant, server.ts); esta camada
// extra exige também role='admin' na própria organização do master admin.
router.get("/", requireRole("admin"), (req: AuthRequest, res) => {
  try {
    // Bug corrigido: users não tem coluna "username" (só "name") — a consulta
    // original quebrava com "no such column: u.username" para qualquer master
    // admin que tentasse ver a trilha de auditoria.
    const logs = db.prepare(`
      SELECT l.*, u.name as actor_name
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
