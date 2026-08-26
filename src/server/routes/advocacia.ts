import { Router } from "express";
import { AuthRequest, requireRole } from "../middleware/auth.js";
import { LegalPracticeService } from "../LegalPracticeService.js";
import { LegalCaseService } from "../LegalCaseService.js";
import { LegalDeadlineService } from "../LegalDeadlineService.js";
import { LegalHearingService } from "../LegalHearingService.js";
import { LegalDocumentService } from "../LegalDocumentService.js";
import { LegalFeeService } from "../LegalFeeService.js";
import { LegalPrivilegeService } from "../LegalPrivilegeService.js";
import { LegalTimesheetService } from "../LegalTimesheetService.js";
import { LegalSuccessFeeService } from "../LegalSuccessFeeService.js";
import { LegalProfessionalFederationService } from "../LegalProfessionalFederationService.js";

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

// ── Federação OAB (ADR-191 OAB-F1 — ponte de identidade com a Agenda Federada ADR-180) ──
router.get("/lawyers/:id/federation", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(LegalProfessionalFederationService.status(orgId, req.params.id)); }
  catch (e: any) { res.status(400).json({ error: e?.message || "erro" }); }
});

router.post("/lawyers/:id/federation", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(LegalProfessionalFederationService.federate(orgId, req.params.id, actor(req))); }
  catch (e: any) { res.status(400).json({ error: e?.message || "erro" }); }
});

router.post("/lawyers/:id/federation/revoke", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(LegalProfessionalFederationService.defederate(orgId, req.params.id, actor(req))); }
  catch (e: any) { res.status(400).json({ error: e?.message || "erro" }); }
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

// ── Prazos processuais (ADR-191 F5) ──
router.get("/holidays", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const year = req.query.year ? Number(req.query.year) : undefined;
  res.json({ holidays: LegalDeadlineService.listHolidays(orgId, year) });
});

router.post("/holidays", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const b = req.body || {};
    if (!b.date || !b.name) return res.status(400).json({ error: "Informe data (YYYY-MM-DD) e nome." });
    LegalDeadlineService.addHoliday(orgId, String(b.date), String(b.name), b.type || "local");
    res.json({ ok: true });
  } catch (e: any) { res.status(400).json({ error: e?.message || "erro" }); }
});

router.post("/holidays/seed/:year", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(LegalDeadlineService.seedNationalHolidays(orgId, Number(req.params.year))); }
  catch (e: any) { res.status(400).json({ error: e?.message || "erro" }); }
});

// Preview da data-fim SEM persistir (calculadora de prazo).
router.post("/deadlines/preview", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const b = req.body || {};
    res.json(LegalDeadlineService.computeDeadline(orgId, String(b.publicationDate), Number(b.termDays), b.countingMode === "calendar" ? "calendar" : "business"));
  } catch (e: any) { res.status(400).json({ error: e?.message || "erro" }); }
});

router.get("/deadlines", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  const caseId = typeof req.query.caseId === "string" ? req.query.caseId : undefined;
  res.json({ deadlines: LegalDeadlineService.list(orgId, { status, caseId }) });
});

router.post("/deadlines", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const b = req.body || {};
    res.json(LegalDeadlineService.create(orgId, { caseId: b.caseId, title: b.title, publicationDate: b.publicationDate, termDays: Number(b.termDays), countingMode: b.countingMode, isFatal: b.isFatal }, actor(req)));
  } catch (e: any) { res.status(400).json({ error: e?.message || "erro" }); }
});

router.post("/deadlines/:id/complete", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(LegalDeadlineService.complete(orgId, req.params.id, actor(req))); }
  catch (e: any) { res.status(400).json({ error: e?.message || "erro" }); }
});

router.post("/deadlines/:id/cancel", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(LegalDeadlineService.cancel(orgId, req.params.id, actor(req))); }
  catch (e: any) { res.status(400).json({ error: e?.message || "erro" }); }
});

// ── Audiências/reuniões (ADR-191 F6 — reuso da agenda amarrada ao processo) ──
router.get("/hearings", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  const caseId = typeof req.query.caseId === "string" ? req.query.caseId : undefined;
  const upcoming = req.query.upcoming === "1";
  res.json({ hearings: LegalHearingService.list(orgId, { status, caseId, upcoming }) });
});

router.get("/hearings/:id", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const h = LegalHearingService.get(orgId, req.params.id);
  if (!h) return res.status(404).json({ error: "not_found" });
  res.json(h);
});

router.post("/hearings", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const b = req.body || {};
    res.json(LegalHearingService.schedule(orgId, {
      caseId: b.caseId, title: b.title, hearingType: b.hearingType, start: b.start,
      durationMinutes: b.durationMinutes, lawyerId: b.lawyerId, location: b.location, force: !!b.force,
    }, actor(req)));
  } catch (e: any) { res.status(400).json({ error: e?.message || "erro", code: e?.code, conflicts: e?.conflicts }); }
});

router.post("/hearings/:id/reschedule", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const b = req.body || {};
    res.json(LegalHearingService.reschedule(orgId, req.params.id, b.start, b.durationMinutes, actor(req), !!b.force));
  } catch (e: any) { res.status(400).json({ error: e?.message || "erro", code: e?.code, conflicts: e?.conflicts }); }
});

router.post("/hearings/:id/complete", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(LegalHearingService.complete(orgId, req.params.id, actor(req))); }
  catch (e: any) { res.status(400).json({ error: e?.message || "erro" }); }
});

router.post("/hearings/:id/cancel", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(LegalHearingService.cancel(orgId, req.params.id, req.body?.reason ?? null, actor(req))); }
  catch (e: any) { res.status(400).json({ error: e?.message || "erro" }); }
});

// ── Documentos jurídicos (ADR-191 F7 — petição/contrato/procuração) ──
router.get("/documents", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const caseId = typeof req.query.caseId === "string" ? req.query.caseId : undefined;
  const contactId = typeof req.query.contactId === "string" ? req.query.contactId : undefined;
  const docType = typeof req.query.docType === "string" ? req.query.docType : undefined;
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  res.json({ documents: LegalDocumentService.list(orgId, { caseId, contactId, docType, status }) });
});

router.get("/documents/:id", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const d = LegalDocumentService.get(orgId, req.params.id);
    if (!d) return res.status(404).json({ error: "not_found" });
    res.json(d);
  } catch (e: any) {
    if (e?.code === "SIGILO_REQUIRED") return res.status(403).json({ error: e.message, code: e.code });
    res.status(400).json({ error: e?.message || "erro" });
  }
});

router.post("/documents", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const b = req.body || {};
    res.json(LegalDocumentService.createDraft(orgId, { caseId: b.caseId, contactId: b.contactId, professionalId: b.professionalId, docType: b.docType, title: b.title, body: b.body }, actor(req)));
  } catch (e: any) { res.status(400).json({ error: e?.message || "erro", code: e?.code }); }
});

router.put("/documents/:id", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const b = req.body || {};
    res.json(LegalDocumentService.update(orgId, req.params.id, { title: b.title, body: b.body, professionalId: b.professionalId }, actor(req)));
  } catch (e: any) { res.status(400).json({ error: e?.message || "erro" }); }
});

router.post("/documents/:id/issue", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(LegalDocumentService.issue(orgId, req.params.id, actor(req), { pin: req.body?.pin })); }
  catch (e: any) { res.status(400).json({ error: e?.message || "erro", code: e?.code }); }
});

router.post("/documents/:id/cancel", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(LegalDocumentService.cancel(orgId, req.params.id, req.body?.reason ?? null, actor(req))); }
  catch (e: any) { res.status(400).json({ error: e?.message || "erro" }); }
});

router.get("/documents/:id/pdf", async (req: AuthRequest, res): Promise<any> => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const pdf = await LegalDocumentService.renderPdf(orgId, req.params.id);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.send(pdf);
  } catch (e: any) {
    if (e?.code === "SIGILO_REQUIRED") return res.status(403).json({ error: e.message, code: e.code });
    res.status(400).json({ error: e?.message || "erro" });
  }
});

// ── Honorários (ADR-191 F8 — fixo→receivable, avença→subscription). Dinheiro role-gated (§73). ──
router.get("/fees", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const caseId = typeof req.query.caseId === "string" ? req.query.caseId : undefined;
  const contactId = typeof req.query.contactId === "string" ? req.query.contactId : undefined;
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  res.json({ fees: LegalFeeService.list(orgId, { caseId, contactId, status }) });
});

router.get("/fees/statement", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const caseId = typeof req.query.caseId === "string" ? req.query.caseId : undefined;
  const contactId = typeof req.query.contactId === "string" ? req.query.contactId : undefined;
  if (!caseId && !contactId) return res.status(400).json({ error: "Informe caseId ou contactId." });
  res.json(LegalFeeService.statement(orgId, { caseId, contactId }));
});

router.post("/fees/fixed", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const b = req.body || {};
    res.json(LegalFeeService.createFixed(orgId, { caseId: b.caseId, contactId: b.contactId, description: b.description, amount: Number(b.amount), dueDate: b.dueDate }, actor(req)));
  } catch (e: any) { res.status(400).json({ error: e?.message || "erro" }); }
});

router.post("/fees/retainer", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const b = req.body || {};
    res.json(LegalFeeService.createRetainer(orgId, { caseId: b.caseId, contactId: b.contactId, description: b.description, amount: Number(b.amount), startDate: b.startDate }, actor(req)));
  } catch (e: any) { res.status(400).json({ error: e?.message || "erro" }); }
});

router.post("/fees/:id/pay", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(LegalFeeService.markFixedPaid(orgId, req.params.id, { date: req.body?.date, accountId: req.body?.accountId }, actor(req))); }
  catch (e: any) { res.status(400).json({ error: e?.message || "erro" }); }
});

router.post("/fees/:id/cancel", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(LegalFeeService.cancel(orgId, req.params.id, actor(req))); }
  catch (e: any) { res.status(400).json({ error: e?.message || "erro" }); }
});

// ── Sigilo profissional (ADR-191 F9 — gate LGPD opt-in nos documentos do caso) ──
router.get("/privilege", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json({ enabled: LegalPrivilegeService.isEnabled(orgId) });
});

router.post("/privilege/enable", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json(LegalPrivilegeService.setEnabled(orgId, !!req.body?.enabled, actor(req)));
});

router.get("/clients/:contactId/sigilo", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json(LegalPrivilegeService.status(orgId, req.params.contactId));
});

router.post("/clients/:contactId/sigilo/grant", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(LegalPrivilegeService.grant(orgId, req.params.contactId, actor(req))); }
  catch (e: any) { res.status(400).json({ error: e?.message || "erro" }); }
});

router.post("/clients/:contactId/sigilo/revoke", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json(LegalPrivilegeService.revoke(orgId, req.params.contactId, actor(req)));
});

// ── Honorário por-hora / timesheet (ADR-191 F11). Dinheiro role-gated (§73). ──
router.get("/timesheet", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const caseId = typeof req.query.caseId === "string" ? req.query.caseId : undefined;
  const contactId = typeof req.query.contactId === "string" ? req.query.contactId : undefined;
  const professionalId = typeof req.query.professionalId === "string" ? req.query.professionalId : undefined;
  const billed = req.query.billed === "1" ? true : req.query.billed === "0" ? false : undefined;
  res.json({ entries: LegalTimesheetService.list(orgId, { caseId, contactId, professionalId, billed }) });
});

router.get("/timesheet/summary", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const caseId = typeof req.query.caseId === "string" ? req.query.caseId : undefined;
  const contactId = typeof req.query.contactId === "string" ? req.query.contactId : undefined;
  if (!caseId && !contactId) return res.status(400).json({ error: "Informe caseId ou contactId." });
  res.json(LegalTimesheetService.summary(orgId, { caseId, contactId, onlyUnbilled: req.query.onlyUnbilled === "1" }));
});

router.post("/timesheet", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const b = req.body || {};
    res.json(LegalTimesheetService.logTime(orgId, { caseId: b.caseId, contactId: b.contactId, professionalId: b.professionalId, description: b.description, minutes: Number(b.minutes), ratePerHour: b.ratePerHour, entryDate: b.entryDate, billable: b.billable }, actor(req)));
  } catch (e: any) { res.status(400).json({ error: e?.message || "erro" }); }
});

router.post("/timesheet/:id/void", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(LegalTimesheetService.voidEntry(orgId, req.params.id, actor(req))); }
  catch (e: any) { res.status(400).json({ error: e?.message || "erro" }); }
});

router.post("/timesheet/bill", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const b = req.body || {};
    res.json(LegalTimesheetService.bill(orgId, { caseId: b.caseId, contactId: b.contactId, dueDate: b.dueDate, defaultRatePerHour: b.defaultRatePerHour, description: b.description }, actor(req)));
  } catch (e: any) { res.status(400).json({ error: e?.message || "erro" }); }
});

// ── Honorário de êxito / success fee (ADR-191 F12). Dinheiro role-gated (§73). ──
router.get("/success-fees", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const caseId = typeof req.query.caseId === "string" ? req.query.caseId : undefined;
  const contactId = typeof req.query.contactId === "string" ? req.query.contactId : undefined;
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  res.json({ successFees: LegalSuccessFeeService.list(orgId, { caseId, contactId, status }) });
});

router.post("/success-fees", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const b = req.body || {};
    res.json(LegalSuccessFeeService.agree(orgId, { caseId: b.caseId, percent: Number(b.percent), description: b.description }, actor(req)));
  } catch (e: any) { res.status(400).json({ error: e?.message || "erro" }); }
});

router.post("/success-fees/:id/preview", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(LegalSuccessFeeService.preview(orgId, req.params.id, Number(req.body?.baseAmount))); }
  catch (e: any) { res.status(400).json({ error: e?.message || "erro" }); }
});

router.post("/success-fees/:id/confirm", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const b = req.body || {};
    res.json(LegalSuccessFeeService.confirm(orgId, req.params.id, { baseAmount: Number(b.baseAmount), dueDate: b.dueDate }, actor(req)));
  } catch (e: any) { res.status(400).json({ error: e?.message || "erro" }); }
});

router.post("/success-fees/:id/cancel", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(LegalSuccessFeeService.cancel(orgId, req.params.id, actor(req))); }
  catch (e: any) { res.status(400).json({ error: e?.message || "erro" }); }
});

export default router;
