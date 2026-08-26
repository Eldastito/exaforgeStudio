import { Router } from "express";
import { AuthRequest, requireRole } from "../middleware/auth.js";
import { LegalPracticeService } from "../LegalPracticeService.js";
import { LegalCaseService } from "../LegalCaseService.js";

// ADR-191 F3/F4 — áreas do direito + advogados + processos (composição sobre a clínica).
// Namespace próprio /api/advocacia (o /api/legal é a Consultora CDC/Trabalhista, ADR-115/178).
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

// ── Processos (ADR-191 F4 — legal_cases) ──
router.get("/cases", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  const contactId = typeof req.query.contactId === "string" ? req.query.contactId : undefined;
  const lawyerId = typeof req.query.lawyerId === "string" ? req.query.lawyerId : undefined;
  if (contactId) return res.json({ cases: LegalCaseService.listByClient(orgId, contactId) });
  if (lawyerId) return res.json({ cases: LegalCaseService.listByLawyer(orgId, lawyerId) });
  res.json({ cases: LegalCaseService.list(orgId, { status }) });
});

router.get("/cases/:id", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const c = LegalCaseService.get(orgId, req.params.id);
  if (!c) return res.status(404).json({ error: "not_found" });
  res.json(c);
});

router.post("/cases", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const b = req.body || {};
    res.json(LegalCaseService.open(orgId, {
      contactId: b.contactId, practiceAreaId: b.practiceAreaId, responsibleLawyerId: b.responsibleLawyerId,
      cnjNumber: b.cnjNumber, title: b.title, caseType: b.caseType, court: b.court, comarca: b.comarca,
      opposingParty: b.opposingParty, phase: b.phase,
    }, actor(req)));
  } catch (e: any) { res.status(400).json({ error: e?.message || "erro" }); }
});

router.post("/cases/:id/transfer", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(LegalCaseService.transfer(orgId, req.params.id, req.body?.responsibleLawyerId, actor(req))); }
  catch (e: any) { res.status(400).json({ error: e?.message || "erro" }); }
});

router.post("/cases/:id/phase", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(LegalCaseService.setPhase(orgId, req.params.id, req.body?.phase ?? null, actor(req))); }
  catch (e: any) { res.status(400).json({ error: e?.message || "erro" }); }
});

router.post("/cases/:id/close", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(LegalCaseService.close(orgId, req.params.id, req.body?.reason ?? null, actor(req))); }
  catch (e: any) { res.status(400).json({ error: e?.message || "erro" }); }
});

router.post("/cases/:id/reopen", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(LegalCaseService.reopen(orgId, req.params.id, actor(req))); }
  catch (e: any) { res.status(400).json({ error: e?.message || "erro" }); }
});

export default router;
