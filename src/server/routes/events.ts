import { Router } from "express";
import { AuthRequest } from "../middleware/auth.js";
import { EventInquiryService } from "../EventInquiryService.js";

const router = Router();

router.get("/", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(EventInquiryService.list(orgId)); }
  catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const id = EventInquiryService.create(orgId, req.body || {});
    res.json({ id, success: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.patch("/:id", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json({ success: EventInquiryService.update(orgId, req.params.id, req.body || {}) }); }
  catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;
