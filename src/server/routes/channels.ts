import { Router } from "express";
import db from "../db.js";
import { v4 as uuidv4 } from "uuid";
import { AuthRequest, requireRole } from "../middleware/auth.js";
import { logAuthEvent } from "../auditLog.js";
import { ChannelProvisioningService } from "../ChannelProvisioningService.js";
import { ChannelBindingService, KNOWN_FEATURES } from "../ChannelBindingService.js";
import { ChannelBindingMigrationService } from "../ChannelBindingMigrationService.js";

const router = Router();

// F2.1a (RF-01 / CA-01) — conexão AUTENTICADA e org-scoped de WhatsApp: o
// assinante conecta/importa o número pelo ZapFlow, sem tocar no Evolution
// Manager. A org vem SEMPRE da sessão (protectedApi já roda requireAuth +
// requireOrganizationAccess); o corpo só diz o MODO e, no import, a instância.
// Segredos nunca voltam pra tela (só qr/estado/channelId). requireRole limita a
// quem gerencia canais (owner/admin).
router.post("/whatsapp/provision", requireRole("owner", "admin"), async (req: AuthRequest, res): Promise<any> => {
  const orgId = req.organizationId;
  const userId = req.user?.userId || null;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const mode = req.body?.mode === "existing" ? "existing" : "new";
  const instanceName = typeof req.body?.instanceName === "string" ? req.body.instanceName : undefined;
  try {
    const r = await ChannelProvisioningService.provision(orgId, userId, { mode, instanceName });
    if (!r.ok) {
      const status = r.code === "attributed_to_other_org" ? 409
        : r.code === "instance_not_found" ? 404
        : r.code === "evolution_failed" ? 502
        : 400;
      return res.status(status).json({ error: r.error, code: r.code, needsReset: r.needsReset || false });
    }
    return res.json({
      ok: true,
      channelId: r.channelId,
      instanceName: r.instanceName,
      qrBase64: r.qrBase64,
      state: r.state,
      imported: !!r.imported,
      alreadyExists: !!r.alreadyExists,
    });
  } catch (e: any) {
    console.error("[Channels] whatsapp/provision fatal:", e);
    return res.status(500).json({ error: e?.message || "Falha no provisionamento" });
  }
});

// Estado dos canais Evolution da org (sem segredos) — pra UI e retomada do QR.
router.get("/whatsapp/status", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  return res.json(ChannelProvisioningService.status(orgId));
});

// F2.2 — CONTROLES de usos por finalidade (channel_feature_bindings). Editam a
// MESMA fonte que o resolvedor lê. owner/admin. Segredos nunca trafegam aqui.
router.get("/bindings", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const feature = typeof req.query.feature === "string" ? req.query.feature : undefined;
  return res.json({ features: KNOWN_FEATURES, bindings: ChannelBindingService.list(orgId, feature) });
});

router.post("/bindings", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  const userId = req.user?.userId || null;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const b = req.body || {};
  const r = ChannelBindingService.upsert(orgId, userId, {
    channelId: String(b.channelId || ""),
    featureKey: String(b.featureKey || ""),
    unitId: b.unitId ?? null,
    inbound: b.inbound,
    outbound: b.outbound,
    executionMode: b.executionMode,
    priority: b.priority,
    fallbackChannelId: b.fallbackChannelId ?? null,
    ifPolicyVersion: b.ifPolicyVersion,
    origin: "manual",
  });
  if (!r.ok) {
    const status = r.code === "version_conflict" ? 409
      : (r.code === "invalid_feature" || r.code === "channel_not_in_org" || r.code === "fallback_not_in_org") ? 400
      : 500;
    return res.status(status).json({ error: r.error, code: r.code });
  }
  return res.json({ ok: true, id: r.id, policyVersion: r.policyVersion });
});

// F2.3 — migração das preferências existentes → bindings (perfil de
// compatibilidade). dryRun é o DEFAULT: para APLICAR, envie {dryRun:false}.
router.post("/bindings/migrate", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  const userId = req.user?.userId || null;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const dryRun = !(req.body?.dryRun === false || req.query?.apply === "1");
  return res.json(ChannelBindingMigrationService.migrate(orgId, userId, { dryRun }));
});

router.delete("/bindings/:id", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  const userId = req.user?.userId || null;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const r = ChannelBindingService.remove(orgId, userId, req.params.id);
  if (!r.ok) return res.status(r.code === "not_found" ? 404 : 400).json({ error: "Binding não encontrado", code: r.code });
  return res.json({ ok: true });
});

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
