import { Router } from "express";
import { AuthRequest } from "../middleware/auth.js";
import { ContinuityService, eventsEnabled } from "../ContinuityService.js";

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

export default router;
