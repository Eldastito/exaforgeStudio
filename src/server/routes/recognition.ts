import { Router } from "express";
import { AuthRequest } from "../middleware/auth.js";
import { RecognitionNotesService } from "../RecognitionNotesService.js";
import { logAuthEvent } from "../auditLog.js";

const router = Router();

// GET /api/recognition — lista + métricas.
router.get("/", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const status = (req.query.status as any) || "all";
    res.json({
      notes: RecognitionNotesService.list(orgId, { status }),
      metrics: RecognitionNotesService.metrics(orgId, 30),
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/recognition/:id — dono marca a nota como enviada ou dismisses.
// body: { action: 'sent' | 'dismissed' }
router.patch("/:id", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  const userId = req.user?.userId;
  if (!orgId || !userId) return res.status(401).json({ error: "Unauthorized" });
  const action = String(req.body?.action || "").toLowerCase();
  if (!["sent", "dismissed"].includes(action)) return res.status(400).json({ error: "action deve ser 'sent' ou 'dismissed'" });
  try {
    const ok = action === "sent"
      ? RecognitionNotesService.markSent(orgId, req.params.id, { handledBy: userId })
      : RecognitionNotesService.dismiss(orgId, req.params.id, { handledBy: userId });
    if (!ok) return res.status(404).json({ error: "Nota não encontrada" });
    logAuthEvent(orgId, userId, req.params.id, "RECOGNITION_" + action.toUpperCase(), {});
    res.json({ success: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;
