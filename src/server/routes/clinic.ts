import { Router } from "express";
import multer from "multer";
import { AuthRequest, requireRole } from "../middleware/auth.js";
import db from "../db.js";
import { PatientService } from "../PatientService.js";
import { ClinicPetService } from "../ClinicPetService.js";
import { ClinicGroomingService } from "../ClinicGroomingService.js";
import { ClinicPetCareService } from "../ClinicPetCareService.js";
import { ClinicPetHistoryService } from "../ClinicPetHistoryService.js";
import { ClinicAgendaService } from "../ClinicAgendaService.js";
import { ClinicPortalService } from "../ClinicPortalService.js";
import { ClinicAuthorizationService } from "../ClinicAuthorizationService.js";
import { ClinicConnectionService } from "../ClinicConnectionService.js";
import { ClinicEncounterService } from "../ClinicEncounterService.js";
import { ClinicDocumentsService, resetPinLockout } from "../ClinicDocumentsService.js";
import { ClinicAttachmentService, ALLOWED_MIME, MAX_BYTES, safeFilename } from "../ClinicAttachmentService.js";
import { ClinicDocumentDeliveryService } from "../ClinicDocumentDeliveryService.js";
import { ClinicPatientPortalService } from "../ClinicPatientPortalService.js";
import { ClinicReminderService } from "../ClinicReminderService.js";
import { ClinicMetricsService } from "../ClinicMetricsService.js";
import { ClinicVacancyService } from "../ClinicVacancyService.js";
import { ClinicRetentionService } from "../ClinicRetentionService.js";
import { ClinicMonthlyReportService } from "../ClinicMonthlyReportService.js";
import { ClinicPatientTimelineService, TimelineKind } from "../ClinicPatientTimelineService.js";
import { ClinicProfessionalAbsenceService, AbsenceReason } from "../ClinicProfessionalAbsenceService.js";
import { Cid10Service } from "../Cid10Service.js";
import { ClinicAddendumNoticeService } from "../ClinicAddendumNoticeService.js";
import { ClinicPatientAllergyService } from "../ClinicPatientAllergyService.js";
import { ClinicFollowUpNoticeService } from "../ClinicFollowUpNoticeService.js";
import { ClinicMonthlyReportDeliveryService } from "../ClinicMonthlyReportDeliveryService.js";
import { ClinicSpecialtyService } from "../ClinicSpecialtyService.js";
import { ClinicCareEpisodeService } from "../ClinicCareEpisodeService.js";
import { ClinicTreatmentCycleService } from "../ClinicTreatmentCycleService.js";
import { ClinicCareJourneyMetricsService, QueueFilter } from "../ClinicCareJourneyMetricsService.js";
import { ClinicScheduleSessionService } from "../ClinicScheduleSessionService.js";
import { ClinicRenewalTaskService } from "../ClinicRenewalTaskService.js";
import { ClinicGuideService, GuideType, GuideStatus } from "../ClinicGuideService.js";
import { ClinicGuideDeliveryService } from "../ClinicGuideDeliveryService.js";
import { ClinicReceiptService } from "../ClinicReceiptService.js";
import { LgpdService } from "../LgpdService.js";
import { ProfessionalService } from "../ProfessionalService.js";
import { ClinicProfessionalRelationshipService } from "../ClinicProfessionalRelationshipService.js";
import { ProfessionalScheduleConfigService } from "../ProfessionalScheduleConfigService.js";
import { ProfessionalAvailabilityService } from "../ProfessionalAvailabilityService.js";
import { ProfessionalBookingService } from "../ProfessionalBookingService.js";
import { ProfessionalAuthService } from "../ProfessionalAuthService.js";
import { ProfessionalDemandService } from "../ProfessionalDemandService.js";
import { ClinicDiscoveryService } from "../ClinicDiscoveryService.js";
import { ProfessionalFinanceService } from "../ProfessionalFinanceService.js";
import { ProfessionalGoogleService } from "../ProfessionalGoogleService.js";
import { ProfessionalNetworkSettingsService } from "../ProfessionalNetworkSettingsService.js";
import { logAuthEvent } from "../auditLog.js";

// Upload de anexo clínico (ADR-080 Fase J) — mesmo padrão de radar.ts:24-31.
// memoryStorage porque o service escreve em PRIVATE_MEDIA_DIR (fora do
// /media estático — dado sensível LGPD Art.11).
const attachmentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIME[file.mimetype]) cb(null, true);
    else cb(new Error("Formato não suportado (use PNG, JPG, WEBP ou PDF)."));
  },
});

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

// PIN de assinatura (ADR-080 Fase T). Owner/admin controla; body {pin: string|null}.
router.put("/professionals/:id/pin", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(ClinicAgendaService.setProfessionalPin(orgId, req.params.id, req.body?.pin ?? null, actor(req))); }
  catch (e: any) {
    if (e.code === "PIN_INVALID_FORMAT") return res.status(400).json({ error: e.message, code: e.code });
    res.status(400).json({ error: e.message });
  }
});
// Fase 18: restrito a owner/admin — expor "qual profissional tem PIN?" a
// qualquer `agent` autenticado facilita brute-force direcionado (agent
// enumera, tenta emitir sem PIN em nome do profissional sem PIN).
router.get("/professionals/:id/pin-status", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json({ hasPin: ClinicAgendaService.hasProfessionalPin(orgId, req.params.id) });
});
// Fase 28: destravar PIN antes dos 15 min naturais do lockout. Só owner|admin —
// prevê o cenário legítimo (profissional confirmou identidade por outro
// canal e precisa emitir agora) sem abrir vetor pro `agent` bypassar o
// brute-force protection.
router.post("/professionals/:id/pin/reset-lockout", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    resetPinLockout(orgId, req.params.id, actor(req));
    res.json({ reset: true });
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

// ── Indisponibilidade do profissional (ADR-080 Fase 22) ─────────────────
// Bloqueia CRIAÇÃO nova de appointment que se sobrepõe à ausência
// (createAppointment devolve 409 PROFESSIONAL_UNAVAILABLE). NÃO cancela
// appts pré-existentes — gestor decide caso a caso.
router.get("/professionals/:id/absences", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json(ClinicProfessionalAbsenceService.list(orgId, {
    professionalId: req.params.id,
    activeAt: typeof req.query.activeAt === "string" ? req.query.activeAt : undefined,
    from: typeof req.query.from === "string" ? req.query.from : undefined,
    to: typeof req.query.to === "string" ? req.query.to : undefined,
    limit: req.query.limit ? Number(req.query.limit) : undefined,
  }));
});

router.post("/professionals/:id/absences", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const body = req.body || {};
  try {
    res.json(ClinicProfessionalAbsenceService.create(orgId, req.params.id, {
      startsAt: String(body.startsAt || ""),
      endsAt: String(body.endsAt || ""),
      reason: body.reason as AbsenceReason,
      notes: body.notes ?? null,
    }, actor(req)));
  } catch (e: any) {
    if (e?.code === "ABSENCE_INVALID_RANGE" || e?.code === "ABSENCE_INVALID_REASON") {
      return res.status(400).json({ error: e.message, code: e.code });
    }
    res.status(400).json({ error: e.message });
  }
});

router.delete("/absences/:id", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { ClinicProfessionalAbsenceService.remove(orgId, req.params.id, actor(req)); res.json({ ok: true }); }
  catch (e: any) { res.status(404).json({ error: e.message }); }
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
  catch (e: any) {
    if (e.code === "CONFLICT") return res.status(409).json({ error: e.message, code: e.code, conflicts: e.conflicts });
    if (e.code === "PROFESSIONAL_UNAVAILABLE") return res.status(409).json({ error: e.message, code: e.code, absence: e.absence });
    res.status(400).json({ error: e.message });
  }
});

const lifecycle = (fn: (orgId: string, id: string, actorId?: string) => any) => async (req: AuthRequest, res: any): Promise<any> => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(await fn(orgId, req.params.id, actor(req))); }
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

// Cancelamento pela recepção (ADR-080 Fase 31 — UX blocker H1).
// Botão "Cancelar" no painel dispara aqui. `cancelledBy='staff'` distingue
// da cancelamento via SIM/NÃO WhatsApp (patient) e via retenção (system).
// Grace window de 5min antes de disparar tryOfferOnCancel — se a recepção
// re-ativar o appt dentro desse intervalo (raro mas real: "opa, cliquei
// errado"), a vaga não é ofertada e o Scheduler não bombardeia outros
// pacientes. Passar `graceMs:0` no body pra bypassar (ex.: cancel
// definitivo já confirmado). Idempotente — service.cancel() 2× devolve
// mesmo estado sem mudar timestamps.
router.post("/appointments/:id/cancel", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const cancelled = ClinicAgendaService.cancel(
      orgId, req.params.id,
      { reason: req.body?.reason, cancelledBy: "staff" },
      actor(req)
    );
    // Fire-and-forget: não bloqueia response da UI.
    const graceMs = req.body?.graceMs === 0 ? 0 : 5 * 60_000;
    Promise.resolve().then(() =>
      ClinicVacancyService.tryOfferOnCancel(orgId, req.params.id, { graceMs })
    ).catch(() => { /* best-effort */ });
    res.json(cancelled);
  } catch (e: any) {
    if (e?.message?.includes("não encontrado")) return res.status(404).json({ error: e.message });
    res.status(400).json({ error: e.message });
  }
});

// Retorno em 1 clique + fila (ADR-080 Fase I).
router.post("/appointments/:id/follow-up", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const created = ClinicAgendaService.scheduleFollowUp(orgId, req.params.id, req.body || {}, actor(req));
    res.json(created);
  } catch (e: any) {
    res.status(e.code === "CONFLICT" ? 409 : 400).json({ error: e.message, conflicts: e.conflicts });
  }
});

router.get("/follow-up-queue", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const limit = Number(req.query.limit) || 100;
  res.json(ClinicAgendaService.followUpQueue(orgId, limit));
});
// Fase 31: contagem-só pra badge do menu ("Fila (3)"). Evita front baixar
// array grande só pra saber se tem item. Reusa a mesma query da lista
// (limit alto pra count aproximado real; 200 é o teto do service).
router.get("/follow-up-queue/count", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const list = ClinicAgendaService.followUpQueue(orgId, 200);
  res.json({ count: Array.isArray(list) ? list.length : 0 });
});

router.patch("/encounters/:id/follow-up-recommendation", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const days = req.body?.days === null || req.body?.days === undefined ? null : Number(req.body.days);
  try { res.json(ClinicEncounterService.setFollowUpRecommendation(orgId, req.params.id, actor(req), days)); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
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
// Fase 19: consent LGPD Art.11 é revalidado no read — sem consent, 403.
router.get("/appointments/:id/encounter", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const enc = ClinicEncounterService.getByAppointment(orgId, req.params.id);
    // Fase 28: read-audit LGPD Art.9 — só quando existe encounter (row null
    // não é leitura de dado sensível). Actor sempre vem do JWT (rota autenticada).
    if (enc) {
      logAuthEvent(orgId, actor(req), enc.contactId, "CLINIC_ENCOUNTER_VIEWED", {
        encounterId: enc.id, appointmentId: req.params.id, via: "appointment",
      });
    }
    res.json(enc);
  } catch (e: any) {
    if (e?.code === "LGPD_CONSENT_REQUIRED") return res.status(403).json({ error: e.message, code: e.code });
    res.status(400).json({ error: e.message });
  }
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
// Fase 19: gate LGPD SENSITIVE — cada versão é foto do SOAP, dado sensível.
router.get("/encounters/:id/history", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const rows = ClinicEncounterService.history(orgId, req.params.id);
    // Fase 28: read-audit LGPD Art.9 — histórico é dado sensível.
    const enc = ClinicEncounterService.get(orgId, req.params.id);
    if (enc) {
      logAuthEvent(orgId, actor(req), enc.contactId, "CLINIC_ENCOUNTER_VIEWED", {
        encounterId: enc.id, via: "history", entries: Array.isArray(rows) ? rows.length : 0,
      });
    }
    res.json(rows);
  }
  catch (e: any) {
    if (e?.code === "LGPD_CONSENT_REQUIRED") return res.status(403).json({ error: e.message, code: e.code });
    res.status(400).json({ error: e.message });
  }
});

// Addendum ao prontuário assinado (ADR-080 Fase 20). CFM 1.821/2007 —
// prontuário `signed` é imutável, addendum é APPEND-ONLY. Autoria +
// timestamp por row. PIN opcional (reusa Fase T — profissional sem PIN
// cadastrado assina sem PIN). LGPD Art.11 no service.
router.get("/encounters/:id/addendums", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(ClinicEncounterService.listAddendums(orgId, req.params.id)); }
  catch (e: any) {
    if (e?.code === "LGPD_CONSENT_REQUIRED") return res.status(403).json({ error: e.message, code: e.code });
    res.status(400).json({ error: e.message });
  }
});
router.post("/encounters/:id/addendums", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const body = req.body || {};
  try {
    res.json(ClinicEncounterService.addAddendum(orgId, req.params.id, actor(req), {
      note: String(body.note || ""),
      actorName: (req as any).user?.name ?? null,
      pin: body.pin,
    }));
  } catch (e: any) {
    if (e?.code === "LGPD_CONSENT_REQUIRED") return res.status(403).json({ error: e.message, code: e.code });
    if (e?.code === "ENCOUNTER_NOT_SIGNED") return res.status(409).json({ error: e.message, code: e.code });
    if (e?.code === "PIN_REQUIRED" || e?.code === "PIN_INVALID") return res.status(401).json({ error: e.message, code: e.code });
    if (e?.code === "PIN_LOCKED") return res.status(423).json({ error: e.message, code: e.code, until: e.until || null });
    if (e?.code === "ADDENDUM_EMPTY" || e?.code === "ADDENDUM_TOO_LONG") return res.status(400).json({ error: e.message, code: e.code });
    res.status(400).json({ error: e.message });
  }
});

// Notificação de addendum ao paciente (ADR-080 Fase 24). Auto-dispara no
// addAddendum (best-effort, no service). Rotas manuais pra ver histórico e
// re-enviar (paciente pode ter apagado a mensagem).
router.get("/addendums/:id/notifications", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json(ClinicAddendumNoticeService.list(orgId, req.params.id));
});
router.post("/addendums/:id/notify", async (req: AuthRequest, res): Promise<any> => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const result = await ClinicAddendumNoticeService.notifyForAddendum(orgId, req.params.id, {
      actorId: actor(req),
      force: !!req.body?.force,
    });
    if (!result) return res.status(404).json({ error: "Addendum não encontrado." });
    res.json(result);
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

// Toggle da notificação por org.
router.get("/settings/addendum-notification", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const r = db.prepare(`SELECT clinic_addendum_notification_enabled FROM organization_settings WHERE organization_id = ?`).get(orgId) as any;
  const enabled = r == null || r.clinic_addendum_notification_enabled == null || Number(r.clinic_addendum_notification_enabled) !== 0;
  res.json({ enabled });
});
router.put("/settings/addendum-notification", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const enabled = req.body?.enabled === false ? 0 : 1;
  db.prepare(`UPDATE organization_settings SET clinic_addendum_notification_enabled = ? WHERE organization_id = ?`).run(enabled, orgId);
  res.json({ enabled: enabled === 1 });
});

// Notificação automática de retorno (ADR-080 Fase 26). Auto-dispara via
// Scheduler; rotas manuais pra ver histórico, re-enviar (paciente apagou
// mensagem) e configurar o toggle + lead-days por org.
router.get("/encounters/:id/follow-up-notifications", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json(ClinicFollowUpNoticeService.list(orgId, req.params.id));
});
router.post("/encounters/:id/notify-follow-up", async (req: AuthRequest, res): Promise<any> => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const result = await ClinicFollowUpNoticeService.notifyForEncounter(orgId, req.params.id, {
      actorId: actor(req),
      force: !!req.body?.force,
    });
    if (!result) return res.status(404).json({ error: "Prontuário não encontrado ou sem recomendação de retorno." });
    res.json(result);
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.get("/settings/followup-notification", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const r = db.prepare(
    `SELECT clinic_followup_notification_enabled AS en,
            clinic_followup_notification_lead_days AS lead
       FROM organization_settings WHERE organization_id = ?`
  ).get(orgId) as any;
  const enabled = r == null || r.en == null || Number(r.en) !== 0;
  const leadDays = r?.lead != null ? Number(r.lead) : 3;
  res.json({ enabled, leadDays });
});
router.put("/settings/followup-notification", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const patches: string[] = [];
  const params: any[] = [];
  if (req.body?.enabled !== undefined) {
    patches.push("clinic_followup_notification_enabled = ?");
    params.push(req.body.enabled === false ? 0 : 1);
  }
  if (req.body?.leadDays !== undefined) {
    const n = Math.floor(Number(req.body.leadDays));
    if (!Number.isFinite(n) || n < 1 || n > 30) {
      return res.status(400).json({ error: "leadDays deve estar entre 1 e 30." });
    }
    patches.push("clinic_followup_notification_lead_days = ?");
    params.push(n);
  }
  if (patches.length) {
    db.prepare(`UPDATE organization_settings SET ${patches.join(", ")} WHERE organization_id = ?`).run(...params, orgId);
  }
  const r = db.prepare(
    `SELECT clinic_followup_notification_enabled AS en,
            clinic_followup_notification_lead_days AS lead
       FROM organization_settings WHERE organization_id = ?`
  ).get(orgId) as any;
  res.json({
    enabled: r == null || r.en == null || Number(r.en) !== 0,
    leadDays: r?.lead != null ? Number(r.lead) : 3,
  });
});

// Alergias do paciente (ADR-080 Fase 25). Dado sensível (LGPD Art.11) — o
// service faz gate; 403 diferencia "consent revogado" de "não achou" (404).
// CRUD aberto pra qualquer usuário autenticado do org (mesmo padrão do
// encounter — o profissional que atende precisa registrar; RBAC granular
// por profissional foge do escopo desta fatia). Soft delete via DELETE.
router.get("/patients/:contactId/allergies", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const includeInactive = req.query.includeInactive === "true" || req.query.includeInactive === "1";
    res.json(ClinicPatientAllergyService.list(orgId, req.params.contactId, { includeInactive }));
  } catch (e: any) {
    if (e?.code === "LGPD_CONSENT_REQUIRED") return res.status(403).json({ error: e.message, code: e.code });
    res.status(400).json({ error: e.message });
  }
});
router.post("/patients/:contactId/allergies", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    res.json(ClinicPatientAllergyService.add(orgId, req.params.contactId, actor(req), req.body || {}));
  } catch (e: any) {
    if (e?.code === "LGPD_CONSENT_REQUIRED") return res.status(403).json({ error: e.message, code: e.code });
    if (e?.code === "ALLERGY_INVALID_KIND" || e?.code === "ALLERGY_INVALID_SEVERITY") {
      return res.status(400).json({ error: e.message, code: e.code });
    }
    res.status(400).json({ error: e.message });
  }
});
router.patch("/allergies/:id", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    res.json(ClinicPatientAllergyService.update(orgId, req.params.id, actor(req), req.body || {}));
  } catch (e: any) {
    if (e?.code === "LGPD_CONSENT_REQUIRED") return res.status(403).json({ error: e.message, code: e.code });
    if (e?.code === "ALLERGY_INVALID_KIND" || e?.code === "ALLERGY_INVALID_SEVERITY") {
      return res.status(400).json({ error: e.message, code: e.code });
    }
    res.status(400).json({ error: e.message });
  }
});
router.delete("/allergies/:id", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    res.json(ClinicPatientAllergyService.deactivate(orgId, req.params.id, actor(req)));
  } catch (e: any) {
    if (e?.code === "LGPD_CONSENT_REQUIRED") return res.status(403).json({ error: e.message, code: e.code });
    res.status(400).json({ error: e.message });
  }
});
// Checagem manual (a UI usa antes de submeter a receita pra avisar cedo).
// Não persiste nada — só devolve o `alerts[]`. NÃO gata consent aqui: o
// hook em createPrescription já gata via requireConsent na chamada real.
router.post("/patients/:contactId/allergy-check", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  try {
    const alerts = ClinicPatientAllergyService.checkPrescription(orgId, req.params.contactId, items);
    res.json({ alerts, hasSevere: ClinicPatientAllergyService.hasSevere(alerts) });
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

// Histórico clínico consolidado do paciente (todos os encounters).
// Fase 19: gate LGPD SENSITIVE — paciente revogado → 403.
router.get("/patients/:contactId/encounters", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const limit = Number(req.query.limit) || 50;
  try {
    const list = ClinicEncounterService.listByPatient(orgId, req.params.contactId, limit);
    // Fase 28: read-audit LGPD Art.9 — lista completa é dado sensível.
    logAuthEvent(orgId, actor(req), req.params.contactId, "CLINIC_ENCOUNTER_VIEWED", {
      via: "patient-list", count: Array.isArray(list) ? list.length : 0,
    });
    res.json(list);
  }
  catch (e: any) {
    if (e?.code === "LGPD_CONSENT_REQUIRED") return res.status(403).json({ error: e.message, code: e.code });
    res.status(400).json({ error: e.message });
  }
});

// Timeline unificada do paciente (ADR-080 Fase 21). Cronologia única
// misturando consultas, prontuário, addendums, receitas, atestados, anexos
// e envios. LGPD Art.11 no service (403 em revoke). Query params opcionais:
// ?from=ISO&to=ISO&limit=100&kinds=encounter_signed,prescription_issued
router.get("/patients/:contactId/timeline", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const kindsParam = typeof req.query.kinds === "string" ? req.query.kinds : "";
  const kinds = kindsParam
    ? (kindsParam.split(",").map((s) => s.trim()).filter(Boolean) as TimelineKind[])
    : undefined;
  try {
    res.json(ClinicPatientTimelineService.getTimeline(orgId, req.params.contactId, {
      from: typeof req.query.from === "string" ? req.query.from : undefined,
      to: typeof req.query.to === "string" ? req.query.to : undefined,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
      kinds,
    }));
  } catch (e: any) {
    if (e?.code === "LGPD_CONSENT_REQUIRED") return res.status(403).json({ error: e.message, code: e.code });
    res.status(400).json({ error: e.message });
  }
});

// ── Documentos clínicos: Receita + Atestado (ADR-080 Fase H) ────────────
// Ciclo draft → issued (imutável após issued). LGPD Art.11 no service.
// PDF é Buffer (padrão ReportPdfService.generateGovernancePdf).

const docError = (res: any, e: any) => {
  if (e?.code === "LGPD_CONSENT_REQUIRED" || e?.code === "DOCUMENT_ISSUED") {
    return res.status(409).json({ error: e.message, code: e.code });
  }
  if (e?.code === "PIN_REQUIRED" || e?.code === "PIN_INVALID") {
    return res.status(401).json({ error: e.message, code: e.code });
  }
  // Fase 28: PIN_LOCKED — 5 tentativas erradas em 15min bloqueiam o
  // profissional. 423 Locked deixa a UI diferenciar de PIN_INVALID pra
  // mostrar "aguarde X min ou peça pra owner destravar" em vez de
  // insistir na tentativa. `e.until` carrega ISO do desbloqueio automático.
  if (e?.code === "PIN_LOCKED") {
    return res.status(423).json({ error: e.message, code: e.code, until: e.until || null });
  }
  // Fase 25: ALLERGY_ALERT vem com payload {alerts} pra UI oferecer opção
  // "confirmar mesmo assim" (envia de novo com force:true) OU decidir por
  // outro medicamento. 409 (conflito), não 400 (bad request) — a receita
  // não está mal-formada; o CONTEXTO clínico é que trava.
  if (e?.code === "ALLERGY_ALERT") {
    return res.status(409).json({ error: e.message, code: e.code, alerts: e.payload?.alerts || [] });
  }
  return res.status(400).json({ error: e.message });
};

// Listagem consolidada dos docs do encounter.
// Fase 19: gate LGPD SENSITIVE (doc é dado sensível — mesmo o pack {rx, cert}).
router.get("/encounters/:id/documents", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(ClinicDocumentsService.listByEncounter(orgId, req.params.id)); }
  catch (e: any) {
    if (e?.code === "LGPD_CONSENT_REQUIRED") return res.status(403).json({ error: e.message, code: e.code });
    res.status(400).json({ error: e.message });
  }
});

// Receita
router.post("/encounters/:id/prescriptions", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(ClinicDocumentsService.createPrescription(orgId, req.params.id, req.body || {}, actor(req))); }
  catch (e: any) { docError(res, e); }
});
router.patch("/prescriptions/:id", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(ClinicDocumentsService.updatePrescription(orgId, req.params.id, actor(req), req.body || {})); }
  catch (e: any) { docError(res, e); }
});
// Fase 18: emissão restrita a owner/admin. Antes, qualquer `agent` (recepção,
// estagiário, atendente) podia emitir receita em nome de qualquer profissional
// se ele nunca tivesse configurado PIN — `verifyPin` degrada pra `false` no
// legado sem PIN. Restringir role fecha o vetor sem exigir migração de PIN.
router.post("/prescriptions/:id/issue", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(ClinicDocumentsService.issuePrescription(orgId, req.params.id, actor(req), { pin: req.body?.pin, force: req.body?.force === true })); }
  catch (e: any) { docError(res, e); }
});
router.get("/prescriptions/:id/pdf", async (req: AuthRequest, res): Promise<any> => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const pdf = await ClinicDocumentsService.renderPrescriptionPdf(orgId, req.params.id);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Disposition", `attachment; filename="receita-${req.params.id}.pdf"`);
    return res.send(pdf);
  } catch (e: any) {
    // Fase 19: consent revogado no meio do fluxo → 403.
    if (e?.code === "LGPD_CONSENT_REQUIRED") return res.status(403).json({ error: e.message, code: e.code });
    res.status(400).json({ error: e.message });
  }
});

// Especialidades normalizadas (ADR-145 Fase 1 / Fatia 35). CRUD +
// vínculos profissional↔especialidade + backfill idempotente do texto
// legado clinic_professionals.specialty. Escrita restrita a owner|admin
// (gestor cadastra; recepção só consulta). Backfill exposto como POST
// dedicado — não roda automaticamente pra dar controle do momento.
router.get("/specialties", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const includeInactive = String(req.query.includeInactive || "") === "1";
  res.json({ specialties: ClinicSpecialtyService.list(orgId, { includeInactive }) });
});

router.post("/specialties", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const specialty = ClinicSpecialtyService.create(orgId, req.body || {}, actor(req) ?? null);
    res.json({ specialty });
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.get("/specialties/:id", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const s = ClinicSpecialtyService.get(orgId, req.params.id);
  if (!s) return res.status(404).json({ error: "Especialidade não encontrada." });
  res.json({ specialty: s });
});

router.patch("/specialties/:id", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const s = ClinicSpecialtyService.update(orgId, req.params.id, req.body || {}, actor(req) ?? null);
    if (!s) return res.status(404).json({ error: "Especialidade não encontrada." });
    res.json({ specialty: s });
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.get("/specialties/:id/professionals", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const activeOnly = String(req.query.activeOnly || "1") !== "0";
  res.json({
    professionals: ClinicSpecialtyService.listProfessionalsForSpecialty(orgId, req.params.id, { activeOnly }),
  });
});

// Especialidades de UM profissional + substituição atômica do conjunto.
router.get("/professionals/:id/specialties", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const activeOnly = String(req.query.activeOnly || "1") !== "0";
  res.json({
    specialties: ClinicSpecialtyService.listSpecialtiesForProfessional(orgId, req.params.id, { activeOnly }),
  });
});

router.put("/professionals/:id/specialties", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const items = Array.isArray(req.body?.specialties) ? req.body.specialties : [];
  try {
    const links = ClinicSpecialtyService.setProfessionalSpecialties(orgId, req.params.id, items, actor(req) ?? null);
    res.json({ links });
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.post("/specialties/backfill", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const summary = ClinicSpecialtyService.backfillFromLegacy(orgId, actor(req) ?? null);
    res.json({ summary });
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

// Episódio de cuidado / tratamento (ADR-145 D1 / Fatia 36). Entidade
// CENTRAL da Jornada de Tratamento. Abrir/listar/transferir/hold/resume/
// cancel — SEM alta ou reopen (Fatia 39, exige PIN). Ação de escrita
// aberta a qualquer autenticado (a recepção precisa abrir episódios), mas
// transfer é owner|admin (troca de responsável é decisão gerencial).
function episodeError(res: any, e: any) {
  const code = e?.code;
  const status = code === "EPISODE_ALREADY_ACTIVE" ? 409
              : code === "EPISODE_NOT_ACTIVE" ? 409
              : code === "EPISODE_NOT_ON_HOLD" ? 409
              : code === "EPISODE_ALREADY_DISCHARGED" ? 409
              : code === "TRANSFER_NOOP" ? 409
              : code === "PROFESSIONAL_NOT_IN_SPECIALTY" ? 400
              : code === "EPISODE_PROFESSIONAL_MISMATCH" ? 409
              : code === "EPISODE_ALREADY_DISCHARGED" ? 409
              : code === "EPISODE_NOT_DISCHARGED" ? 409
              : code === "EPISODE_DISCHARGED" ? 409
              : code === "PIN_REQUIRED" ? 400
              : code === "PIN_INVALID" ? 401
              : code === "PIN_LOCKED" ? 423
              : 400;
  res.status(status).json({ error: e.message, code: code || null,
    existingEpisodeId: e.existingEpisodeId || undefined,
    expectedProfessionalId: e.expectedProfessionalId || undefined,
    dischargedAt: e.dischargedAt || undefined,
    until: e.until || undefined });
}

router.get("/patients/:contactId/care-episodes", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const activeOnly = String(req.query.activeOnly || "") === "1";
  res.json({
    episodes: ClinicCareEpisodeService.listByPatient(orgId, req.params.contactId, { activeOnly }),
  });
});

router.post("/patients/:contactId/care-episodes", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const episode = ClinicCareEpisodeService.open(orgId, req.params.contactId, req.body || {}, actor(req) ?? null);
    res.json({ episode });
  } catch (e: any) { episodeError(res, e); }
});

// Assistente "Adicionar Especialidade" (ADR-145 RF-010, Fatia 37). Abre
// episódio + agenda 1º appointment em UMA transação — se qualquer parte
// falhar, nada persiste. firstAppointmentAt opcional (sem ele, só abre
// o episódio e o operador agenda depois).
router.post("/patients/:contactId/add-specialty", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const result = ClinicCareEpisodeService.addSpecialtyForPatient(
      orgId, req.params.contactId, req.body || {}, actor(req) ?? null
    );
    res.json(result);
  } catch (e: any) { episodeError(res, e); }
});

router.get("/care-episodes/:id", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const ep = ClinicCareEpisodeService.get(orgId, req.params.id);
  if (!ep) return res.status(404).json({ error: "Episódio não encontrado." });
  res.json({ episode: ep, transfers: ClinicCareEpisodeService.listTransfers(orgId, req.params.id) });
});

router.get("/care-episodes/:id/transfers", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json({ transfers: ClinicCareEpisodeService.listTransfers(orgId, req.params.id) });
});

router.post("/care-episodes/:id/transfer", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const result = ClinicCareEpisodeService.transfer(orgId, req.params.id, req.body || {}, actor(req) ?? null);
    res.json(result);
  } catch (e: any) { episodeError(res, e); }
});

router.post("/care-episodes/:id/hold", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const episode = ClinicCareEpisodeService.hold(orgId, req.params.id, req.body || {}, actor(req) ?? null);
    res.json({ episode });
  } catch (e: any) { episodeError(res, e); }
});

router.post("/care-episodes/:id/resume", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const episode = ClinicCareEpisodeService.resume(orgId, req.params.id, actor(req) ?? null);
    res.json({ episode });
  } catch (e: any) { episodeError(res, e); }
});

// Alta explícita (ADR-145 D5, Fatia 39). PIN OBRIGATÓRIO — cliente
// confirmou. NÃO cancela appointments futuros; NÃO apaga dados. Só esta
// rota fecha episódio. Reusa verifyPin da Fase 28 (timingSafeEqual +
// lockout 5×/15min). Body: {professionalId, pin, dischargeType, summary}.
router.post("/care-episodes/:id/discharge", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const episode = ClinicCareEpisodeService.discharge(orgId, req.params.id, req.body || {}, actor(req) ?? null);
    res.json({ episode });
  } catch (e: any) { episodeError(res, e); }
});

// Reabertura (RN-007 §"reabertura não altera a alta anterior"). Restrito
// a owner|admin (decisão gerencial + PIN do prof).
router.post("/care-episodes/:id/reopen", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const episode = ClinicCareEpisodeService.reopen(orgId, req.params.id, req.body || {}, actor(req) ?? null);
    res.json({ episode });
  } catch (e: any) { episodeError(res, e); }
});

router.post("/care-episodes/:id/cancel", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const episode = ClinicCareEpisodeService.cancel(orgId, req.params.id, req.body || {}, actor(req) ?? null);
    res.json({ episode });
  } catch (e: any) { episodeError(res, e); }
});

// Ciclos de sessões renováveis (ADR-145 D4 / Fatia 38). Reusa episodeError
// pra códigos de negócio consistentes na UI (CYCLE_ALREADY_ACTIVE, etc.).
function cycleError(res: any, e: any) {
  const code = e?.code;
  const status = code === "CYCLE_ALREADY_ACTIVE" ? 409
              : code === "CYCLE_NOT_RENEWABLE" ? 409
              : code === "CYCLE_NOT_CANCELLABLE" ? 409
              : code === "CYCLE_NOT_PENDING_AUTH" ? 409
              : code === "GUIDE_NOT_ACTIVE" ? 409
              : code === "GUIDE_ALREADY_LINKED" ? 409
              : code === "EPISODE_NOT_ACTIVE" ? 409
              : 400;
  res.status(status).json({ error: e.message, code: code || null,
    existingCycleId: e.existingCycleId || undefined });
}

router.get("/care-episodes/:id/cycles", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json({ cycles: ClinicTreatmentCycleService.listByEpisode(orgId, req.params.id) });
});

router.post("/care-episodes/:id/cycles", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const cycle = ClinicTreatmentCycleService.create(orgId, req.params.id, req.body || {}, actor(req) ?? null);
    res.json({ cycle });
  } catch (e: any) { cycleError(res, e); }
});

// renewal-queue vem ANTES de /:id — senão o param captura a string literal
router.get("/treatment-cycles/renewal-queue", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const threshold = req.query.threshold ? Number(req.query.threshold) : undefined;
  res.json({ queue: ClinicTreatmentCycleService.renewalQueue(orgId, { threshold }) });
});

router.get("/treatment-cycles/:id", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const cycle = ClinicTreatmentCycleService.get(orgId, req.params.id);
  if (!cycle) return res.status(404).json({ error: "Ciclo não encontrado." });
  res.json({ cycle, usage: ClinicTreatmentCycleService.usage(orgId, req.params.id) });
});

router.get("/treatment-cycles/:id/usage", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json({ usage: ClinicTreatmentCycleService.usage(orgId, req.params.id) }); }
  catch (e: any) { res.status(404).json({ error: e.message }); }
});

router.post("/treatment-cycles/:id/renew", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const result = ClinicTreatmentCycleService.renew(orgId, req.params.id, req.body || {}, actor(req) ?? null);
    res.json(result);
  } catch (e: any) { cycleError(res, e); }
});

// Guia da recepção (ADR-145 D7, Fatia 44). CRUD + issue com snapshot
// canônico + cancel. Escrita autenticada (recepção prepara), cancel
// restrito a owner|admin (guia emitida cancelada afeta faturamento).
function guideError(res: any, e: any) {
  const code = e?.code;
  const status = code === "GUIDE_NOT_EDITABLE" ? 409
              : code === "GUIDE_NOT_ISSUABLE" ? 409
              : code === "GUIDE_NOT_CANCELLABLE" ? 409
              : 400;
  res.status(status).json({ error: e.message, code: code || null, status: e.status });
}

router.get("/guides", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const contactId = (req.query.contactId as string) || undefined;
  const status = (req.query.status as GuideStatus) || undefined;
  const guideType = (req.query.type as GuideType) || undefined;
  const limit = req.query.limit ? Number(req.query.limit) : undefined;
  res.json({ guides: ClinicGuideService.list(orgId, { contactId, status, guideType, limit }) });
});

router.post("/guides", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const guide = ClinicGuideService.create(orgId, req.body || {}, actor(req) ?? null);
    res.json({ guide });
  } catch (e: any) { guideError(res, e); }
});

// ADR-145 Fase 5 §F48 — Rascunho pré-preenchido (IA operacional).
// GUARDRAIL: NÃO persiste (só sugere). Campos sem fonte vêm
// {missing:true, reason:"..."} — IA nunca inventa TUSS/carteirinha/
// autorização. Recepção revisa e chama POST /guides pra criar.
router.post("/guides/draft", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const draft = ClinicGuideService.draft(orgId, req.body || {});
    res.json({ draft });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

router.get("/guides/:id", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const g = ClinicGuideService.get(orgId, req.params.id);
  if (!g) return res.status(404).json({ error: "Guia não encontrada." });
  res.json({ guide: g });
});

router.patch("/guides/:id", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const guide = ClinicGuideService.update(orgId, req.params.id, req.body || {}, actor(req) ?? null);
    res.json({ guide });
  } catch (e: any) { guideError(res, e); }
});

router.post("/guides/:id/issue", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const guide = ClinicGuideService.issue(orgId, req.params.id, actor(req) ?? null);
    res.json({ guide });
  } catch (e: any) { guideError(res, e); }
});

router.post("/guides/:id/cancel", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const guide = ClinicGuideService.cancel(orgId, req.params.id, req.body || {}, actor(req) ?? null);
    res.json({ guide });
  } catch (e: any) { guideError(res, e); }
});

// PDF autenticado — recepção baixa direto (materializa se ainda não).
router.get("/guides/:id/pdf", async (req: AuthRequest, res): Promise<any> => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const { bytes } = await ClinicGuideDeliveryService.materializePdf(orgId, req.params.id);
    const guide = ClinicGuideService.get(orgId, req.params.id);
    const label = guide?.guideType === "referral" ? "encaminhamento"
                : guide?.guideType === "medical_order" ? "pedido-medico"
                : "guia";
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Disposition", `inline; filename="${label}-${guide?.internalNumber || req.params.id.slice(0,8)}.pdf"`);
    res.send(bytes);
  } catch (e: any) { guideError(res, e); }
});

// Envio pelo canal do paciente (recepção clica "Enviar por WhatsApp").
router.post("/guides/:id/send", async (req: AuthRequest, res): Promise<any> => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const delivery = await ClinicGuideDeliveryService.send(orgId, req.params.id, actor(req) ?? null, {
      caption: req.body?.caption,
    });
    res.json({ delivery });
  } catch (e: any) {
    const code = e?.code;
    const status = code === "LGPD_CONSENT_REQUIRED" ? 403
                : code === "LGPD_COMMS_CONSENT_REQUIRED" ? 403
                : code === "GUIDE_NOT_SENDABLE" ? 409
                : 400;
    res.status(status).json({ error: e.message, code: code || null });
  }
});

// Histórico de envios pra guia
router.get("/guides/:id/deliveries", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json({ deliveries: ClinicGuideDeliveryService.list(orgId, req.params.id) });
});

// Sessões de agenda compartilhadas (ADR-145 D6, Fatia 41). Habilita
// grupo como primeira classe. Escrita autenticada (recepção monta grupo);
// cancelamento coletivo requer owner|admin (impacto múltiplo).
function sessionError(res: any, e: any) {
  const code = e?.code;
  const status = code === "SESSION_CAPACITY_REACHED" ? 409
              : code === "SESSION_NOT_ACCEPTING" ? 409
              : code === "SESSION_SPECIALTY_MISMATCH" ? 400
              : code === "PARTICIPANT_ALREADY_IN_SESSION" ? 409
              : code === "PROFESSIONAL_NOT_IN_SPECIALTY" ? 400
              : code === "EPISODE_NOT_ACTIVE" ? 409
              : 400;
  res.status(status).json({ error: e.message, code: code || null,
    current: e.current, capacity: e.capacity, appointmentId: e.appointmentId });
}

router.get("/schedule-sessions", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const date = String(req.query.date || "");
  const professionalId = String(req.query.professionalId || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !professionalId) {
    return res.status(400).json({ error: "date (YYYY-MM-DD) e professionalId são obrigatórios." });
  }
  res.json({ sessions: ClinicScheduleSessionService.listByProfessionalDay(orgId, professionalId, date) });
});

// ADR-145 Fase 5 §F47 — IA operacional (sugestão de horários).
// GUARDRAIL: só devolve horário livre do PRÓPRIO profissional (não sugere
// outro; não inventa dado clínico). Determinístico — mesmos inputs, mesmo
// resultado. Vem ANTES de /:id senão o param captura "availability".
router.get("/schedule-sessions/availability", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const professionalId = String(req.query.professionalId || "");
    const durationMinutes = Number(req.query.durationMinutes) || 0;
    const from = String(req.query.from || "");
    const to = String(req.query.to || "");
    const roomId = req.query.roomId ? String(req.query.roomId) : null;
    const maxSuggestions = req.query.maxSuggestions ? Number(req.query.maxSuggestions) : undefined;
    const stepMinutes = req.query.stepMinutes ? Number(req.query.stepMinutes) : undefined;
    const suggestions = ClinicScheduleSessionService.availability(orgId, {
      professionalId, durationMinutes, from, to, roomId, maxSuggestions, stepMinutes,
    });
    res.json({ suggestions });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

router.post("/schedule-sessions", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const session = ClinicScheduleSessionService.create(orgId, req.body || {}, actor(req) ?? null);
    res.json({ session });
  } catch (e: any) { sessionError(res, e); }
});

router.get("/schedule-sessions/:id", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const session = ClinicScheduleSessionService.get(orgId, req.params.id);
  if (!session) return res.status(404).json({ error: "Sessão não encontrada." });
  res.json({
    session,
    participants: ClinicScheduleSessionService.listParticipants(orgId, req.params.id),
  });
});

router.post("/schedule-sessions/:id/participants", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const result = ClinicScheduleSessionService.addParticipant(orgId, req.params.id, req.body || {}, actor(req) ?? null);
    res.json(result);
  } catch (e: any) { sessionError(res, e); }
});

router.delete("/schedule-sessions/:id/participants/:appointmentId", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const result = ClinicScheduleSessionService.removeParticipant(
      orgId, req.params.id, req.params.appointmentId, req.body || {}, actor(req) ?? null
    );
    res.json(result);
  } catch (e: any) { sessionError(res, e); }
});

// Ocupação real do profissional (ADR-145 D6 / Fatia 43 / RN-006):
// grupo de 5 = 1 ocupação, não 5. Dashboard usa isso pra não inflar.
router.get("/schedule-sessions/professionals/:id/occupation", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const from = String(req.query.from || "");
  const to = String(req.query.to || "");
  if (!from || !to) {
    return res.status(400).json({ error: "from e to (ISO) são obrigatórios." });
  }
  res.json({
    occupation: ClinicScheduleSessionService.occupationForProfessional(orgId, req.params.id, { from, to }),
  });
});

router.post("/schedule-sessions/:id/cancel", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const result = ClinicScheduleSessionService.cancelSession(orgId, req.params.id, req.body || {}, actor(req) ?? null);
    res.json(result);
  } catch (e: any) { sessionError(res, e); }
});

// Jornada de Tratamento — métricas + fila operacional + counts pra badge
// (ADR-145 Fatia 40, RF-100 §5). Fecha a Fase 2.
router.get("/care-journey/metrics", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json({
    metrics: ClinicCareJourneyMetricsService.overview(orgId, {
      from: (req.query.from as string) || undefined,
      to: (req.query.to as string) || undefined,
    }),
  });
});

// GET /clinic/care-journey/queue?filter=active-without-schedule|renewal-pending|
//                                       transfers-recent|futures-after-discharge
router.get("/care-journey/queue", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const filter = String(req.query.filter || "") as QueueFilter;
  const allowed: QueueFilter[] = ["active-without-schedule", "renewal-pending", "transfers-recent", "futures-after-discharge"];
  if (!allowed.includes(filter)) {
    return res.status(400).json({
      error: `filter inválido. Aceitos: ${allowed.join(", ")}.`,
    });
  }
  const limit = req.query.limit ? Number(req.query.limit) : undefined;
  res.json({ filter, items: ClinicCareJourneyMetricsService.queue(orgId, filter, { limit }) });
});

// Counts pra badge do sidebar
router.get("/care-journey/counts", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json({ counts: ClinicCareJourneyMetricsService.counts(orgId) });
});

// Fatia 46: amarra guia issued a ciclo pending_authorization → ativa ciclo
router.post("/treatment-cycles/:id/link-guide", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const guideId = String(req.body?.guideId || "");
  if (!guideId) return res.status(400).json({ error: "guideId é obrigatório." });
  try {
    const cycle = ClinicTreatmentCycleService.linkGuide(orgId, req.params.id, guideId, actor(req) ?? null);
    res.json({ cycle });
  } catch (e: any) { cycleError(res, e); }
});

router.post("/treatment-cycles/:id/cancel", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const cycle = ClinicTreatmentCycleService.cancel(orgId, req.params.id, req.body || {}, actor(req) ?? null);
    res.json({ cycle });
  } catch (e: any) { cycleError(res, e); }
});

// ADR-145 Fase 5 §F47 — Detector IA operacional de renovação de ciclos.
// GUARDRAIL: sinaliza no dashboard; NÃO renova, NÃO troca profissional,
// NÃO dá alta, NÃO emite guia. Publica em business_signals (idempotente).
router.post("/renewal-tasks/run", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const threshold = req.body?.threshold != null ? Number(req.body.threshold) : undefined;
    const result = ClinicRenewalTaskService.run(orgId, { threshold });
    res.json({ result });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

router.get("/renewal-tasks", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const includeResolved = String(req.query.includeResolved || "") === "1";
  res.json({ signals: ClinicRenewalTaskService.list(orgId, { includeResolved }) });
});

// Catálogo CID-10 (ADR-080 Fase 23). Busca por prefixo de código ou
// substring da descrição. Catálogo é GLOBAL (padrão OMS/DATASUS), não
// depende de orgId — mas exige usuário autenticado, isolando de bots.
router.get("/cid10/search", (req: AuthRequest, res): any => {
  if (!req.organizationId) return res.status(401).json({ error: "Unauthorized" });
  const q = typeof req.query.q === "string" ? req.query.q : "";
  const limit = req.query.limit ? Number(req.query.limit) : 20;
  res.json(Cid10Service.search(q, limit));
});
router.get("/cid10/:code", (req: AuthRequest, res): any => {
  if (!req.organizationId) return res.status(401).json({ error: "Unauthorized" });
  const found = Cid10Service.get(req.params.code);
  if (!found) return res.status(404).json({ error: "CID não encontrado no catálogo." });
  res.json(found);
});

// Atestado
router.post("/encounters/:id/certificates", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(ClinicDocumentsService.createCertificate(orgId, req.params.id, req.body || {}, actor(req))); }
  catch (e: any) { docError(res, e); }
});
router.patch("/certificates/:id", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(ClinicDocumentsService.updateCertificate(orgId, req.params.id, actor(req), req.body || {})); }
  catch (e: any) { docError(res, e); }
});
// Fase 18: mesmo racional de prescriptions — emissão restrita a owner/admin.
router.post("/certificates/:id/issue", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(ClinicDocumentsService.issueCertificate(orgId, req.params.id, actor(req), { pin: req.body?.pin })); }
  catch (e: any) { docError(res, e); }
});
router.get("/certificates/:id/pdf", async (req: AuthRequest, res): Promise<any> => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const pdf = await ClinicDocumentsService.renderCertificatePdf(orgId, req.params.id);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Disposition", `attachment; filename="atestado-${req.params.id}.pdf"`);
    return res.send(pdf);
  } catch (e: any) {
    if (e?.code === "LGPD_CONSENT_REQUIRED") return res.status(403).json({ error: e.message, code: e.code });
    res.status(400).json({ error: e.message });
  }
});

// Recibo particular (ADR-080 Fase 27). Ciclo draft → issued imutável.
// Valor sempre em CENTAVOS (INTEGER). LGPD sensível obrigatório
// (recibo diz que CPF X pagou consulta médica). PIN opcional (reusa
// verifyPin da Fase T) — issue restrita a owner/admin (mesmo racional
// de prescriptions da Fase 18: sem PIN configurado, verifyPin degrada
// pra false; RBAC fecha o vetor).
router.get("/encounters/:id/receipts", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(ClinicReceiptService.listByEncounter(orgId, req.params.id)); }
  catch (e: any) {
    if (e?.code === "LGPD_CONSENT_REQUIRED") return res.status(403).json({ error: e.message, code: e.code });
    res.status(400).json({ error: e.message });
  }
});
router.post("/encounters/:id/receipts", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(ClinicReceiptService.create(orgId, req.params.id, req.body || {}, actor(req))); }
  catch (e: any) { docError(res, e); }
});
router.patch("/receipts/:id", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(ClinicReceiptService.update(orgId, req.params.id, actor(req), req.body || {})); }
  catch (e: any) { docError(res, e); }
});
router.post("/receipts/:id/issue", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(ClinicReceiptService.issue(orgId, req.params.id, actor(req), { pin: req.body?.pin })); }
  catch (e: any) { docError(res, e); }
});
router.get("/receipts/:id/pdf", async (req: AuthRequest, res): Promise<any> => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const pdf = await ClinicReceiptService.renderPdf(orgId, req.params.id);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Disposition", `attachment; filename="recibo-${req.params.id}.pdf"`);
    return res.send(pdf);
  } catch (e: any) {
    if (e?.code === "LGPD_CONSENT_REQUIRED") return res.status(403).json({ error: e.message, code: e.code });
    res.status(400).json({ error: e.message });
  }
});

// ── Envio de docs por WhatsApp (ADR-080 Fase K) ────────────────────────
// Doc precisa estar issued. LGPD sensível + comunicações. Sempre grava
// linha em clinical_document_deliveries mesmo em falha (auditoria).
const deliveryError = (res: any, e: any) => {
  if (e?.code === "LGPD_CONSENT_REQUIRED" || e?.code === "LGPD_COMMS_CONSENT_REQUIRED" || e?.code === "DOCUMENT_NOT_ISSUED") {
    return res.status(409).json({ error: e.message, code: e.code });
  }
  return res.status(400).json({ error: e.message });
};

router.post("/prescriptions/:id/send", async (req: AuthRequest, res): Promise<any> => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const delivery = await ClinicDocumentDeliveryService.send(orgId, "prescription", req.params.id, actor(req), { caption: req.body?.caption });
    // Se status=failed, ainda retorna 200 — o histórico foi gravado e a UI
    // trata pelo campo `status` (mostra "falha" e permite reenviar).
    res.json(delivery);
  } catch (e: any) { deliveryError(res, e); }
});

router.post("/certificates/:id/send", async (req: AuthRequest, res): Promise<any> => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const delivery = await ClinicDocumentDeliveryService.send(orgId, "certificate", req.params.id, actor(req), { caption: req.body?.caption });
    res.json(delivery);
  } catch (e: any) { deliveryError(res, e); }
});

router.post("/receipts/:id/send", async (req: AuthRequest, res): Promise<any> => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const delivery = await ClinicDocumentDeliveryService.send(orgId, "receipt", req.params.id, actor(req), { caption: req.body?.caption });
    res.json(delivery);
  } catch (e: any) { deliveryError(res, e); }
});

router.get("/documents/:kind/:id/deliveries", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const k = req.params.kind;
  const kind = k === "certificate" || k === "receipt" ? k : "prescription";
  res.json(ClinicDocumentDeliveryService.list(orgId, kind as any, req.params.id));
});

// ── Anexos do prontuário (ADR-080 Fase J) ──────────────────────────────
// Multipart. Arquivo fica em PRIVATE_MEDIA_DIR (fora do /media estático).
// LGPD Art.11 e bloqueio pós-signed no service.

// Fase 19: gate LGPD SENSITIVE — anexo é dado clínico.
router.get("/encounters/:id/attachments", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(ClinicAttachmentService.list(orgId, req.params.id)); }
  catch (e: any) {
    if (e?.code === "LGPD_CONSENT_REQUIRED") return res.status(403).json({ error: e.message, code: e.code });
    res.status(400).json({ error: e.message });
  }
});

router.post("/encounters/:id/attachments", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  attachmentUpload.single("file")(req, res, (err: any) => {
    if (err) return res.status(400).json({ error: err.message || "Falha no upload." });
    const file = (req as any).file;
    if (!file) return res.status(400).json({ error: "Nenhum arquivo enviado." });
    try {
      const att = ClinicAttachmentService.add(orgId, req.params.id, {
        buffer: file.buffer, mime: file.mimetype,
        originalFilename: file.originalname,
        label: req.body?.label || null,
      }, actor(req));
      res.status(201).json(att);
    } catch (e: any) {
      if (e.code === "LGPD_CONSENT_REQUIRED") return res.status(409).json({ error: e.message, code: e.code });
      res.status(400).json({ error: e.message });
    }
  });
});

router.get("/attachments/:id/download", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    // Fase 32: usa stream (pipe) em vez de ler o buffer inteiro pra memória.
    // Anexos até 15MB * N requests concorrentes = pico de RAM sério; stream
    // corta pra ~64KB por chunk. O service.get() faz o gate LGPD antes.
    const meta = ClinicAttachmentService.get(orgId, req.params.id);
    if (!meta) return res.status(404).json({ error: "Anexo não encontrado." });
    res.setHeader("Content-Type", meta.mimeType);
    // Fase 30: nosniff impede o browser de "adivinhar" o tipo real do
    // arquivo pelo conteúdo (defesa em profundidade contra content-type
    // confusion). O add() já valida magic-byte real.
    res.setHeader("X-Content-Type-Options", "nosniff");
    // Fase 30: sanitiza filename via safeFilename (CRLF/aspas/;/= viram _)
    // e serve tanto `filename=` (fallback ASCII) quanto `filename*=UTF-8''`
    // (moderno, permite acentos) — RFC 6266.
    const clean = safeFilename(meta.originalFilename || meta.storageKey);
    const encoded = encodeURIComponent(clean);
    const disposition = meta.mimeType.startsWith("image/") ? "inline" : "attachment";
    res.setHeader(
      "Content-Disposition",
      `${disposition}; filename="${clean}"; filename*=UTF-8''${encoded}`
    );
    // Stream do disco privado direto pro cliente
    const fs = require("node:fs");
    const path = require("node:path");
    const { PRIVATE_CLINICAL_DIR } = require("../ClinicAttachmentService.js");
    const filePath = path.join(PRIVATE_CLINICAL_DIR, meta.organizationId, meta.encounterId, meta.storageKey);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: "Arquivo do anexo não está mais disponível." });
    const stream = fs.createReadStream(filePath);
    stream.on("error", () => { try { res.end(); } catch { /* noop */ } });
    stream.pipe(res);
  } catch (e: any) {
    // Fase 19: consent revogado → 403 (não confundir com 404 "não encontrado").
    if (e?.code === "LGPD_CONSENT_REQUIRED") return res.status(403).json({ error: e.message, code: e.code });
    res.status(404).json({ error: e.message });
  }
});

// Compartilhar/desmarcar anexo com o Portal do Paciente (ADR-080 Fase L).
router.patch("/attachments/:id/share", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const share = !!req.body?.share;
    res.json(ClinicAttachmentService.setSharedWithPatient(orgId, req.params.id, share, actor(req)));
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.delete("/attachments/:id", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    ClinicAttachmentService.remove(orgId, req.params.id, actor(req));
    res.json({ ok: true });
  } catch (e: any) {
    if (e.code === "ATTACHMENT_FROZEN" || e.code === "LGPD_CONSENT_REQUIRED") return res.status(409).json({ error: e.message, code: e.code });
    res.status(400).json({ error: e.message });
  }
});

// ── Dashboard / insights (ADR-080 Fase O) ───────────────────────────────
router.get("/metrics", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(ClinicMetricsService.overview(orgId, { from: req.query.from as string, to: req.query.to as string })); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

// ── Relatório mensal em PDF (ADR-080 Fase 17) ───────────────────────────
// GET /api/clinic/reports/monthly.pdf?month=YYYY-MM  (default: mês anterior).
// Restrito a owner/admin — relatório expõe agregados sensíveis do negócio.
router.get("/reports/monthly.pdf", requireRole("owner", "admin"), async (req: AuthRequest, res): Promise<any> => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const payload = ClinicMonthlyReportService.buildPayload(orgId, (req.query.month as string) || null);
    const pdf = await ClinicMonthlyReportService.renderPdfFromPayload(payload);
    logAuthEvent(orgId, actor(req) ?? null, null, "CLINIC_MONTHLY_REPORT_GENERATED", {
      month: payload.month,
      totalAppointments: payload.metrics.appointments.total,
      recoveredMinutes: payload.metrics.automations.vacancy.recoveredMinutes,
    });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Disposition", `inline; filename="relatorio-mensal-${payload.month}.pdf"`);
    res.send(pdf);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// ── Envio automático do relatório mensal (ADR-080 Fase 33) ─────────────
// Configuração + histórico + re-envio manual. `enabled` default 0 (opt-in
// estrito): envio automático de PDF financeiro exige decisão consciente do
// gestor. `day` limitado a 1..28 (evita 30/31 em fev). `recipientContactId`
// aponta pra um contato da org (owner/sócio/contador) — a mensagem sai pelo
// canal WhatsApp desse contato (ou fallback pro 1º canal ativo).
router.get("/settings/monthly-report", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const r = db.prepare(
    `SELECT clinic_monthly_report_enabled AS en,
            clinic_monthly_report_day AS day,
            clinic_monthly_report_recipient_contact_id AS recipient
       FROM organization_settings WHERE organization_id = ?`
  ).get(orgId) as any;
  res.json({
    enabled: r != null && Number(r.en) === 1,
    day: r?.day != null ? Number(r.day) : 5,
    recipientContactId: r?.recipient || null,
  });
});

router.put("/settings/monthly-report", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const patches: string[] = [];
  const params: any[] = [];
  if (req.body?.enabled !== undefined) {
    patches.push("clinic_monthly_report_enabled = ?");
    params.push(req.body.enabled === true || req.body.enabled === 1 ? 1 : 0);
  }
  if (req.body?.day !== undefined) {
    const n = Math.floor(Number(req.body.day));
    if (!Number.isFinite(n) || n < 1 || n > 28) {
      return res.status(400).json({ error: "day deve estar entre 1 e 28." });
    }
    patches.push("clinic_monthly_report_day = ?");
    params.push(n);
  }
  if (req.body?.recipientContactId !== undefined) {
    const rc = req.body.recipientContactId;
    if (rc !== null && rc !== "") {
      const exists = db.prepare(`SELECT 1 FROM contacts WHERE id = ? AND organization_id = ?`).get(rc, orgId);
      if (!exists) return res.status(400).json({ error: "Destinatário não encontrado." });
    }
    patches.push("clinic_monthly_report_recipient_contact_id = ?");
    params.push(rc || null);
  }
  if (patches.length) {
    db.prepare(`UPDATE organization_settings SET ${patches.join(", ")} WHERE organization_id = ?`).run(...params, orgId);
    logAuthEvent(orgId, actor(req) ?? null, null, "CLINIC_MONTHLY_REPORT_CONFIG_UPDATED", {
      changes: Object.keys(req.body || {}),
    });
  }
  const r = db.prepare(
    `SELECT clinic_monthly_report_enabled AS en,
            clinic_monthly_report_day AS day,
            clinic_monthly_report_recipient_contact_id AS recipient
       FROM organization_settings WHERE organization_id = ?`
  ).get(orgId) as any;
  res.json({
    enabled: r != null && Number(r.en) === 1,
    day: r?.day != null ? Number(r.day) : 5,
    recipientContactId: r?.recipient || null,
  });
});

// GET /clinic/monthly-report-deliveries?month=YYYY-MM&limit=N  → histórico
router.get("/monthly-report-deliveries", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const month = req.query.month ? String(req.query.month) : undefined;
  const limit = req.query.limit ? Number(req.query.limit) : undefined;
  res.json({ deliveries: ClinicMonthlyReportDeliveryService.list(orgId, { month, limit }) });
});

// POST /clinic/monthly-report/send-now  { month?, force? }  → re-envio manual
router.post("/monthly-report/send-now", requireRole("owner", "admin"), async (req: AuthRequest, res): Promise<any> => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const delivery = await ClinicMonthlyReportDeliveryService.sendForMonth(
      orgId,
      req.body?.month || null,
      { actorId: actor(req) ?? null, force: req.body?.force === true }
    );
    if (!delivery) return res.status(400).json({ error: "Não foi possível preparar o envio." });
    res.json({ delivery });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// ── Retenção LGPD (ADR-080 Fase U) ──────────────────────────────────────
// Fase 32: rota agregada — aba "Configurações" no front carrega todas as
// configs do módulo Clínica em 1 request só (evita 5 requests em cascata
// quando a tela abre). Cada campo já tem endpoint dedicado pra escrita
// (PUT /settings/{retention,reminders,addendum-notification,followup-notification}),
// então esta rota é read-only agregado. Timezone/businessName vêm do
// organization_settings core (não são específicos de clínica mas o front
// da aba precisa mostrar).
router.get("/settings", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const o = db.prepare(
    `SELECT business_name,
            clinic_retention_enabled, clinic_retention_days_deliveries, clinic_retention_days_attachments,
            clinic_reminder_hours, clinic_second_reminder_enabled, clinic_second_reminder_hours,
            clinic_addendum_notification_enabled,
            clinic_followup_notification_enabled, clinic_followup_notification_lead_days,
            clinic_receipt_business_document, clinic_receipt_business_document_type,
            clinic_monthly_report_enabled, clinic_monthly_report_day, clinic_monthly_report_recipient_contact_id
       FROM organization_settings WHERE organization_id = ?`
  ).get(orgId) as any;
  res.json({
    businessName: o?.business_name || null,
    timezone: "America/Sao_Paulo", // fixo por ora — não temos coluna dedicada em organization_settings
    retention: {
      enabled: o?.clinic_retention_enabled !== 0,
      deliveryDays: Number(o?.clinic_retention_days_deliveries) || 30,
      attachmentDays: Number(o?.clinic_retention_days_attachments) || 730,
    },
    reminders: {
      hoursBefore: Number(o?.clinic_reminder_hours) || 24,
      secondEnabled: o?.clinic_second_reminder_enabled !== 0,
      secondHoursBefore: Number(o?.clinic_second_reminder_hours) || 2,
    },
    addendumNotification: {
      enabled: o == null || o.clinic_addendum_notification_enabled == null || Number(o.clinic_addendum_notification_enabled) !== 0,
    },
    followupNotification: {
      enabled: o == null || o.clinic_followup_notification_enabled == null || Number(o.clinic_followup_notification_enabled) !== 0,
      leadDays: o?.clinic_followup_notification_lead_days != null ? Number(o.clinic_followup_notification_lead_days) : 3,
    },
    receipt: {
      businessDocument: o?.clinic_receipt_business_document || null,
      businessDocumentType: o?.clinic_receipt_business_document_type || null,
    },
    monthlyReport: {
      enabled: o != null && Number(o.clinic_monthly_report_enabled) === 1,
      day: o?.clinic_monthly_report_day != null ? Number(o.clinic_monthly_report_day) : 5,
      recipientContactId: o?.clinic_monthly_report_recipient_contact_id || null,
    },
  });
});

router.get("/settings/retention", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const o = db.prepare(`SELECT clinic_retention_enabled, clinic_retention_days_deliveries, clinic_retention_days_attachments FROM organization_settings WHERE organization_id = ?`).get(orgId) as any;
  res.json({
    enabled: o?.clinic_retention_enabled !== 0,
    deliveryDays: Number(o?.clinic_retention_days_deliveries) || 30,
    attachmentDays: Number(o?.clinic_retention_days_attachments) || 730,
  });
});
router.put("/settings/retention", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const body = req.body || {};
  const patches: string[] = []; const values: any[] = [];
  if (body.enabled !== undefined) { patches.push("clinic_retention_enabled = ?"); values.push(body.enabled ? 1 : 0); }
  if (body.deliveryDays !== undefined) {
    const d = Math.max(7, Math.min(3650, Math.floor(Number(body.deliveryDays))));
    if (!Number.isFinite(d)) return res.status(400).json({ error: "deliveryDays inválido (7..3650)." });
    patches.push("clinic_retention_days_deliveries = ?"); values.push(d);
  }
  if (body.attachmentDays !== undefined) {
    const d = Math.max(7, Math.min(7300, Math.floor(Number(body.attachmentDays)))); // até 20 anos
    if (!Number.isFinite(d)) return res.status(400).json({ error: "attachmentDays inválido (7..7300)." });
    patches.push("clinic_retention_days_attachments = ?"); values.push(d);
  }
  if (!patches.length) return res.status(400).json({ error: "Nenhum campo pra atualizar." });
  db.prepare(`UPDATE organization_settings SET ${patches.join(", ")} WHERE organization_id = ?`).run(...values, orgId);
  const o = db.prepare(`SELECT clinic_retention_enabled, clinic_retention_days_deliveries, clinic_retention_days_attachments FROM organization_settings WHERE organization_id = ?`).get(orgId) as any;
  res.json({
    enabled: o?.clinic_retention_enabled !== 0,
    deliveryDays: Number(o?.clinic_retention_days_deliveries) || 30,
    attachmentDays: Number(o?.clinic_retention_days_attachments) || 730,
  });
});
// Rodar manualmente (útil pra debug ou "limpar agora" pelo gestor)
router.post("/settings/retention/run", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json(ClinicRetentionService.runForOrg(orgId));
});

// ── Automações WhatsApp — visibilidade das vagas (ADR-080 Fase R) ──────
router.get("/vacancies", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 20));
  res.json(ClinicVacancyService.recent(orgId, limit));
});
// Fase 31: contagem-só de ofertas de vaga pending pra badge do menu
// ("Vagas oferecidas (3)"). SELECT direto — o service.recent() já hidrata
// nomes, o que é caro pro caso do badge.
router.get("/vacancies/pending-count", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const r = db.prepare(
    `SELECT COUNT(*) AS c FROM clinical_vacancy_offers
      WHERE organization_id = ? AND status = 'pending'`
  ).get(orgId) as any;
  res.json({ count: Number(r?.c || 0) });
});

// ── Lembretes automáticos (ADR-080 Fase M) ──────────────────────────────
router.get("/appointments/:id/reminders", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json(ClinicReminderService.list(orgId, req.params.id));
});

router.post("/appointments/:id/remind", async (req: AuthRequest, res): Promise<any> => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const r = await ClinicReminderService.sendForAppointment(orgId, req.params.id, {
      actorId: actor(req),
      force: !!req.body?.force,
    });
    if (!r) return res.status(202).json({ status: "skipped", reason: "no_active_channel" });
    res.json(r);
  } catch (e: any) {
    if (e.code === "LGPD_COMMS_CONSENT_REQUIRED" || e.code === "APPT_NOT_ACTIVE") return res.status(409).json({ error: e.message, code: e.code });
    res.status(400).json({ error: e.message });
  }
});

router.get("/settings/reminders", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const o = db.prepare(`SELECT clinic_reminder_hours, clinic_second_reminder_hours, clinic_second_reminder_enabled FROM organization_settings WHERE organization_id = ?`).get(orgId) as any;
  res.json({
    hoursBefore: Number(o?.clinic_reminder_hours) || 24,
    secondHoursBefore: Number(o?.clinic_second_reminder_hours) || 2,
    secondEnabled: o?.clinic_second_reminder_enabled !== 0,
  });
});

router.put("/settings/reminders", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const body = req.body || {};
  const patches: string[] = [];
  const values: any[] = [];
  if (body.hoursBefore !== undefined) {
    const h = Math.max(1, Math.min(168, Math.floor(Number(body.hoursBefore))));
    if (!Number.isFinite(h) || h < 1) return res.status(400).json({ error: "hoursBefore inválido (1..168)." });
    patches.push("clinic_reminder_hours = ?"); values.push(h);
  }
  if (body.secondHoursBefore !== undefined) {
    const h2 = Math.max(1, Math.min(12, Math.floor(Number(body.secondHoursBefore))));
    if (!Number.isFinite(h2)) return res.status(400).json({ error: "secondHoursBefore inválido (1..12)." });
    patches.push("clinic_second_reminder_hours = ?"); values.push(h2);
  }
  if (body.secondEnabled !== undefined) {
    patches.push("clinic_second_reminder_enabled = ?"); values.push(body.secondEnabled ? 1 : 0);
  }
  if (patches.length === 0) return res.status(400).json({ error: "Nenhum campo pra atualizar." });
  db.prepare(`UPDATE organization_settings SET ${patches.join(", ")} WHERE organization_id = ?`).run(...values, orgId);
  const o = db.prepare(`SELECT clinic_reminder_hours, clinic_second_reminder_hours, clinic_second_reminder_enabled FROM organization_settings WHERE organization_id = ?`).get(orgId) as any;
  res.json({
    hoursBefore: Number(o?.clinic_reminder_hours) || 24,
    secondHoursBefore: Number(o?.clinic_second_reminder_hours) || 2,
    secondEnabled: o?.clinic_second_reminder_enabled !== 0,
  });
});

// ── Portal do Paciente — gestão (ADR-080 Fase L) ────────────────────────
// Só gera token se LGPD sensível + comunicações concedidos. Link é o
// que o gestor manda pro paciente (WhatsApp/e-mail); a rota pública que
// consome o token vive em `clinicPublic.ts`.
// Fase 18: gerar link do portal expõe TODAS as receitas/atestados emitidos e
// anexos compartilhados do paciente. Restrito a owner/admin — um agent
// malicioso podia gerar, copiar o token cru e sair antes de qualquer revoke.
router.post("/patients/:contactId/portal-tokens", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const t = ClinicPatientPortalService.generateToken(orgId, req.params.contactId, actor(req), { ttlDays: req.body?.ttlDays });
    res.json(t);
  } catch (e: any) {
    if (e.code === "LGPD_CONSENT_REQUIRED" || e.code === "LGPD_COMMS_CONSENT_REQUIRED") return res.status(409).json({ error: e.message, code: e.code });
    res.status(400).json({ error: e.message });
  }
});

router.get("/patients/:contactId/portal-tokens", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json(ClinicPatientPortalService.listTokens(orgId, req.params.contactId));
});

// Fase 18: par com a rota de generate — só quem gera pode revogar.
router.delete("/patients/portal-tokens/:tokenId", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const ok = ClinicPatientPortalService.revokeToken(orgId, req.params.tokenId, actor(req));
  if (!ok) return res.status(404).json({ error: "Token não encontrado." });
  res.json({ ok: true });
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

// ─────────────── Ficha do PET + carteira de vacinação (Petshop F3) ───────────────

// GET /api/clinic/pets?tutor=<contactId> — pets de um tutor (default só ativos).
router.get("/pets", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const tutor = String(req.query?.tutor || "");
  if (!tutor) return res.status(400).json({ error: "tutor (contactId) é obrigatório." });
  res.json({ pets: ClinicPetService.listByTutor(orgId, tutor, { includeInactive: req.query?.all === "1" }) });
});

// GET /api/clinic/pets/:id — ficha completa do pet.
router.get("/pets/:id", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const pet = ClinicPetService.get(orgId, String(req.params.id));
  if (!pet) return res.status(404).json({ error: "Pet não encontrado." });
  res.json(pet);
});

// POST /api/clinic/pets — cria um pet (valida o tutor).
router.post("/pets", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(ClinicPetService.create(orgId, req.body || {}, actor(req))); }
  catch (e: any) { res.status(400).json({ error: e?.message || "erro" }); }
});

// PUT /api/clinic/pets/:id — atualiza ficha (patch) / muda status.
router.put("/pets/:id", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(ClinicPetService.update(orgId, String(req.params.id), req.body || {}, actor(req))); }
  catch (e: any) { res.status(400).json({ error: e?.message || "erro" }); }
});

// GET /api/clinic/pets/:id/history — histórico de saúde consolidado (Petshop F6).
router.get("/pets/:id/history", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json({ history: ClinicPetHistoryService.history(orgId, String(req.params.id)) });
});

// GET /api/clinic/pets/:id/vaccinations — carteira de vacinação do pet.
router.get("/pets/:id/vaccinations", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json({ vaccinations: ClinicPetService.listVaccinations(orgId, String(req.params.id)) });
});

// POST /api/clinic/pets/:id/vaccinations — registra uma dose.
router.post("/pets/:id/vaccinations", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(ClinicPetService.addVaccination(orgId, String(req.params.id), req.body || {}, actor(req))); }
  catch (e: any) { res.status(400).json({ error: e?.message || "erro" }); }
});

// GET /api/clinic/pets-vaccinations/due?withinDays= — doses vencidas/a vencer (gestor).
router.get("/pets-vaccinations/due", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const withinDays = typeof req.query?.withinDays === "string" ? Number(req.query.withinDays) : undefined;
  res.json({ due: ClinicPetService.dueVaccinations(orgId, { withinDays }) });
});

// ─────────────── Banho & Tosa / grooming (Petshop F4) ───────────────

// GET /api/clinic/grooming-services — catálogo de serviços de grooming.
router.get("/grooming-services", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json({ services: ClinicGroomingService.listServices(orgId, { includeInactive: req.query?.all === "1" }) });
});

// POST /api/clinic/grooming-services — cria serviço (gestor).
router.post("/grooming-services", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(ClinicGroomingService.createService(orgId, req.body || {}, actor(req))); }
  catch (e: any) { res.status(400).json({ error: e?.message || "erro" }); }
});

// PUT /api/clinic/grooming-services/:id — edita/ativa/desativa serviço (gestor).
router.put("/grooming-services/:id", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(ClinicGroomingService.updateService(orgId, String(req.params.id), req.body || {}, actor(req))); }
  catch (e: any) { res.status(400).json({ error: e?.message || "erro" }); }
});

// POST /api/clinic/grooming/book — agenda um banho & tosa (pet + serviço).
router.post("/grooming/book", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(ClinicGroomingService.book(orgId, req.body || {}, actor(req))); }
  catch (e: any) { res.status(400).json({ error: e?.message || "erro", code: e?.code }); }
});

// GET /api/clinic/grooming/queue?date=YYYY-MM-DD — fila do dia de banho & tosa.
router.get("/grooming/queue", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json({ queue: ClinicGroomingService.dayQueue(orgId, String(req.query?.date || "")) });
});

// ─────────── Plano de saúde + internação + cirurgia do pet (Petshop F5) ───────────

// PUT /api/clinic/pets/:id/health-plan { name, status } — define o plano do pet.
router.put("/pets/:id/health-plan", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(ClinicPetCareService.setHealthPlan(orgId, String(req.params.id), req.body || {}, actor(req))); }
  catch (e: any) { res.status(400).json({ error: e?.message || "erro" }); }
});

// Internação
router.get("/pets/:id/hospitalizations", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json({ hospitalizations: ClinicPetCareService.listHospitalizations(orgId, String(req.params.id)) });
});
router.post("/pets/:id/hospitalizations", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(ClinicPetCareService.admit(orgId, String(req.params.id), req.body || {}, actor(req))); }
  catch (e: any) { res.status(400).json({ error: e?.message || "erro" }); }
});
router.post("/hospitalizations/:hid/discharge", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(ClinicPetCareService.discharge(orgId, String(req.params.hid), req.body || {}, actor(req))); }
  catch (e: any) { res.status(400).json({ error: e?.message || "erro" }); }
});
router.get("/hospitalizations/active", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json({ active: ClinicPetCareService.activeHospitalizations(orgId) });
});

// Cirurgia + checklist
router.get("/pets/:id/surgeries", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json({ surgeries: ClinicPetCareService.listSurgeries(orgId, String(req.params.id)) });
});
router.post("/pets/:id/surgeries", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(ClinicPetCareService.scheduleSurgery(orgId, String(req.params.id), req.body || {}, actor(req))); }
  catch (e: any) { res.status(400).json({ error: e?.message || "erro" }); }
});
router.put("/surgeries/:sid/checklist", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const b = req.body || {};
  try { res.json(ClinicPetCareService.setChecklistItem(orgId, String(req.params.sid), Number(b.index), !!b.done, actor(req))); }
  catch (e: any) { res.status(400).json({ error: e?.message || "erro" }); }
});
router.post("/surgeries/:sid/status", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(ClinicPetCareService.setSurgeryStatus(orgId, String(req.params.sid), req.body?.status, actor(req))); }
  catch (e: any) { res.status(400).json({ error: e?.message || "erro" }); }
});

// ── ADR-180 F1 — Professional Network & Agenda Federada ──
// Opt-in SERVER-SIDE (RN-PN-8): a flag é imposta no CAMINHO real, não só na UI.
// Sem a flag, as rotas recusam 403 antes de qualquer efeito.
//
// F4b — settings das flags (NÃO gated: é o ponto de LIGAR a rede; senão nunca
// seria possível ativá-la). owner/admin. As rotas de operação seguem gated.
router.get("/professional-network/settings", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json(ProfessionalNetworkSettingsService.get(orgId));
});
router.put("/professional-network/settings", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(ProfessionalNetworkSettingsService.set(orgId, req.body || {})); }
  catch (e: any) { res.status(400).json({ error: e?.message || "erro" }); }
});

function professionalNetworkEnabled(orgId: string): boolean {
  const row = db.prepare(`SELECT professional_network_enabled AS on FROM organization_settings WHERE organization_id = ?`).get(orgId) as any;
  return !!(row && row.on);
}
// 2ª flag opt-in (RN-PN-8): AutoBooking (agendar automático governado) exige habilitação
// SEPARADA da rede. Rede pode estar ligada (busca/hold/confirm manual) sem AutoBooking.
function autobookingEnabled(orgId: string): boolean {
  const row = db.prepare(`SELECT autobooking_enabled AS on FROM organization_settings WHERE organization_id = ?`).get(orgId) as any;
  return !!(row && row.on);
}
const gatePN = (req: AuthRequest, res: any): string | null => {
  const orgId = req.organizationId;
  if (!orgId) { res.status(401).json({ error: "Unauthorized" }); return null; }
  if (!professionalNetworkEnabled(orgId)) { res.status(403).json({ error: "professional_network_disabled" }); return null; }
  return orgId;
};

// Busca de identidade global (para o fluxo de convite).
router.get("/professional-network/professionals/search", (req: AuthRequest, res): any => {
  const orgId = gatePN(req, res); if (!orgId) return;
  try { res.json(ProfessionalService.search(req.query.q as string, Number(req.query.limit) || 20)); }
  catch (e: any) { res.status(400).json({ error: e?.message || "erro" }); }
});
// Lookup pela chave natural (conselho + registro) — evita duplicar identidade.
router.get("/professional-network/professionals/by-registration", (req: AuthRequest, res): any => {
  const orgId = gatePN(req, res); if (!orgId) return;
  const p = ProfessionalService.findByRegistration(req.query.council as string, req.query.registration as string);
  res.json(p);
});
// Relações da org (o "meus profissionais" da rede).
router.get("/professional-network/relationships", (req: AuthRequest, res): any => {
  const orgId = gatePN(req, res); if (!orgId) return;
  res.json(ClinicProfessionalRelationshipService.list(orgId, { status: req.query.status as string }));
});
router.get("/professional-network/relationships/:id", (req: AuthRequest, res): any => {
  const orgId = gatePN(req, res); if (!orgId) return;
  const rel = ClinicProfessionalRelationshipService.get(orgId, String(req.params.id));
  if (!rel) return res.status(404).json({ error: "not_found" });
  res.json(rel);
});
// Convidar (por professionalId existente OU criando identidade global). owner/admin.
router.post("/professional-network/relationships", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = gatePN(req, res); if (!orgId) return;
  try { res.json(ClinicProfessionalRelationshipService.invite(orgId, req.body || {}, actor(req))); }
  catch (e: any) { res.status(400).json({ error: e?.message || "erro" }); }
});
router.post("/professional-network/relationships/:id/accept", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = gatePN(req, res); if (!orgId) return;
  try { res.json(ClinicProfessionalRelationshipService.accept(orgId, String(req.params.id), actor(req))); }
  catch (e: any) { res.status(400).json({ error: e?.message || "erro" }); }
});
router.post("/professional-network/relationships/:id/revoke", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = gatePN(req, res); if (!orgId) return;
  try { res.json(ClinicProfessionalRelationshipService.revoke(orgId, String(req.params.id), actor(req))); }
  catch (e: any) { res.status(400).json({ error: e?.message || "erro" }); }
});
router.put("/professional-network/relationships/:id/permissions", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = gatePN(req, res); if (!orgId) return;
  try { res.json(ClinicProfessionalRelationshipService.setPermissions(orgId, String(req.params.id), req.body || {}, actor(req))); }
  catch (e: any) { res.status(400).json({ error: e?.message || "erro" }); }
});

// F2 — serviços ofertados + janelas de disponibilidade (config do vínculo).
router.get("/professional-network/relationships/:id/offerings", (req: AuthRequest, res): any => {
  const orgId = gatePN(req, res); if (!orgId) return;
  try { res.json(ProfessionalScheduleConfigService.listOfferings(orgId, String(req.params.id), { includeInactive: req.query.all === "1" })); }
  catch (e: any) { res.status(400).json({ error: e?.message || "erro" }); }
});
router.post("/professional-network/relationships/:id/offerings", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = gatePN(req, res); if (!orgId) return;
  try { res.json(ProfessionalScheduleConfigService.setOffering(orgId, String(req.params.id), req.body || {}, actor(req))); }
  catch (e: any) { res.status(400).json({ error: e?.message || "erro" }); }
});
router.delete("/professional-network/offerings/:offeringId", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = gatePN(req, res); if (!orgId) return;
  try { res.json(ProfessionalScheduleConfigService.removeOffering(orgId, String(req.params.offeringId), actor(req))); }
  catch (e: any) { res.status(400).json({ error: e?.message || "erro" }); }
});
router.get("/professional-network/relationships/:id/windows", (req: AuthRequest, res): any => {
  const orgId = gatePN(req, res); if (!orgId) return;
  try { res.json(ProfessionalScheduleConfigService.listWindows(orgId, String(req.params.id))); }
  catch (e: any) { res.status(400).json({ error: e?.message || "erro" }); }
});
router.put("/professional-network/relationships/:id/windows", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = gatePN(req, res); if (!orgId) return;
  try { res.json(ProfessionalScheduleConfigService.setWindows(orgId, String(req.params.id), Array.isArray(req.body?.windows) ? req.body.windows : req.body, actor(req))); }
  catch (e: any) { res.status(400).json({ error: e?.message || "erro" }); }
});

// F3 — Availability Engine + hold atômico + confirm.
router.get("/professional-network/relationships/:id/availability", async (req: AuthRequest, res): Promise<any> => {
  const orgId = gatePN(req, res); if (!orgId) return;
  try {
    // F6.2 — getAvailability (async) subtrai o Google busy do profissional além de holds+appointments.
    res.json(await ProfessionalBookingService.getAvailability(orgId, String(req.params.id), String(req.query.date || ""), {
      serviceId: req.query.serviceId as string,
      slotMinutes: req.query.slotMinutes ? Number(req.query.slotMinutes) : undefined,
    }));
  } catch (e: any) { res.status(400).json({ error: e?.message || "erro" }); }
});
router.post("/professional-network/relationships/:id/holds", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = gatePN(req, res); if (!orgId) return;
  try { res.json(ProfessionalAvailabilityService.hold(orgId, String(req.params.id), req.body || {}, actor(req))); }
  catch (e: any) { res.status(409).json({ error: e?.message || "erro" }); }
});
router.post("/professional-network/holds/:holdId/confirm", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = gatePN(req, res); if (!orgId) return;
  try { res.json(ProfessionalAvailabilityService.confirm(orgId, String(req.params.holdId), {}, actor(req))); }
  catch (e: any) { res.status(409).json({ error: e?.message || "erro" }); }
});
router.post("/professional-network/holds/:holdId/release", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = gatePN(req, res); if (!orgId) return;
  try { res.json(ProfessionalAvailabilityService.release(orgId, String(req.params.holdId), actor(req))); }
  catch (e: any) { res.status(400).json({ error: e?.message || "erro" }); }
});

// ── F4 — Booking federado + AutoBooking governado ──
// Confirma um hold → cria o agendamento federado (idempotente por hold).
router.post("/professional-network/holds/:holdId/booking", requireRole("owner", "admin"), async (req: AuthRequest, res): Promise<any> => {
  const orgId = gatePN(req, res); if (!orgId) return;
  try {
    const appt = ProfessionalBookingService.confirmBooking(orgId, { holdId: String(req.params.holdId), contactId: req.body?.contactId, petId: req.body?.petId ?? null, title: req.body?.title ?? null }, actor(req));
    await ProfessionalBookingService.pushToGoogle(orgId, appt.id);   // F6.3 — best-effort
    res.json(appt);
  } catch (e: any) { res.status(400).json({ error: e?.message || "erro" }); }
});
// Cancela um atendimento federado (marca cancelled + remove do Google).
router.post("/professional-network/appointments/:id/cancel", requireRole("owner", "admin"), async (req: AuthRequest, res): Promise<any> => {
  const orgId = gatePN(req, res); if (!orgId) return;
  try { res.json(await ProfessionalBookingService.cancelBooking(orgId, String(req.params.id), actor(req))); }
  catch (e: any) { res.status(400).json({ error: e?.message || "erro" }); }
});
// Registra demanda sem vaga (waitlist na espinha canônica — não fabrica vaga).
router.post("/professional-network/relationships/:id/waitlist", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = gatePN(req, res); if (!orgId) return;
  try { res.json(ProfessionalBookingService.waitlist(orgId, { relationshipId: String(req.params.id), serviceId: req.body?.serviceId ?? null, contactId: req.body?.contactId ?? null, petId: req.body?.petId ?? null, note: req.body?.note ?? null })); }
  catch (e: any) { res.status(400).json({ error: e?.message || "erro" }); }
});
// AutoBooking: PROPÕE a ação governada (nunca agenda direto — RN-PN-6).
router.post("/professional-network/relationships/:id/autobook", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = gatePN(req, res); if (!orgId) return;
  if (!autobookingEnabled(orgId)) return res.status(403).json({ error: "autobooking_disabled" });
  try { res.json(ProfessionalBookingService.autoBook(orgId, { ...(req.body || {}), relationshipId: String(req.params.id), createdBy: actor(req) }, actor(req))); }
  catch (e: any) { res.status(400).json({ error: e?.message || "erro" }); }
});
// Executa o efeito de uma ação de auto_booking APROVADA (choke-point governado).
router.post("/professional-network/autobook/:actionId/execute", requireRole("owner", "admin"), async (req: AuthRequest, res): Promise<any> => {
  const orgId = gatePN(req, res); if (!orgId) return;
  if (!autobookingEnabled(orgId)) return res.status(403).json({ error: "autobooking_disabled" });
  try { res.json(await ProfessionalBookingService.executeAutoBooking(orgId, String(req.params.actionId))); }
  catch (e: any) { res.status(409).json({ error: e?.message || "erro" }); }
});

// ── F8.1 — Finanças da Agenda Federada (split clínica × profissional) ──
// Dinheiro role-gated (§73 — só owner/admin veem valores): extrato do profissional
// (realizado × previsto) + acerto de um atendimento. Read-model DERIVADO (RN-004).
router.get("/professional-network/relationships/:id/finance/statement", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = gatePN(req, res); if (!orgId) return;
  try { res.json(ProfessionalFinanceService.statement(orgId, String(req.params.id), { fromISO: req.query.from as string, toISO: req.query.to as string })); }
  catch (e: any) { res.status(400).json({ error: e?.message || "erro" }); }
});
router.get("/professional-network/appointments/:appointmentId/finance", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = gatePN(req, res); if (!orgId) return;
  try { res.json(ProfessionalFinanceService.settlement(orgId, String(req.params.appointmentId))); }
  catch (e: any) { res.status(404).json({ error: e?.message || "erro" }); }
});
// F8.2 — previsão de receita a receber por profissional (agendado ainda não atendido).
router.get("/professional-network/finance/forecast", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = gatePN(req, res); if (!orgId) return;
  try { res.json(ProfessionalFinanceService.forecast(orgId, { fromISO: req.query.from as string, toISO: req.query.to as string })); }
  catch (e: any) { res.status(400).json({ error: e?.message || "erro" }); }
});

// ── F6.1 — Google Calendar por profissional ──
// A conexão é GLOBAL (por professional_id); a clínica só a inicia via um VÍNCULO ACEITO
// dela (gate natural). O callback público (server.ts) grava o token per-profissional.
router.get("/professional-network/relationships/:id/google/status", (req: AuthRequest, res): any => {
  const orgId = gatePN(req, res); if (!orgId) return;
  const rel = ClinicProfessionalRelationshipService.get(orgId, String(req.params.id));
  if (!rel) return res.status(404).json({ error: "relationship_not_found" });
  res.json(ProfessionalGoogleService.status(rel.professionalId));
});
router.get("/professional-network/relationships/:id/google/login-url", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = gatePN(req, res); if (!orgId) return;
  const rel = ClinicProfessionalRelationshipService.get(orgId, String(req.params.id));
  if (!rel) return res.status(404).json({ error: "relationship_not_found" });
  if (rel.status !== "accepted") return res.status(400).json({ error: "relationship_not_accepted" });
  if (!ProfessionalGoogleService.isConfigured()) return res.status(503).json({ error: "google_not_configured" });
  res.json({ url: ProfessionalGoogleService.authUrl(rel.professionalId, orgId) });
});
router.post("/professional-network/relationships/:id/google/disconnect", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = gatePN(req, res); if (!orgId) return;
  const rel = ClinicProfessionalRelationshipService.get(orgId, String(req.params.id));
  if (!rel) return res.status(404).json({ error: "relationship_not_found" });
  ProfessionalGoogleService.disconnect(rel.professionalId);
  try { logAuthEvent(orgId, actor(req), rel.professionalId, "PROF_GOOGLE_DISCONNECT", {}); } catch { /* noop */ }
  res.json({ ok: true });
});

// ── F7.2 — Magic-link do webapp do profissional (a clínica gera e compartilha) ──
// Só um vínculo ACEITO da org pode emitir; o token é GLOBAL (uma identidade, um acesso).
router.get("/professional-network/relationships/:id/access-link", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = gatePN(req, res); if (!orgId) return;
  try { res.json(ProfessionalAuthService.statusForRelationship(orgId, String(req.params.id))); }
  catch (e: any) { res.status(400).json({ error: e?.message || "erro" }); }
});
router.post("/professional-network/relationships/:id/access-link", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = gatePN(req, res); if (!orgId) return;
  try { res.json(ProfessionalAuthService.issueForRelationship(orgId, String(req.params.id), actor(req))); }
  catch (e: any) { res.status(400).json({ error: e?.message || "erro" }); }
});
router.post("/professional-network/relationships/:id/access-link/revoke", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = gatePN(req, res); if (!orgId) return;
  try { res.json(ProfessionalAuthService.revokeForRelationship(orgId, String(req.params.id), actor(req))); }
  catch (e: any) { res.status(400).json({ error: e?.message || "erro" }); }
});

// ── F9.1 — Inteligência de demanda da rede (read-model derivado) ──
router.get("/professional-network/demand", (req: AuthRequest, res): any => {
  const orgId = gatePN(req, res); if (!orgId) return;
  try { res.json(ProfessionalDemandService.demand(orgId, { windowDays: req.query.days ? Number(req.query.days) : undefined })); }
  catch (e: any) { res.status(400).json({ error: e?.message || "erro" }); }
});

// ── F10.2 — Clínica descobrível (rede/marketplace) ──
router.get("/professional-network/discovery", (req: AuthRequest, res): any => {
  const orgId = gatePN(req, res); if (!orgId) return;
  try { res.json({ ...ClinicDiscoveryService.settings(orgId), soughtSpecialties: ClinicDiscoveryService.soughtSpecialties(orgId) }); }
  catch (e: any) { res.status(400).json({ error: e?.message || "erro" }); }
});
router.put("/professional-network/discovery", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = gatePN(req, res); if (!orgId) return;
  try { res.json(ClinicDiscoveryService.setDiscoverable(orgId, !!req.body?.discoverable)); }
  catch (e: any) { res.status(400).json({ error: e?.message || "erro" }); }
});

export default router;
