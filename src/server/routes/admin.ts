import { Router } from "express";
import db from "../db.js";
import { v4 as uuidv4 } from "uuid";
import { SecurityAuditService } from "../SecurityAuditService.js";
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

// Master Admin - List all organizations
router.get("/organizations", (req: AuthRequest, res) => {
  try {
    const orgs = db.prepare(`SELECT * FROM organization_settings WHERE deleted_at IS NULL`).all();
    res.json(orgs);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Master Admin - Update organization status (block, unblock, etc)
router.post("/organizations/:id/status", (req: AuthRequest, res) => {
  const adminId = req.user?.userId;
  const { status } = req.body;
  const orgId = req.params.id;
  
  try {
    db.prepare('UPDATE organization_settings SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE organization_id = ?').run(status, orgId);
    
    logAuthEvent(req.organizationId, adminId, orgId, 'ADMIN_CHANGE_STATUS', { status });
      
    res.json({ success: true, status });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Master Admin - Update organization billing status
router.post("/organizations/:id/billing-status", (req: AuthRequest, res) => {
  const adminId = req.user?.userId;
  const { billing_status } = req.body;
  const orgId = req.params.id;
  
  try {
    db.prepare('UPDATE organization_settings SET billing_status = ?, updated_at = CURRENT_TIMESTAMP WHERE organization_id = ?').run(billing_status, orgId);
    
    logAuthEvent(req.organizationId, adminId, orgId, 'ADMIN_CHANGE_BILLING_STATUS', { billing_status });
      
    res.json({ success: true, billing_status });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Master Admin - Soft delete organization
router.delete("/organizations/:id", (req: AuthRequest, res) => {
  const adminId = req.user?.userId;
  const orgId = req.params.id;
  
  try {
    db.prepare('UPDATE organization_settings SET deleted_at = CURRENT_TIMESTAMP, status = ? WHERE organization_id = ?').run('cancelled', orgId);
    
    logAuthEvent(req.organizationId, adminId, orgId, 'ADMIN_SOFT_DELETE', {});
      
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Admin - Audit Logs
router.get("/audit-logs", (req: AuthRequest, res) => {
  try {
    const logs = db.prepare('SELECT * FROM auth_audit_logs ORDER BY created_at DESC LIMIT 50').all();
    res.json(logs);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Create global notification
router.post("/notifications/global", (req: AuthRequest, res) => {
  const { title, message, type } = req.body;
  const adminId = req.user?.userId;
  try {
    db.prepare('INSERT INTO notifications (id, organization_id, title, message, type) VALUES (?, ?, ?, ?, ?)')
      .run(uuidv4(), 'global', title, message, type || 'info');
      
    logAuthEvent(req.organizationId, adminId, 'global', 'CREATE_GLOBAL_NOTIFICATION', { title });
      
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Master Admin - Security Check
router.get("/security-check", async (req: AuthRequest, res) => {
  try {
    const issues = await SecurityAuditService.runSecurityCheck();
    res.json(issues);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
