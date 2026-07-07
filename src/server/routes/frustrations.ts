import { Router } from "express";
import { AuthRequest } from "../middleware/auth.js";
import { FrustrationJournalService } from "../FrustrationJournalService.js";

const router = Router();

// GET /api/frustrations — lista + digest
router.get("/", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const list = FrustrationJournalService.list(orgId, {
      sinceDays: req.query.sinceDays ? Number(req.query.sinceDays) : 60,
      limit: req.query.limit ? Number(req.query.limit) : 200,
    });
    const digest = FrustrationJournalService.digest(orgId, 30);
    res.json({ frustrations: list, digest });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// POST /api/frustrations { text, source? }
router.post("/", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  const userId = req.user?.userId;
  if (!orgId || !userId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const row = FrustrationJournalService.record(
      orgId, userId,
      String(req.body?.text || ""),
      req.body?.source === "voice_transcribed" ? "voice_transcribed" : "text",
    );
    res.status(201).json(row);
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

// DELETE /api/frustrations/:id
router.delete("/:id", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const ok = FrustrationJournalService.delete(orgId, req.params.id);
    if (!ok) return res.status(404).json({ error: "Não encontrado" });
    res.json({ success: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;
