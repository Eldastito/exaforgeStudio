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
    const webhooks = db.prepare('SELECT * FROM webhook_endpoints WHERE organization_id = ?').all(orgId);
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

router.post("/backups", (req: AuthRequest, res) => {
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

    setTimeout(() => {
       try {
           db.prepare(`UPDATE backup_jobs SET status = 'completed', completed_at = CURRENT_TIMESTAMP, file_url = ? WHERE id = ?`)
             .run('https://storage.googleapis.com/fake-bucket/backup-file.zip', id);
       } catch (err) {}
    }, 2000);

    res.json({ success: true, id });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
