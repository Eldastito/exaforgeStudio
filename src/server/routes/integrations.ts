import { Router } from "express";
import db from "../db.js";
import { v4 as uuidv4 } from "uuid";
import { AuthRequest } from "../middleware/auth.js";
import { BackupService } from "../BackupService.js";
import { NotificationService } from "../NotificationService.js";

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
