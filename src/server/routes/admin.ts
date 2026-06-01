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

// Master Admin - SaaS overview (métricas agregadas de todas as empresas)
router.get("/overview", (req: AuthRequest, res) => {
  try {
    const orgs = db.prepare(`SELECT status, billing_status FROM organization_settings WHERE deleted_at IS NULL`).all() as any[];
    const totalOrgs = orgs.length;
    const activeOrgs = orgs.filter(o => (o.status || 'active') === 'active').length;
    const blockedOrgs = orgs.filter(o => o.status === 'blocked').length;
    const pastDueOrgs = orgs.filter(o => ['past_due', 'suspended'].includes(o.billing_status)).length;

    const safeCount = (sql: string): number => {
      try { return (db.prepare(sql).get() as any)?.c || 0; } catch (e) { return 0; }
    };
    const safeSum = (sql: string): number => {
      try { return (db.prepare(sql).get() as any)?.s || 0; } catch (e) { return 0; }
    };

    res.json({
      totalOrgs,
      activeOrgs,
      blockedOrgs,
      pastDueOrgs,
      totalUsers: safeCount(`SELECT COUNT(*) as c FROM users`),
      totalContacts: safeCount(`SELECT COUNT(*) as c FROM contacts`),
      aiTotal: safeCount(`SELECT COUNT(*) as c FROM ai_interactions_log`),
      aiLast30d: safeCount(`SELECT COUNT(*) as c FROM ai_interactions_log WHERE created_at >= datetime('now','-30 days')`),
      aiLast24h: safeCount(`SELECT COUNT(*) as c FROM ai_interactions_log WHERE created_at >= datetime('now','-1 day')`),
      totalRevenue: safeSum(`SELECT COALESCE(SUM(total_amount),0) as s FROM orders WHERE status IN ('pago','em_preparo','entregue','concluido')`),
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Master Admin - List all organizations (com métricas por empresa)
router.get("/organizations", (req: AuthRequest, res) => {
  try {
    const orgs = db.prepare(`
      SELECT os.*,
        (SELECT COUNT(*) FROM users u WHERE u.organization_id = os.organization_id) AS user_count,
        (SELECT COUNT(*) FROM contacts c WHERE c.organization_id = os.organization_id) AS contact_count,
        (SELECT COUNT(*) FROM ai_interactions_log a WHERE a.organization_id = os.organization_id) AS ai_total,
        (SELECT COUNT(*) FROM ai_interactions_log a WHERE a.organization_id = os.organization_id AND a.created_at >= datetime('now','-30 days')) AS ai_30d,
        (SELECT COALESCE(SUM(o.total_amount),0) FROM orders o WHERE o.organization_id = os.organization_id AND o.status IN ('pago','em_preparo','entregue','concluido')) AS revenue,
        (SELECT MAX(m.created_at) FROM messages m WHERE m.organization_id = os.organization_id) AS last_activity
      FROM organization_settings os
      WHERE os.deleted_at IS NULL
      ORDER BY ai_30d DESC, os.created_at DESC
    `).all();
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
