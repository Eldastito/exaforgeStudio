import { Router } from "express";
import multer from "multer";
import { AuthRequest, requireRole } from "../middleware/auth.js";
import db from "../db.js";
import { PatientService } from "../PatientService.js";
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
import { ClinicReceiptService } from "../ClinicReceiptService.js";
import { LgpdService } from "../LgpdService.js";
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
    const { buffer, mime, filename } = ClinicAttachmentService.read(orgId, req.params.id);
    res.setHeader("Content-Type", mime);
    // Fase 30: nosniff impede o browser de "adivinhar" o tipo real do
    // arquivo pelo conteúdo (defesa em profundidade contra content-type
    // confusion). O add() já valida magic-byte real, mas nosniff garante
    // que o browser não vai reclassificar mesmo se algum bypass passar.
    res.setHeader("X-Content-Type-Options", "nosniff");
    // Fase 30: sanitiza filename via safeFilename (CRLF/aspas/;/= viram _)
    // e serve tanto `filename=` (fallback ASCII) quanto `filename*=UTF-8''`
    // (moderno, permite acentos) — RFC 6266.
    const clean = safeFilename(filename);
    const encoded = encodeURIComponent(clean);
    const disposition = mime.startsWith("image/") ? "inline" : "attachment";
    res.setHeader(
      "Content-Disposition",
      `${disposition}; filename="${clean}"; filename*=UTF-8''${encoded}`
    );
    return res.send(buffer);
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

// ── Retenção LGPD (ADR-080 Fase U) ──────────────────────────────────────
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

export default router;
