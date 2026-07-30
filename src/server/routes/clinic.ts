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
import { ClinicDocumentsService } from "../ClinicDocumentsService.js";
import { ClinicAttachmentService, ALLOWED_MIME, MAX_BYTES } from "../ClinicAttachmentService.js";
import { ClinicDocumentDeliveryService } from "../ClinicDocumentDeliveryService.js";
import { ClinicPatientPortalService } from "../ClinicPatientPortalService.js";
import { ClinicReminderService } from "../ClinicReminderService.js";
import { ClinicMetricsService } from "../ClinicMetricsService.js";
import { LgpdService } from "../LgpdService.js";

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

// ── Documentos clínicos: Receita + Atestado (ADR-080 Fase H) ────────────
// Ciclo draft → issued (imutável após issued). LGPD Art.11 no service.
// PDF é Buffer (padrão ReportPdfService.generateGovernancePdf).

const docError = (res: any, e: any) => {
  if (e?.code === "LGPD_CONSENT_REQUIRED" || e?.code === "DOCUMENT_ISSUED") {
    return res.status(409).json({ error: e.message, code: e.code });
  }
  return res.status(400).json({ error: e.message });
};

// Listagem consolidada dos docs do encounter.
router.get("/encounters/:id/documents", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json(ClinicDocumentsService.listByEncounter(orgId, req.params.id));
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
router.post("/prescriptions/:id/issue", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(ClinicDocumentsService.issuePrescription(orgId, req.params.id, actor(req))); }
  catch (e: any) { docError(res, e); }
});
router.get("/prescriptions/:id/pdf", async (req: AuthRequest, res): Promise<any> => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const pdf = await ClinicDocumentsService.renderPrescriptionPdf(orgId, req.params.id);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="receita-${req.params.id}.pdf"`);
    return res.send(pdf);
  } catch (e: any) { res.status(400).json({ error: e.message }); }
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
router.post("/certificates/:id/issue", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(ClinicDocumentsService.issueCertificate(orgId, req.params.id, actor(req))); }
  catch (e: any) { docError(res, e); }
});
router.get("/certificates/:id/pdf", async (req: AuthRequest, res): Promise<any> => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const pdf = await ClinicDocumentsService.renderCertificatePdf(orgId, req.params.id);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="atestado-${req.params.id}.pdf"`);
    return res.send(pdf);
  } catch (e: any) { res.status(400).json({ error: e.message }); }
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

router.get("/documents/:kind/:id/deliveries", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const kind = req.params.kind === "certificate" ? "certificate" : "prescription";
  res.json(ClinicDocumentDeliveryService.list(orgId, kind as any, req.params.id));
});

// ── Anexos do prontuário (ADR-080 Fase J) ──────────────────────────────
// Multipart. Arquivo fica em PRIVATE_MEDIA_DIR (fora do /media estático).
// LGPD Art.11 e bloqueio pós-signed no service.

router.get("/encounters/:id/attachments", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json(ClinicAttachmentService.list(orgId, req.params.id));
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
    // inline pra imagem (front renderiza), attachment pra PDF (download).
    const disposition = mime.startsWith("image/") ? "inline" : "attachment";
    res.setHeader("Content-Disposition", `${disposition}; filename="${filename.replace(/"/g, "")}"`);
    return res.send(buffer);
  } catch (e: any) { res.status(404).json({ error: e.message }); }
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
  const o = db.prepare(`SELECT clinic_reminder_hours FROM organization_settings WHERE organization_id = ?`).get(orgId) as any;
  res.json({ hoursBefore: Number(o?.clinic_reminder_hours) || 24 });
});

router.put("/settings/reminders", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const h = Math.max(1, Math.min(168, Math.floor(Number(req.body?.hoursBefore))));
  if (!Number.isFinite(h) || h < 1) return res.status(400).json({ error: "hoursBefore inválido (1..168)." });
  db.prepare(`UPDATE organization_settings SET clinic_reminder_hours = ? WHERE organization_id = ?`).run(h, orgId);
  res.json({ hoursBefore: h });
});

// ── Portal do Paciente — gestão (ADR-080 Fase L) ────────────────────────
// Só gera token se LGPD sensível + comunicações concedidos. Link é o
// que o gestor manda pro paciente (WhatsApp/e-mail); a rota pública que
// consome o token vive em `clinicPublic.ts`.
router.post("/patients/:contactId/portal-tokens", (req: AuthRequest, res): any => {
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

router.delete("/patients/portal-tokens/:tokenId", (req: AuthRequest, res): any => {
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
