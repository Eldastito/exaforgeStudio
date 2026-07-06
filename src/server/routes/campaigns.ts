import { Router } from "express";
import db from "../db.js";
import { v4 as uuidv4 } from "uuid";
import { AuthRequest } from "../middleware/auth.js";
import { CampaignService } from "../CampaignService.js";

const router = Router();

const logEvent = (orgId?: string, actorId?: string, targetId?: string, eventType = '', meta: any = {}) => {
  try {
    db.prepare(`INSERT INTO auth_audit_logs (id, organization_id, actor_user_id, target_user_id, event_type, metadata_json) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(uuidv4(), orgId || null, actorId || null, targetId || null, eventType, JSON.stringify(meta));
  } catch (e) { /* noop */ }
};

// GET /api/campaigns/settings — config da reativação automática (sequência progressiva)
router.get("/settings", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const o = db.prepare(`SELECT auto_reactivation_enabled, auto_reactivation_days, auto_reactivation_message, auto_reactivation_message_2, auto_reactivation_message_3, auto_reactivation_last_run FROM organization_settings WHERE organization_id = ?`).get(orgId) as any;
    res.json({
      enabled: !!(o && o.auto_reactivation_enabled),
      days: o?.auto_reactivation_days || 60,
      message: o?.auto_reactivation_message || "",
      message2: o?.auto_reactivation_message_2 || "",
      message3: o?.auto_reactivation_message_3 || "",
      lastRun: o?.auto_reactivation_last_run || null,
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// PUT /api/campaigns/settings — liga/desliga a reativação automática
router.put("/settings", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  const userId = req.user?.userId;
  if (!orgId || !userId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const { enabled, days, message, message2, message3 } = req.body || {};
    db.prepare(`UPDATE organization_settings SET auto_reactivation_enabled = ?, auto_reactivation_days = ?, auto_reactivation_message = ?, auto_reactivation_message_2 = ?, auto_reactivation_message_3 = ? WHERE organization_id = ?`)
      .run(enabled ? 1 : 0, parseInt(String(days), 10) || 60, message || null, message2 || null, message3 || null, orgId);
    logEvent(orgId, userId, undefined, 'AUTO_REACTIVATION_CHANGED', { enabled, days });
    res.json({ success: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// GET /api/campaigns/recovery — automações de RECUPERAÇÃO de vendas (funil).
router.get("/recovery", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const o = db.prepare(`
      SELECT order_expiry_enabled, order_expiry_hours,
             pix_reminder_enabled, pix_reminder_minutes, pix_reminder_max,
             abandoned_cart_enabled, abandoned_cart_hours, abandoned_cart_message,
             abandoned_cart_intent_enabled, abandoned_cart_intent_threshold,
             nps_enabled, nps_delay_hours, nps_message,
             referral_enabled, referral_reward_percent, referral_welcome_percent,
             repurchase_reminder_enabled, repurchase_reminder_days, repurchase_reminder_message
      FROM organization_settings WHERE organization_id = ?
    `).get(orgId) as any || {};
    res.json({
      orderExpiry: { enabled: !!o.order_expiry_enabled, hours: o.order_expiry_hours || 48 },
      pixReminder: { enabled: !!o.pix_reminder_enabled, minutes: o.pix_reminder_minutes || 30, max: o.pix_reminder_max || 3 },
      abandonedCart: { enabled: !!o.abandoned_cart_enabled, hours: o.abandoned_cart_hours || 4, message: o.abandoned_cart_message || "", intentEnabled: !!o.abandoned_cart_intent_enabled, intentThreshold: o.abandoned_cart_intent_threshold || 60 },
      nps: { enabled: !!o.nps_enabled, delayHours: o.nps_delay_hours || 24, message: o.nps_message || "" },
      referral: { enabled: !!o.referral_enabled, rewardPercent: o.referral_reward_percent || 10, welcomePercent: o.referral_welcome_percent || 10 },
      repurchaseReminder: { enabled: !!o.repurchase_reminder_enabled, days: o.repurchase_reminder_days || 30, message: o.repurchase_reminder_message || "" },
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// PUT /api/campaigns/recovery — atualiza as automações de recuperação.
router.put("/recovery", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  const userId = req.user?.userId;
  if (!orgId || !userId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const { orderExpiry, pixReminder, abandonedCart, nps, referral, repurchaseReminder } = req.body || {};
    const clampInt = (v: any, def: number, min: number, max: number) => Math.min(max, Math.max(min, parseInt(String(v), 10) || def));
    db.prepare(`
      UPDATE organization_settings SET
        order_expiry_enabled = ?, order_expiry_hours = ?,
        pix_reminder_enabled = ?, pix_reminder_minutes = ?, pix_reminder_max = ?,
        abandoned_cart_enabled = ?, abandoned_cart_hours = ?, abandoned_cart_message = ?,
        abandoned_cart_intent_enabled = ?, abandoned_cart_intent_threshold = ?,
        nps_enabled = ?, nps_delay_hours = ?, nps_message = ?,
        referral_enabled = ?, referral_reward_percent = ?, referral_welcome_percent = ?,
        repurchase_reminder_enabled = ?, repurchase_reminder_days = ?, repurchase_reminder_message = ?
      WHERE organization_id = ?
    `).run(
      orderExpiry?.enabled ? 1 : 0, clampInt(orderExpiry?.hours, 48, 1, 720),
      pixReminder?.enabled ? 1 : 0, clampInt(pixReminder?.minutes, 30, 5, 1440), clampInt(pixReminder?.max, 3, 1, 5),
      abandonedCart?.enabled ? 1 : 0, clampInt(abandonedCart?.hours, 4, 1, 168), abandonedCart?.message || null,
      abandonedCart?.intentEnabled ? 1 : 0, clampInt(abandonedCart?.intentThreshold, 60, 20, 100),
      nps?.enabled ? 1 : 0, clampInt(nps?.delayHours, 24, 0, 720), nps?.message || null,
      referral?.enabled ? 1 : 0, clampInt(referral?.rewardPercent, 10, 1, 90), clampInt(referral?.welcomePercent, 10, 1, 90),
      repurchaseReminder?.enabled ? 1 : 0, clampInt(repurchaseReminder?.days, 30, 7, 365), repurchaseReminder?.message || null,
      orgId,
    );
    logEvent(orgId, userId, undefined, 'RECOVERY_AUTOMATIONS_CHANGED', { orderExpiry: !!orderExpiry?.enabled, pixReminder: !!pixReminder?.enabled, abandonedCart: !!abandonedCart?.enabled, nps: !!nps?.enabled, referral: !!referral?.enabled, repurchaseReminder: !!repurchaseReminder?.enabled });
    res.json({ success: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// GET /api/campaigns — lista campanhas
router.get("/", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(CampaignService.listCampaigns(orgId)); }
  catch (e: any) { res.status(500).json({ error: e.message }); }
});

// POST /api/campaigns/preview — quantos contatos um segmento atinge (sem criar)
router.post("/preview", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const recipients = CampaignService.resolveSegment(orgId, req.body?.segment || {});
    res.json({ total: recipients.length, sample: recipients.slice(0, 5).map(r => r.name || r.identifier) });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// GET /api/campaigns/:id — detalhe + progresso
router.get("/:id", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const c = CampaignService.getCampaign(orgId, req.params.id);
    if (!c) return res.status(404).json({ error: "Campanha não encontrada" });
    res.json(c);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// POST /api/campaigns — cria campanha (draft) com destinatários materializados
router.post("/", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  const userId = req.user?.userId;
  if (!orgId || !userId) return res.status(401).json({ error: "Unauthorized" });
  const { name, message, segment, channelId } = req.body || {};
  if (!name || !message) return res.status(400).json({ error: "Informe nome e mensagem." });
  try {
    const out = CampaignService.createCampaign(orgId, { name, message, segment, channelId, createdBy: userId });
    logEvent(orgId, userId, out.id, 'CAMPAIGN_CREATED', { total: out.total });
    res.json({ success: true, ...out });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// POST /api/campaigns/:id/start — inicia o envio (background, com throttle)
router.post("/:id/start", async (req: AuthRequest, res): Promise<any> => {
  const orgId = req.organizationId;
  const userId = req.user?.userId;
  if (!orgId || !userId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const out = await CampaignService.startCampaign(orgId, req.params.id, (global as any).io);
    if (!out.started) return res.status(400).json({ error: out.reason });
    logEvent(orgId, userId, req.params.id, 'CAMPAIGN_STARTED', {});
    res.json({ success: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// POST /api/campaigns/:id/pause — pausa o envio
router.post("/:id/pause", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    CampaignService.pauseCampaign(orgId, req.params.id);
    res.json({ success: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;
