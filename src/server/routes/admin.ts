import { Router } from "express";
import db from "../db.js";
import { v4 as uuidv4 } from "uuid";
import { SecurityAuditService } from "../SecurityAuditService.js";
import { AuthRequest } from "../middleware/auth.js";
import { MessageProviderService } from "../MessageProviderService.js";
import { PlanService } from "../PlanService.js";

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
      // Custo de IA (R$) — consumo de tokens das empresas.
      aiCost30d: safeSum(`SELECT COALESCE(SUM(cost_brl),0) as s FROM ai_usage_log WHERE created_at >= datetime('now','-30 days')`),
      aiCostTotal: safeSum(`SELECT COALESCE(SUM(cost_brl),0) as s FROM ai_usage_log`),
      aiTokens30d: safeCount(`SELECT COALESCE(SUM(total_tokens),0) as c FROM ai_usage_log WHERE created_at >= datetime('now','-30 days')`),
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
        (SELECT COALESCE(SUM(u.cost_brl),0) FROM ai_usage_log u WHERE u.organization_id = os.organization_id AND u.created_at >= datetime('now','-30 days')) AS ai_cost_30d,
        (SELECT COALESCE(SUM(u.total_tokens),0) FROM ai_usage_log u WHERE u.organization_id = os.organization_id AND u.created_at >= datetime('now','-30 days')) AS ai_tokens_30d,
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

// ============================================================================
// Convites de NOVA EMPRESA (Cortesia) — o super admin cria uma conta gratuita
// com plano + módulos definidos e envia o link de ativação pelo WhatsApp.
// ============================================================================

// POST /api/admin/org-invites — gera o convite e (opcional) envia pelo WhatsApp.
router.post("/org-invites", async (req: AuthRequest, res): Promise<any> => {
  const adminId = req.user?.userId;
  try {
    const { businessName, recipientName, recipientPhone, planId, modules, vertical, billingStatus, sendWhatsapp } = req.body || {};
    const phone = String(recipientPhone || "").replace(/\D/g, "");
    const token = uuidv4() + uuidv4();
    const id = uuidv4();
    const modulesJson = Array.isArray(modules) ? JSON.stringify(modules) : null;

    db.prepare(`
      INSERT INTO org_invitations (id, token, business_name, recipient_name, recipient_phone, plan_id, enabled_modules, vertical, billing_status, status, created_by, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, datetime('now', '+30 days'))
    `).run(id, token, businessName || null, recipientName || null, phone || null,
           planId || 'cortesia', modulesJson, vertical || null, billingStatus || 'active', adminId || null);

    const base = (process.env.APP_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, "");
    const link = `${base}/?orgInvite=${token}`;

    // Entrega pelo WhatsApp usando um canal conectado da org do super admin.
    let whatsappSent = false;
    let whatsappError: string | null = null;
    if (sendWhatsapp && phone) {
      try {
        const ch = db.prepare(
          `SELECT id FROM channels WHERE organization_id = ? AND status != 'disabled' ORDER BY (provider LIKE 'evolution%') DESC, created_at ASC LIMIT 1`
        ).get(req.organizationId) as any;
        if (!ch) { whatsappError = "Nenhum canal conectado para enviar."; }
        else {
          const nome = (recipientName || "").trim().split(/\s+/)[0] || "";
          const msg = `Olá ${nome}! 🎉 Sua conta no ZapFlow.ai (${businessName || 'sua empresa'}) está liberada.\n\n` +
            `Crie seu acesso por aqui (válido por 30 dias):\n${link}\n\n` +
            `Qualquer dúvida, é só chamar. 🚀`;
          await MessageProviderService.sendMessage(ch.id, phone, msg);
          whatsappSent = true;
        }
      } catch (e: any) { whatsappError = e?.message || "Falha ao enviar pelo WhatsApp."; }
    }

    logAuthEvent(req.organizationId, adminId, id, 'ADMIN_ORG_INVITE_CREATED', { businessName, planId: planId || 'cortesia', whatsappSent });
    res.json({ success: true, id, token, link, whatsappSent, whatsappError });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/admin/org-invites — lista os convites de nova empresa.
router.get("/org-invites", (req: AuthRequest, res) => {
  try {
    const invites = db.prepare(`
      SELECT oi.id, oi.business_name, oi.recipient_name, oi.recipient_phone, oi.plan_id, oi.enabled_modules,
             oi.status, oi.created_org_id, oi.accepted_at, oi.expires_at, oi.created_at,
             (SELECT business_name FROM organization_settings os WHERE os.organization_id = oi.created_org_id) AS created_org_name
      FROM org_invitations oi
      ORDER BY oi.created_at DESC LIMIT 50
    `).all();
    res.json(invites);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/admin/org-invites/:id — revoga um convite pendente.
router.delete("/org-invites/:id", (req: AuthRequest, res) => {
  try {
    db.prepare(`UPDATE org_invitations SET status = 'revoked' WHERE id = ? AND status = 'pending'`).run(req.params.id);
    logAuthEvent(req.organizationId, req.user?.userId, req.params.id, 'ADMIN_ORG_INVITE_REVOKED', {});
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================================
// Planos & Limites — o super admin edita preço e limites de cada plano
// (respostas de IA, contatos, canais, usuários, trial e limites do Estúdio).
// ============================================================================

// GET /api/admin/plans — lista os planos com features (limites) já parseadas.
router.get("/plans", (req: AuthRequest, res) => {
  try {
    res.json(PlanService.listPlans());
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/admin/plans/:id — atualiza nome/preço/limites de um plano.
router.put("/plans/:id", (req: AuthRequest, res): any => {
  try {
    const plan = db.prepare("SELECT features FROM plans WHERE id = ?").get(req.params.id) as any;
    if (!plan) return res.status(404).json({ error: "Plano não encontrado." });
    let cur: any = {};
    try { cur = plan.features ? JSON.parse(plan.features) : {}; } catch { cur = {}; }

    const { name, price, features } = req.body || {};
    const NUM_KEYS = ["ai_monthly_limit", "contacts_limit", "channels_limit", "users_limit", "trial_days", "studio_images_monthly", "studio_videos_monthly"];
    const next = { ...cur };
    if (features && typeof features === "object") {
      for (const k of NUM_KEYS) {
        if (features[k] !== undefined && features[k] !== null && features[k] !== "") {
          const n = parseInt(String(features[k]), 10);
          if (!isNaN(n)) next[k] = Math.max(0, n);
        }
      }
    }
    db.prepare("UPDATE plans SET name = COALESCE(?, name), price = COALESCE(?, price), features = ? WHERE id = ?")
      .run(name != null && String(name).trim() ? String(name).trim() : null,
           price != null && price !== "" && !isNaN(Number(price)) ? Number(price) : null,
           JSON.stringify(next), req.params.id);
    logAuthEvent(req.organizationId, req.user?.userId, req.params.id, 'ADMIN_PLAN_UPDATED', { name, price });
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
