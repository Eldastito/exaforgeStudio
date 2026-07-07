import { Router } from "express";
import { requireAuth, requireVisionRole, VisionRequest } from "../auth.js";
import { listAccess, recordAccess } from "../accessLogs.js";

const router = Router();
router.use(requireAuth);

// GET /access-logs — lista auditoria de acessos (PRD §19.1). Só admin/auditor
// enxerga; um operador comum não pode consultar quem viu o quê.
router.get("/", requireVisionRole(["vision_admin", "evidence_auditor"]), (req: VisionRequest, res) => {
  const rows = listAccess(req.organizationId!, {
    cameraId: req.query.camera_id as string,
    siteId: req.query.site_id as string,
    userId: req.query.user_id as string,
    action: req.query.action as any,
    since: req.query.since as string,
    limit: req.query.limit ? Number(req.query.limit) : 100,
  });
  res.json({ logs: rows });
});

// POST /access-logs — registra manualmente (usado pelo próprio front quando
// abre live-view/playback; futuras rotas de export/snapshot chamarão o
// serviço `recordAccess` diretamente).
router.post("/", (req: VisionRequest, res) => {
  const id = recordAccess({
    organizationId: req.organizationId!,
    userId: req.userId || null,
    cameraId: req.body?.camera_id || null,
    siteId: req.body?.site_id || null,
    action: req.body?.action,
    targetRef: req.body?.target_ref || null,
    windowStart: req.body?.window_start || null,
    windowEnd: req.body?.window_end || null,
    userAgent: req.get("user-agent") || null,
    ipAddress: (req.ip || req.socket?.remoteAddress || "").toString(),
  });
  if (!id) return res.status(400).json({ error: "invalid_input" });
  res.status(201).json({ id });
});

export default router;
