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
