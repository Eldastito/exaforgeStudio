import { Router } from "express";
import { AuthRequest } from "../middleware/auth.js";
import { OpportunityRadarService } from "../OpportunityRadarService.js";
import { logAuthEvent } from "../auditLog.js";

const router = Router();

// GET /api/opportunities — lista oportunidades disfarçadas detectadas
router.get("/", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    res.json({
      opportunities: OpportunityRadarService.list(orgId, {
        status: (req.query.status as any) || "all",
        category: req.query.category as any,
      }),
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// POST /api/opportunities/scan — força um scan agora (best-effort)
router.post("/scan", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  const userId = req.user?.userId;
  if (!orgId || !userId) return res.status(401).json({ error: "Unauthorized" });
  if (req.user?.role !== "owner" && req.user?.role !== "admin") {
    return res.status(403).json({ error: "Apenas donos/administradores rodam o scan." });
  }
  try {
    const found = OpportunityRadarService.scan(orgId);
    logAuthEvent(orgId, userId, undefined, "OPPORTUNITY_RADAR_SCANNED", { found: found.length });
    res.json({ success: true, opportunities: found });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/opportunities/:id — atualiza status (acknowledged / in_progress / implemented / dismissed)
router.patch("/:id", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  const userId = req.user?.userId;
  if (!orgId || !userId) return res.status(401).json({ error: "Unauthorized" });
  const status = String(req.body?.status || "");
  if (!["acknowledged", "in_progress", "implemented", "dismissed", "new"].includes(status)) {
    return res.status(400).json({ error: "status inválido" });
  }
  try {
    const ok = OpportunityRadarService.updateStatus(orgId, req.params.id, status as any, userId);
    if (!ok) return res.status(404).json({ error: "Oportunidade não encontrada" });
    logAuthEvent(orgId, userId, req.params.id, "OPPORTUNITY_STATUS_CHANGED", { status });
    res.json({ success: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;
