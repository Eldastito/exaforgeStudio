import { Router } from "express";
import db from "../db.js";
import { AuthRequest } from "../middleware/auth.js";
import { ContinuityService, eventsEnabled } from "../ContinuityService.js";
import { MessageDeliveryService } from "../MessageDeliveryService.js";
import { EdgeSyncService } from "../EdgeSyncService.js";

/**
 * Continuity Layer — API de sincronização (ADR-082, Fase 1). Montada em
 * /api/continuity. O cliente, ao (re)conectar, chama /cursor uma vez e depois
 * /events?after=<seq> para reconciliar o que perdeu durante a queda.
 */
const router = Router();

// Cursor atual da organização (maior seq conhecido).
router.get("/cursor", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json({ cursor: ContinuityService.cursor(orgId), enabled: eventsEnabled() });
});

// Delta sync: eventos após `after` (ordenados por seq), paginado.
router.get("/events", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const after = parseInt(String(req.query.after ?? "0"), 10) || 0;
  const limit = parseInt(String(req.query.limit ?? "200"), 10) || 200;
  res.json(ContinuityService.since(orgId, after, limit));
});

// Status/health da Continuity Layer para a organização — para rollout
// observável (quais flags estão ligadas, saúde da fila de entrega, cursor de
// eventos, nós Edge). Escopado por org (a fila e os nós são contados só da org).
router.get("/status", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const rows = db.prepare(
      `SELECT status, COUNT(*) AS c FROM message_deliveries WHERE organization_id = ? GROUP BY status`
    ).all(orgId) as any[];
    const byStatus: Record<string, number> = { queued: 0, sent: 0, delivered: 0, failed: 0 };
    for (const r of rows) byStatus[r.status] = r.c;
    const oldest = db.prepare(
      `SELECT MIN(next_attempt_at) AS t FROM message_deliveries WHERE organization_id = ? AND status = 'queued'`
    ).get(orgId) as any;
    const edge = db.prepare(
      `SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active FROM edge_devices WHERE organization_id = ?`
    ).get(orgId) as any;

    res.json({
      flags: {
        events: eventsEnabled(),
        deliveryQueue: MessageDeliveryService.enabled(),
        edgeSync: EdgeSyncService.enabled(),
      },
      delivery: {
        queued: byStatus.queued, sent: byStatus.sent, delivered: byStatus.delivered, failed: byStatus.failed,
        oldestQueuedAt: oldest?.t || null,
      },
      degradedChannels: MessageDeliveryService.degradedChannels(orgId).map((c) => {
        const ch = db.prepare(`SELECT name, provider FROM channels WHERE id = ?`).get(c.channelId) as any;
        return { ...c, channelName: ch?.name || null, provider: ch?.provider || null };
      }),
      events: { cursor: ContinuityService.cursor(orgId) },
      edge: { devices: Number(edge?.total || 0), active: Number(edge?.active || 0) },
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
