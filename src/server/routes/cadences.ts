import { Router } from "express";
import { AuthRequest } from "../middleware/auth.js";
import { CadenceService } from "../CadenceService.js";

const router = Router();

// GET /api/cadences
router.get("/", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    res.json(CadenceService.list(orgId));
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// GET /api/cadences/:id
router.get("/:id", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const c = CadenceService.get(orgId, req.params.id);
    if (!c) return res.status(404).json({ error: "Não encontrada" });
    res.json(c);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// POST /api/cadences
router.post("/", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const { name, triggerStage, steps } = req.body || {};
    const c = CadenceService.create(orgId, { name, triggerStage, steps });
    res.status(201).json(c);
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

// PUT /api/cadences/:id
router.put("/:id", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const { name, triggerStage, active, steps } = req.body || {};
    const c = CadenceService.update(orgId, req.params.id, { name, triggerStage, active, steps });
    res.json(c);
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

// DELETE /api/cadences/:id
router.delete("/:id", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    CadenceService.delete(orgId, req.params.id);
    res.json({ success: true });
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

export default router;
