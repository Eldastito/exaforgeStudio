import { Router } from "express";
import { AuthRequest } from "../middleware/auth.js";
import { MetaWebhookLogService } from "../MetaWebhookLogService.js";

const router = Router();

// Só quem administra a organização vê o console — payload de webhook pode ter
// PII do lead que mandou DM (nome, mensagem). Owner/admin apenas.
function isAdmin(req: AuthRequest): boolean {
  return req.user?.role === "owner" || req.user?.role === "admin";
}

// GET /api/meta-debug/hits — últimos hits recebidos em /api/webhooks/meta.
router.get("/hits", (req: AuthRequest, res): any => {
  if (!req.organizationId) return res.status(401).json({ error: "Unauthorized" });
  if (!isAdmin(req)) return res.status(403).json({ error: "Apenas donos/administradores enxergam o diagnóstico." });
  try {
    const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit || "50"), 10) || 50));
    res.json({ hits: MetaWebhookLogService.list(limit), summary: MetaWebhookLogService.summary() });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;
