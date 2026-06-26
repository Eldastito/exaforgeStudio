import { Router } from "express";
import db from "../db.js";
import { AuthRequest } from "../middleware/auth.js";
import { QuoteService } from "../QuoteService.js";

const router = Router();

router.get("/", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const status = (req.query as any).status;
    res.json(QuoteService.list(orgId, { status }));
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.get("/settings", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const o = db.prepare(`SELECT COALESCE(quote_validity_hours,72) AS validity, COALESCE(quote_followup_hours,24) AS followup, COALESCE(quote_followup_max,2) AS max FROM organization_settings WHERE organization_id = ?`).get(orgId) as any || {};
    res.json({ validityHours: o.validity, followupHours: o.followup, followupMax: o.max });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.put("/settings", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const { validityHours, followupHours, followupMax } = req.body || {};
    const clamp = (v: any, def: number, min: number, max: number) => Math.min(max, Math.max(min, parseInt(String(v), 10) || def));
    db.prepare(`UPDATE organization_settings SET quote_validity_hours = ?, quote_followup_hours = ?, quote_followup_max = ? WHERE organization_id = ?`)
      .run(clamp(validityHours, 72, 1, 720), clamp(followupHours, 24, 1, 720), clamp(followupMax, 2, 0, 5), orgId);
    res.json({ success: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/:id/accept", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json({ success: QuoteService.markAccepted(orgId, req.params.id) }); }
  catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/:id/decline", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json({ success: QuoteService.markDeclined(orgId, req.params.id, req.body?.reason) }); }
  catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;
