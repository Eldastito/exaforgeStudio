import { Router } from "express";
import { AuthRequest, requireRole } from "../middleware/auth.js";
import { OnboardingTemplateService } from "../OnboardingTemplateService.js";
import { logAuthEvent } from "../auditLog.js";
import db from "../db.js";

const router = Router();

router.get("/packs", (_req, res): any => {
  try { res.json(OnboardingTemplateService.availablePacks()); }
  catch (e: any) { res.status(500).json({ error: e.message }); }
});

// GET /api/quickstart/status — o Dashboard usa pra decidir se mostra o card de
// onboarding (ADR-093 §1: some depois de aplicado). Devolve o pack da vertical
// da org (o "empurrão" de 1 clique).
router.get("/status", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const o = db.prepare(`SELECT quickstart_applied, vertical FROM organization_settings WHERE organization_id = ?`).get(orgId) as any || {};
    const pack = OnboardingTemplateService.availablePacks().find(p => p.vertical === (o.vertical || "outro"))
      || OnboardingTemplateService.availablePacks().find(p => p.vertical === "outro") || null;
    res.json({ applied: !!o.quickstart_applied, vertical: o.vertical || null, pack });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
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
