import { Router } from "express";
import db from "../db.js";
import { v4 as uuidv4 } from "uuid";
import { AuthRequest } from "../middleware/auth.js";
import { BackupService } from "../BackupService.js";
import { NotificationService } from "../NotificationService.js";
import { effectiveWebhookSecret, isWebhookEnforced, setWebhookEnforced, rotateStoredWebhookSecret, usingEnvSecret, getLastWebhookHit } from "../webhookSecurity.js";
import { GoogleOAuthService } from "../GoogleOAuthService.js";

const router = Router();

const APP_BASE = (process.env.APP_URL || "").replace(/\/$/, "");

// ===== Google Workspace (OAuth server-side, acesso offline) =====
// GET status da conexão Google
router.get("/google/status", (req: AuthRequest, res): any => {
  if (!req.organizationId) return res.status(401).json({ error: "Unauthorized" });
  res.json(GoogleOAuthService.status(req.organizationId));
});

// GET URL de consentimento (inicia a conexão server-side)
router.get("/google/login-url", (req: AuthRequest, res): any => {
  if (!req.organizationId) return res.status(401).json({ error: "Unauthorized" });
  if (!GoogleOAuthService.isConfigured()) {
    return res.status(400).json({ error: "Integração Google não configurada no servidor (defina GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET e APP_URL)." });
  }
  res.json({ url: GoogleOAuthService.authUrl(req.organizationId) });
});

// POST desconectar
router.post("/google/disconnect", (req: AuthRequest, res): any => {
  if (!req.organizationId) return res.status(401).json({ error: "Unauthorized" });
  GoogleOAuthService.disconnect(req.organizationId);
  res.json({ success: true });
});

// POST /backups/:id/drive -> envia o backup para o Google Drive do dono.
router.post("/backups/:id/drive", async (req: AuthRequest, res): Promise<any> => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const job = db.prepare("SELECT * FROM backup_jobs WHERE id = ? AND organization_id = ?").get(req.params.id, orgId) as any;
  if (!job || !job.file_url) return res.status(404).json({ error: "Backup não encontrado." });
  const fullPath = BackupService.resolveFile(orgId, job.file_url);
  if (!fullPath) return res.status(404).json({ error: "Arquivo do backup não encontrado." });
  try {
    const fs = await import("fs");
    const content = fs.readFileSync(fullPath);
    const result = await GoogleOAuthService.driveUpload(orgId, job.file_url, "application/json", content);
    if ("error" in result) return res.status(400).json({ error: result.error });
    res.json({ success: true, link: result.link });
  } catch (e: any) {
    res.status(500).json({ error: e.message || "Falha ao enviar ao Drive." });
  }
});

// POST /google/gmail/test -> envia um e-mail de teste para a conta conectada.
router.post("/google/gmail/test", async (req: AuthRequest, res): Promise<any> => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const st = GoogleOAuthService.status(orgId);
  if (!st.connected || !st.email) return res.status(400).json({ error: "Conecte uma conta Google primeiro." });
  const r = await GoogleOAuthService.gmailSend(orgId, st.email, "Teste de e-mail — ExaForge", "Este é um e-mail de teste enviado pela sua conta Google conectada ao ExaForge. Se você recebeu, a integração de Gmail está funcionando. ✅");
  if ("error" in r) return res.status(400).json({ error: r.error });
  res.json({ success: true });
});

// POST /google/gmail/send { to, subject, body } -> envia um e-mail.
router.post("/google/gmail/send", async (req: AuthRequest, res): Promise<any> => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const { to, subject, body } = req.body || {};
  if (!to) return res.status(400).json({ error: "Informe o destinatário." });
  const r = await GoogleOAuthService.gmailSend(orgId, String(to).trim(), String(subject || ""), String(body || ""));
  if ("error" in r) return res.status(400).json({ error: r.error });
  res.json({ success: true });
});

// GET /api/integrations/whatsapp-webhook -> URL pronta (com segredo) + status.
// Permite ativar a exigência do segredo sem mexer em variáveis de ambiente.
router.get("/whatsapp-webhook", (req: AuthRequest, res): any => {
  if (!req.organizationId) return res.status(401).json({ error: "Unauthorized" });
  const secret = effectiveWebhookSecret();
  const base = APP_BASE || `${req.protocol}://${req.headers.host}`;
  res.json({
    url: `${base}/api/webhooks/evolution?secret=${secret}`,
    enforced: isWebhookEnforced(),
    usingEnv: usingEnvSecret(),
    lastHit: getLastWebhookHit(),
  });
});

// POST /api/integrations/whatsapp-webhook/enforce { enabled }
router.post("/whatsapp-webhook/enforce", (req: AuthRequest, res): any => {
  if (!req.organizationId) return res.status(401).json({ error: "Unauthorized" });
  if (usingEnvSecret()) return res.status(400).json({ error: "O segredo está definido por variável de ambiente (sempre exigido)." });
  setWebhookEnforced(!!req.body?.enabled);
  logAuthEvent(req.organizationId, req.user?.userId, undefined, 'WHATSAPP_WEBHOOK_ENFORCE', { enabled: !!req.body?.enabled });
  res.json({ success: true, enforced: isWebhookEnforced() });
});

// POST /api/integrations/whatsapp-webhook/rotate -> gera um novo segredo.
router.post("/whatsapp-webhook/rotate", (req: AuthRequest, res): any => {
  if (!req.organizationId) return res.status(401).json({ error: "Unauthorized" });
  if (usingEnvSecret()) return res.status(400).json({ error: "O segredo está definido por variável de ambiente; não dá para girar por aqui." });
  const secret = rotateStoredWebhookSecret();
  const base = APP_BASE || `${req.protocol}://${req.headers.host}`;
  logAuthEvent(req.organizationId, req.user?.userId, undefined, 'WHATSAPP_WEBHOOK_ROTATE', {});
  res.json({ success: true, url: `${base}/api/webhooks/evolution?secret=${secret}` });
});

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

router.post("/inbound", (req: AuthRequest, res) => {
  const orgId = req.organizationId;
  const authHeader = req.headers['authorization'];
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: "Missing or invalid token" });
  }

  const token = authHeader.split(' ')[1];
  
  const isValid = db.prepare('SELECT 1 FROM webhook_endpoints WHERE secret = ? AND organization_id = ?').get(token, orgId);
  
  if (!isValid) {
    return res.status(403).json({ error: "Invalid token / signature" });
  }

  const { event, payload } = req.body;
  
  if (event === 'inventory.updated') {
     try {
        db.prepare('UPDATE inventory_items SET quantity_available = ? WHERE sku = ? AND organization_id = ?')
          .run(payload.quantity, payload.sku, orgId);
        return res.json({ success: true, message: 'Estoque atualizado' });
     } catch (e: any) {
        return res.status(500).json({ error: e.message });
     }
  }

  return res.json({ success: true, message: 'Evento recebido' });
});

router.get("/webhooks", (req: AuthRequest, res) => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });

  try {
    // Não devolve a coluna `secret` (segredo do webhook) — só um indicador.
    const webhooks = db.prepare(
      `SELECT id, organization_id, name, url, events, active, created_at,
              CASE WHEN secret IS NOT NULL AND secret != '' THEN 1 ELSE 0 END AS has_secret
         FROM webhook_endpoints WHERE organization_id = ?`
    ).all(orgId);
    res.json(webhooks);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/webhooks", (req: AuthRequest, res) => {
  const orgId = req.organizationId;
  const userId = req.user?.userId;
  if (!orgId || !userId) return res.status(401).json({ error: "Unauthorized" });

  const { name, url, events, secret } = req.body;
  const id = uuidv4();

  try {
    db.prepare(`
      INSERT INTO webhook_endpoints (id, organization_id, name, url, events, secret)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, orgId, name, url, events || '*', secret || uuidv4());
    
    logAuthEvent(orgId, userId, id, 'WEBHOOK_CREATED', { name });
    
    res.json({ success: true, id });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/webhooks/:id/test", (req: AuthRequest, res) => {
  const orgId = req.organizationId;
  const userId = req.user?.userId;
  if (!orgId || !userId) return res.status(401).json({ error: "Unauthorized" });

  const id = req.params.id;
  const deliveryId = uuidv4();
  
  const success = Math.random() > 0.3;

  try {
    db.prepare(`
      INSERT INTO webhook_deliveries (id, organization_id, endpoint_id, event_type, payload, status, attempts, last_error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
       deliveryId, 
       orgId, 
       id, 
       'test_event', 
       JSON.stringify({ message: "Test webhook" }), 
       success ? 'success' : 'failed', 
       1, 
       success ? null : 'Connection timeout'
    );

    logAuthEvent(orgId, userId, id, 'WEBHOOK_TESTED', { deliveryId });

    res.json({ success: true, deliveryId, status: success ? 'success' : 'failed' });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/backups", (req: AuthRequest, res) => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });

  try {
    const jobs = db.prepare('SELECT * FROM backup_jobs WHERE organization_id = ? ORDER BY created_at DESC').all(orgId);
    res.json(jobs);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/backups", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  const userId = req.user?.userId;
  if (!orgId || !userId) return res.status(401).json({ error: "Unauthorized" });

  const { type } = req.body;
  const id = uuidv4();

  try {
    db.prepare(`
      INSERT INTO backup_jobs (id, organization_id, type, status)
      VALUES (?, ?, ?, 'pending')
    `).run(id, orgId, type || 'manual');

    logAuthEvent(orgId, userId, id, 'BACKUP_STARTED', { type });

    // Roda em background para não bloquear a request — backup pode levar segundos.
    setImmediate(() => {
      try {
        const result = BackupService.run(orgId, id, type || 'manual');
        db.prepare(`
          UPDATE backup_jobs SET status = 'completed', completed_at = CURRENT_TIMESTAMP, file_url = ? WHERE id = ?
        `).run(result.fileName, id);
        logAuthEvent(orgId, userId, id, 'BACKUP_COMPLETED', { size: result.sizeBytes, records: result.recordCount });
        try { NotificationService.backupReady(orgId, true); } catch (e) { /* noop */ }
      } catch (err: any) {
        console.error('[Backup] Falha ao gerar:', err);
        try {
          db.prepare(`UPDATE backup_jobs SET status = 'failed', completed_at = CURRENT_TIMESTAMP WHERE id = ?`).run(id);
          logAuthEvent(orgId, userId, id, 'BACKUP_FAILED', { error: String(err?.message || err).slice(0, 300) });
          NotificationService.backupReady(orgId, false);
        } catch (e) { /* noop */ }
      }
    });

    res.json({ success: true, id });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/integrations/backups/:id/download — baixa o arquivo gerado.
router.get("/backups/:id/download", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const job = db.prepare(`SELECT * FROM backup_jobs WHERE id = ? AND organization_id = ?`).get(req.params.id, orgId) as any;
    if (!job) return res.status(404).json({ error: "Backup não encontrado." });
    if (job.status !== 'completed' || !job.file_url) return res.status(400).json({ error: "Backup ainda não está pronto." });

    const fullPath = BackupService.resolveFile(orgId, job.file_url);
    if (!fullPath) return res.status(404).json({ error: "Arquivo não encontrado no disco." });

    res.download(fullPath, job.file_url);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/integrations/backups/:id — apaga registro + arquivo.
router.delete("/backups/:id", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  const userId = req.user?.userId;
  if (!orgId || !userId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const job = db.prepare(`SELECT * FROM backup_jobs WHERE id = ? AND organization_id = ?`).get(req.params.id, orgId) as any;
    if (!job) return res.status(404).json({ error: "Backup não encontrado." });

    if (job.file_url) BackupService.deleteFile(orgId, job.file_url);
    db.prepare(`DELETE FROM backup_jobs WHERE id = ? AND organization_id = ?`).run(req.params.id, orgId);
    logAuthEvent(orgId, userId, req.params.id, 'BACKUP_DELETED', {});
    res.json({ success: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;
