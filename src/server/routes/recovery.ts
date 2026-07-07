import { Router } from "express";
import { AuthRequest } from "../middleware/auth.js";
import { RecoveryRadarService } from "../RecoveryRadarService.js";
import { logAuthEvent } from "../auditLog.js";

const router = Router();

// GET /api/recovery — lista + métricas
router.get("/", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const status = (req.query.status as any) || "active";
    res.json({
      events: RecoveryRadarService.list(orgId, { status }),
      metrics: RecoveryRadarService.metrics(orgId, 30),
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/recovery/:id — atualiza status (playbook_sent / resolved_positive / etc.)
router.patch("/:id", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  const userId = req.user?.userId;
  if (!orgId || !userId) return res.status(401).json({ error: "Unauthorized" });
  const status = String(req.body?.status || "");
  const validStatuses = ["playbook_sent", "resolved_positive", "resolved_neutral", "escalated_human", "dismissed"];
  if (!validStatuses.includes(status)) return res.status(400).json({ error: "status inválido" });
  try {
    const ok = RecoveryRadarService.updateStatus(orgId, req.params.id, status as any, {
      notes: req.body?.notes,
      handledBy: userId,
    });
    if (!ok) return res.status(404).json({ error: "Evento não encontrado" });
    logAuthEvent(orgId, userId, req.params.id, "RECOVERY_STATUS_CHANGED", { status });
    res.json({ success: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;
