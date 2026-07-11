import { Router } from "express";
import { AuthRequest, requireRole } from "../middleware/auth.js";
import { PatientService } from "../PatientService.js";
import { ClinicAgendaService } from "../ClinicAgendaService.js";
import { ClinicPortalService } from "../ClinicPortalService.js";

/**
 * Módulo Clínica (ADR-080) — rotas sob /api/clinic, gated pelo módulo "clinica"
 * (ModuleService.MODULE_BY_ROUTE.clinic). Fase B: Ficha do Paciente. As demais
 * áreas (agenda clínica, autorização) entram nas próximas fases neste router.
 */
const router = Router();
const actor = (req: any) => req.user?.userId || req.user?.id;

// ── Ficha do Paciente ────────────────────────────────────────────────────
router.get("/patients", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json(PatientService.list(orgId, { q: req.query.q as string }));
});

router.get("/patients/:contactId", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(PatientService.getByContact(orgId, req.params.contactId)); }
  catch (e: any) { res.status(404).json({ error: e.message }); }
});

router.put("/patients/:contactId", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(PatientService.upsert(orgId, req.params.contactId, req.body || {}, actor(req))); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

// Troca de plano/convênio COM histórico — nunca apaga o paciente (dor central).
router.post("/patients/:contactId/change-plan", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(PatientService.changePlan(orgId, req.params.contactId, req.body || {}, actor(req))); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.get("/patients/:contactId/plan-history", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(PatientService.getByContact(orgId, req.params.contactId).planHistory); }
  catch (e: any) { res.status(404).json({ error: e.message }); }
});

// ── Profissionais e salas (cadastro é de gestor) ─────────────────────────
router.get("/professionals", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json(ClinicAgendaService.listProfessionals(orgId, req.query.all === "1"));
});

router.post("/professionals", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(ClinicAgendaService.createProfessional(orgId, req.body || {}, actor(req))); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.patch("/professionals/:id", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(ClinicAgendaService.updateProfessional(orgId, req.params.id, req.body || {}, actor(req))); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.get("/rooms", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json(ClinicAgendaService.listRooms(orgId));
});

router.post("/rooms", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(ClinicAgendaService.createRoom(orgId, String(req.body?.name || ""), actor(req))); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

// ── Agenda Clínica ───────────────────────────────────────────────────────
router.get("/agenda", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json(ClinicAgendaService.agendaForDay(orgId, req.query.date as string, {
    professionalId: req.query.professionalId as string, roomId: req.query.roomId as string, status: req.query.status as string,
  }));
});

router.post("/appointments", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(ClinicAgendaService.createAppointment(orgId, req.body || {}, actor(req))); }
  catch (e: any) { res.status(e.code === "CONFLICT" ? 409 : 400).json({ error: e.message, conflicts: e.conflicts }); }
});

const lifecycle = (fn: (orgId: string, id: string, actorId?: string) => any) => (req: AuthRequest, res: any): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(fn(orgId, req.params.id, actor(req))); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
};

router.post("/appointments/:id/checkin", lifecycle((o, i, a) => ClinicAgendaService.checkIn(o, i, a)));
router.post("/appointments/:id/start-care", lifecycle((o, i, a) => ClinicAgendaService.startCare(o, i, a)));
router.post("/appointments/:id/complete", lifecycle((o, i, a) => ClinicAgendaService.complete(o, i, a)));

router.post("/appointments/:id/extend", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(ClinicAgendaService.extend(orgId, req.params.id, Number(req.body?.addMinutes), !!req.body?.force, actor(req))); }
  catch (e: any) { res.status(e.code === "CONFLICT" ? 409 : 400).json({ error: e.message, conflicts: e.conflicts }); }
});

router.post("/appointments/:id/continuation", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(ClinicAgendaService.setContinuation(orgId, req.params.id, String(req.body?.status || ""), actor(req))); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

// ── Portal do profissional (gestão do link) + export ─────────────────────
router.get("/professionals/:id/portal", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json(ClinicPortalService.status(orgId, req.params.id));
});

router.post("/professionals/:id/portal", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const { token, expiresAt } = ClinicPortalService.generateToken(orgId, req.params.id, actor(req));
    // URL relativa: o front monta a absoluta com o próprio origin.
    res.json({ token, expiresAt, path: `/clinic/professional/${token}` });
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.delete("/professionals/:id/portal", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const ok = ClinicPortalService.revoke(orgId, req.params.id, actor(req));
  res.json({ revoked: ok });
});

// Exportação CSV da agenda do dia (impressão/planilha da recepção).
router.get("/agenda/export.csv", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const csv = ClinicPortalService.agendaCsv(orgId, req.query.date as string, { professionalId: req.query.professionalId as string });
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="agenda-${(req.query.date as string) || "hoje"}.csv"`);
  res.send("﻿" + csv); // BOM para Excel abrir acentos corretamente
});

export default router;
