import { Router } from "express";
import { AuthRequest, requireRole } from "../middleware/auth.js";
import { OnboardingTemplateService } from "../OnboardingTemplateService.js";
import { logAuthEvent } from "../auditLog.js";

const router = Router();

router.get("/packs", (_req, res): any => {
  try { res.json(OnboardingTemplateService.availablePacks()); }
  catch (e: any) { res.status(500).json({ error: e.message }); }
});

// Aplicar um pack semeia áreas/cadências, sobrescreve automações e indexa FAQ —
// é configuração operacional. ADR-080 (D8): restrito a gestor (owner/admin);
// antes ficava aberto a qualquer usuário autenticado.
router.post("/apply", requireRole("owner", "admin"), async (req: AuthRequest, res): Promise<any> => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const { vertical, skipFaq } = req.body || {};
    if (!vertical) return res.status(400).json({ error: "vertical é obrigatório" });
    const report = await OnboardingTemplateService.applyPack(orgId, vertical, { skipFaq: !!skipFaq });
    logAuthEvent(orgId, req.user?.userId || req.user?.id, null, "QUICKSTART_PACK_APPLIED", { vertical, skipFaq: !!skipFaq, report });
    res.json({ success: true, report });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;
