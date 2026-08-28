/**
 * Rotas REST para o ledger de concorrentes (Closure Track B F1).
 * Toda rota herda `requireAuth` via mount em server.ts (/api/competitors).
 * `req.organizationId` obrigatório em todas.
 */
import { Router } from "express";
import { AuthRequest } from "../middleware/auth.js";
import { CompetitorIntelligenceService, CompetitorError } from "../CompetitorIntelligenceService.js";

const router = Router();

// GET /api/competitors?platform=instagram&includeInactive=1
router.get("/", (req: AuthRequest, res): any => {
  if (!req.organizationId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const includeInactive = req.query.includeInactive === "1" || req.query.includeInactive === "true";
    const platform = typeof req.query.platform === "string" ? req.query.platform : undefined;
    res.json({ competitors: CompetitorIntelligenceService.listCompetitors(req.organizationId, { includeInactive, platform }) });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "internal_error" });
  }
});

// GET /api/competitors/:id
router.get("/:id", (req: AuthRequest, res): any => {
  if (!req.organizationId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const c = CompetitorIntelligenceService.getCompetitor(req.organizationId, req.params.id);
    if (!c) return res.status(404).json({ error: "not_found" });
    res.json(c);
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "internal_error" });
  }
});

// POST /api/competitors { platform, handle, display_name?, notes?, tags? }
router.post("/", (req: AuthRequest, res): any => {
  if (!req.organizationId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const b = req.body || {};
    const created = CompetitorIntelligenceService.addCompetitor({
      orgId: req.organizationId,
      platform: String(b.platform || ""),
      handle: String(b.handle || ""),
      display_name: typeof b.display_name === "string" ? b.display_name : null,
      notes: typeof b.notes === "string" ? b.notes : null,
      tags: Array.isArray(b.tags) ? b.tags : undefined,
    });
    res.status(201).json(created);
  } catch (e: any) {
    if (e instanceof CompetitorError) {
      const s = e.code === "duplicate_competitor" ? 409 : 400;
      return res.status(s).json({ error: e.message, code: e.code });
    }
    res.status(500).json({ error: e?.message || "internal_error" });
  }
});

// PATCH /api/competitors/:id { display_name?, notes?, tags?, active? }
router.patch("/:id", (req: AuthRequest, res): any => {
  if (!req.organizationId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const b = req.body || {};
    const patch: any = {};
    if (Object.prototype.hasOwnProperty.call(b, "display_name")) patch.display_name = b.display_name;
    if (Object.prototype.hasOwnProperty.call(b, "notes")) patch.notes = b.notes;
    if (Object.prototype.hasOwnProperty.call(b, "tags")) patch.tags = b.tags;
    if (Object.prototype.hasOwnProperty.call(b, "active")) patch.active = !!b.active;

    const updated = CompetitorIntelligenceService.updateCompetitor(req.organizationId, req.params.id, patch);
    if (!updated) return res.status(404).json({ error: "not_found" });
    res.json(updated);
  } catch (e: any) {
    if (e instanceof CompetitorError) {
      return res.status(400).json({ error: e.message, code: e.code });
    }
    res.status(500).json({ error: e?.message || "internal_error" });
  }
});

// DELETE /api/competitors/:id?hard=1
// Default = soft delete (active=0). hard=1 remove definitivamente.
router.delete("/:id", (req: AuthRequest, res): any => {
  if (!req.organizationId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const hard = req.query.hard === "1" || req.query.hard === "true";
    const ok = hard
      ? CompetitorIntelligenceService.hardDelete(req.organizationId, req.params.id)
      : CompetitorIntelligenceService.deactivate(req.organizationId, req.params.id);
    if (!ok) return res.status(404).json({ error: "not_found" });
    res.json({ ok: true, mode: hard ? "hard" : "soft" });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "internal_error" });
  }
});

export default router;
