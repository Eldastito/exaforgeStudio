import { Router } from "express";
import { AuthRequest } from "../middleware/auth.js";
import { OnboardingTemplateService } from "../OnboardingTemplateService.js";

const router = Router();

router.get("/packs", (_req, res): any => {
  try { res.json(OnboardingTemplateService.availablePacks()); }
  catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/apply", async (req: AuthRequest, res): Promise<any> => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const { vertical, skipFaq } = req.body || {};
    if (!vertical) return res.status(400).json({ error: "vertical é obrigatório" });
    const report = await OnboardingTemplateService.applyPack(orgId, vertical, { skipFaq: !!skipFaq });
    res.json({ success: true, report });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;
