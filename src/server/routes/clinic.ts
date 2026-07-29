import { Router } from "express";
import { AuthRequest, requireRole } from "../middleware/auth.js";
import { PatientService } from "../PatientService.js";
import { ClinicAgendaService } from "../ClinicAgendaService.js";
import { ClinicPortalService } from "../ClinicPortalService.js";
import { ClinicAuthorizationService } from "../ClinicAuthorizationService.js";
import { ClinicConnectionService } from "../ClinicConnectionService.js";
import { ClinicEncounterService } from "../ClinicEncounterService.js";
import { LgpdService } from "../LgpdService.js";

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

// ── Prontuário / SOAP (ADR-080 Fase G) ──────────────────────────────────
// Um encounter por consulta (UNIQUE(org, appointment_id)). Bloqueado por
// consentimento LGPD Art.11 (dado sensível de saúde). Depois de signed,
// updates ficam bloqueados aqui — a próxima fatia libera addendum.

// GET encounter da consulta (null se ainda não foi aberto).
router.get("/appointments/:id/encounter", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const enc = ClinicEncounterService.getByAppointment(orgId, req.params.id);
  res.json(enc);
});

// POST abre encounter (idempotente). 409 se falta consentimento LGPD sensível.
router.post("/appointments/:id/encounter", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(ClinicEncounterService.open(orgId, req.params.id, actor(req))); }
  catch (e: any) {
    if (e.code === "LGPD_CONSENT_REQUIRED") return res.status(409).json({ error: e.message, code: e.code });
    res.status(400).json({ error: e.message });
  }
});

// PATCH atualiza SOAP + form_data (extensível).
router.patch("/encounters/:id", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(ClinicEncounterService.update(orgId, req.params.id, actor(req), req.body || {})); }
  catch (e: any) {
    if (e.code === "ENCOUNTER_SIGNED") return res.status(409).json({ error: e.message, code: e.code });
    if (e.code === "LGPD_CONSENT_REQUIRED") return res.status(409).json({ error: e.message, code: e.code });
    res.status(400).json({ error: e.message });
  }
});

// POST finaliza (assina) — idempotente, mesmo estado se já signed.
router.post("/encounters/:id/finalize", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(ClinicEncounterService.finalize(orgId, req.params.id, actor(req))); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

// Histórico versionado (diff campo a campo de cada UPDATE + addendum futuro).
router.get("/encounters/:id/history", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json(ClinicEncounterService.history(orgId, req.params.id));
});

// Histórico clínico consolidado do paciente (todos os encounters).
router.get("/patients/:contactId/encounters", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const limit = Number(req.query.limit) || 50;
  res.json(ClinicEncounterService.listByPatient(orgId, req.params.contactId, limit));
});

// Consentimento LGPD Art.11 do paciente (dados sensíveis / saúde) — o gestor
// registra quando o paciente autorizou (verbal, papel, aceite digital).
// É o passo que destrava POST /encounter. Só owner/admin/atendente típico.
router.post("/patients/:contactId/consent/sensitive", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const { channel, legalBasis, policyVersion } = req.body || {};
  try {
    const consentId = LgpdService.grantConsent(orgId, req.params.contactId, "dados_sensiveis", {
      channel: channel || "in_person",
      legalBasis: legalBasis || "consent",
      policyVersion: policyVersion || undefined,
      actorId: actor(req),
    });
    res.json({ ok: true, consentId });
  } catch (e: any) { res.status(400).json({ error: e.message }); }
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

// ── Convênios e Autorização assistida (ADR-080, Fase E) ──────────────────
// Cadastro de operadora/credenciais/procedimento é de gestor. O fluxo da
// autorização (criar/preparar/enviar/registrar retorno) fica aberto à equipe.
router.get("/operators", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json(ClinicAuthorizationService.listOperators(orgId));
});

router.post("/operators", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(ClinicAuthorizationService.createOperator(orgId, req.body || {}, actor(req))); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.get("/operators/:id/credentials", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json(ClinicAuthorizationService.credentialsStatus(orgId, req.params.id));
});

router.put("/operators/:id/credentials", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(ClinicAuthorizationService.setCredentials(orgId, req.params.id, req.body || {}, actor(req))); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.get("/procedures", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json(ClinicAuthorizationService.listProcedures(orgId));
});

router.post("/procedures", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(ClinicAuthorizationService.createProcedure(orgId, req.body || {}, actor(req))); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.get("/authorizations", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json(ClinicAuthorizationService.listAuthorizations(orgId, { status: req.query.status as string, contactId: req.query.contactId as string }));
});

router.get("/authorizations/:id", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const a = ClinicAuthorizationService.getAuthorization(orgId, req.params.id);
  if (!a) return res.status(404).json({ error: "Solicitação não encontrada." });
  res.json(a);
});

router.post("/authorizations", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(ClinicAuthorizationService.createAuthorization(orgId, req.body || {}, actor(req))); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.post("/authorizations/:id/prepare", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(ClinicAuthorizationService.prepare(orgId, req.params.id, req.body || {}, actor(req))); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.post("/authorizations/:id/submit", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(ClinicAuthorizationService.submit(orgId, req.params.id, req.body || {}, actor(req))); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.patch("/authorizations/:id/status", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(ClinicAuthorizationService.setManualStatus(orgId, req.params.id, req.body || {}, actor(req))); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

// ── Onboarding de Conexão TISS (ADR-081, Fase F0) ────────────────────────
// Questionário self-service da clínica + mapa de prontidão. Perfil e prontidão
// são configuração de conexão — restritos a gestor.
router.get("/connection/profile", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json(ClinicConnectionService.getProfile(orgId));
});

router.put("/connection/profile", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(ClinicConnectionService.saveProfile(orgId, req.body || {}, actor(req))); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.patch("/operators/:id/readiness", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(ClinicConnectionService.setOperatorReadiness(orgId, req.params.id, req.body || {}, actor(req))); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.get("/connection/readiness", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json(ClinicConnectionService.readiness(orgId));
});

export default router;
