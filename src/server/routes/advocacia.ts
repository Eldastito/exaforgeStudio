import { Router } from "express";
import { AuthRequest, requireRole } from "../middleware/auth.js";
import { LegalPracticeService } from "../LegalPracticeService.js";

// ADR-191 F3 — áreas do direito + advogados (composição sobre a clínica). Namespace
// próprio /api/advocacia (o /api/legal é a Consultora CDC/Trabalhista, ADR-115/178).
const router = Router();
const actor = (req: AuthRequest) => req.user?.userId || (req as any).user?.id;

// ── Áreas do direito (reuso de clinic_specialties) ──
router.get("/practice-areas", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json({ areas: LegalPracticeService.listAreas(orgId, { includeInactive: req.query.all === "1" }) });
});

router.post("/practice-areas", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const b = req.body || {};
    res.json(LegalPracticeService.createArea(orgId, { name: b.name, code: b.code, color: b.color }, actor(req)));
  } catch (e: any) { res.status(400).json({ error: e?.message || "erro" }); }
});

router.post("/practice-areas/seed-defaults", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(LegalPracticeService.seedDefaultAreas(orgId, actor(req))); }
  catch (e: any) { res.status(400).json({ error: e?.message || "erro" }); }
});

// ── Advogados (reuso de clinic_professionals; OAB em council+registration) ──
router.get("/lawyers", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json({ lawyers: LegalPracticeService.listLawyers(orgId, req.query.all === "1") });
});

router.post("/lawyers", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const b = req.body || {};
    res.json(LegalPracticeService.createLawyer(orgId, { name: b.name, oabUf: b.oabUf, oabNumber: b.oabNumber, color: b.color, userId: b.userId, areaIds: b.areaIds }, actor(req)));
  } catch (e: any) { res.status(400).json({ error: e?.message || "erro" }); }
});

router.get("/lawyers/:id/areas", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json({ areas: LegalPracticeService.areasForLawyer(orgId, req.params.id) });
});

router.put("/lawyers/:id/areas", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json({ areas: LegalPracticeService.setLawyerAreas(orgId, req.params.id, req.body?.areaIds || [], actor(req)) }); }
  catch (e: any) { res.status(400).json({ error: e?.message || "erro" }); }
});

export default router;
