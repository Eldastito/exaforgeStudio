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

// List channels
router.get("/", (req: AuthRequest, res) => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });

  const channels = db.prepare("SELECT id, organization_id, provider, name, identifier, status, ai_enabled, human_handoff_enabled, COALESCE(kind,'client') AS kind, created_at, updated_at FROM channels WHERE organization_id = ?").all(orgId);
  res.json(channels);
});

// GET número de encaminhamento para WhatsApp (usado pela IA no Instagram)
router.get("/forward-whatsapp", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const o = db.prepare('SELECT forward_whatsapp FROM organization_settings WHERE organization_id = ?').get(orgId) as any;
  res.json({ forward_whatsapp: o?.forward_whatsapp || '' });
});

// PUT número de encaminhamento para WhatsApp
router.put("/forward-whatsapp", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const num = String(req.body?.forward_whatsapp || '').replace(/\D/g, '') || null;
    db.prepare('UPDATE organization_settings SET forward_whatsapp = ? WHERE organization_id = ?').run(num, orgId);
    res.json({ success: true, forward_whatsapp: num || '' });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// Create channel
router.post("/", (req: AuthRequest, res) => {
  const orgId = req.organizationId;
  const userId = req.user?.userId;
  if (!orgId || !userId) return res.status(401).json({ error: "Unauthorized" });
  
  const { provider, name, identifier, webhook_secret, token_encrypted, metadata_json } = req.body;
  
  if (!provider || !name) return res.status(400).json({ error: "Missing required fields" });

  const id = uuidv4();
  try {
    db.prepare(`
      INSERT INTO channels (id, organization_id, provider, name, identifier, webhook_secret, token_encrypted, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, orgId, provider, name, identifier || null, webhook_secret || null, token_encrypted || null, JSON.stringify(metadata_json || {}));
    
    logAuthEvent(orgId, userId, id, 'CHANNEL_CREATED', { name, provider });
    
    res.json({ id, message: "Channel created" });
  } catch(e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Update channel
router.put("/:id", (req: AuthRequest, res) => {
  const orgId = req.organizationId;
  const userId = req.user?.userId;
  if (!orgId || !userId) return res.status(401).json({ error: "Unauthorized" });

  const { name, identifier, status, ai_enabled, kind, webhook_secret, token_encrypted, metadata_json } = req.body;

  const updates = [];
  const params: any[] = [];

  if (name !== undefined) { updates.push("name = ?"); params.push(name); }
  if (identifier !== undefined) { updates.push("identifier = ?"); params.push(identifier); }
  if (status !== undefined) { updates.push("status = ?"); params.push(status); }
  if (ai_enabled !== undefined) { updates.push("ai_enabled = ?"); params.push(ai_enabled ? 1 : 0); }
  // Marca o canal como interno (Coordenador IA) ou de cliente.
  if (kind !== undefined) { updates.push("kind = ?"); params.push(kind === 'internal' ? 'internal' : 'client'); }
  if (webhook_secret !== undefined) { updates.push("webhook_secret = ?"); params.push(webhook_secret); }
  if (token_encrypted !== undefined) { updates.push("token_encrypted = ?"); params.push(token_encrypted); }
  if (metadata_json !== undefined) { updates.push("metadata_json = ?"); params.push(JSON.stringify(metadata_json)); }
  
  if (updates.length === 0) return res.json({ message: "No updates" });
  
  updates.push("updated_at = CURRENT_TIMESTAMP");
  params.push(req.params.id, orgId);

  try {
    const result = db.prepare(`UPDATE channels SET ${updates.join(', ')} WHERE id = ? AND organization_id = ?`).run(...params);
    if (result.changes === 0) return res.status(404).json({ error: "Channel not found" });
    
    logAuthEvent(orgId, userId, req.params.id, 'CHANNEL_UPDATED', { updates: Object.keys(req.body) });
    
    res.json({ message: "Channel updated" });
  } catch(e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Delete channel
router.delete("/:id", (req: AuthRequest, res) => {
  const orgId = req.organizationId;
  const userId = req.user?.userId;
  if (!orgId || !userId) return res.status(401).json({ error: "Unauthorized" });

  try {
    const result = db.prepare('DELETE FROM channels WHERE id = ? AND organization_id = ?').run(req.params.id, orgId);
    if (result.changes === 0) return res.status(404).json({ error: "Channel not found" });
    
    logAuthEvent(orgId, userId, req.params.id, 'CHANNEL_DELETED', {});
    
    res.json({ message: "Channel deleted" });
  } catch(e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
