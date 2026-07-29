import { Router } from "express";
import { AuthRequest } from "../middleware/auth.js";
import { StudentService } from "../StudentService.js";
import { SchoolDigestService } from "../SchoolDigestService.js";
import { TeacherService } from "../TeacherService.js";
import { TeacherDigestService } from "../TeacherDigestService.js";
import { ExtracurricularService } from "../ExtracurricularService.js";
import { ExtracurricularNoticeService } from "../ExtracurricularNoticeService.js";
import { MessageProviderService } from "../MessageProviderService.js";
import db from "../db.js";

/**
 * Módulo Escola (ADR-144, Fatia 1) — rotas sob /api/escola, gated pelo módulo
 * "escola" (ModuleService.MODULE_BY_ROUTE.escola). Cadastro de alunos, vínculo
 * com o responsável, CONSENTIMENTO-DE-MENOR (porta do envio) e o resumo diário.
 */
const router = Router();
const actor = (req: any) => req.user?.userId || req.user?.id;

// Resolve uma função de envio pelo canal conectado da org (evolution primeiro).
// Retorna null se não houver canal — o chamador decide se o aviso é obrigatório.
const channelSend = (orgId: string): ((target: string, message: string) => any) | null => {
  const channel = db.prepare(`SELECT id FROM channels WHERE organization_id = ? AND status != 'disabled' ORDER BY (provider LIKE 'evolution%') DESC, created_at ASC LIMIT 1`).get(orgId) as any;
  if (!channel) return null;
  return (target: string, message: string) => MessageProviderService.sendMessage(channel.id, target, message);
};

// ── Alunos ──────────────────────────────────────────────────────────────
router.get("/students", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json(StudentService.listStudents(orgId, { q: req.query.q as string, turma: req.query.turma as string }));
});

router.post("/students", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(StudentService.createStudent(orgId, req.body || {}, actor(req))); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.get("/students/:studentId", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(StudentService.getStudent(orgId, req.params.studentId)); }
  catch (e: any) { res.status(404).json({ error: e.message }); }
});

router.put("/students/:studentId", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(StudentService.updateStudent(orgId, req.params.studentId, req.body || {}, actor(req))); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

// ── Responsável + consentimento (a porta do ADR-144 D3) ──────────────────
router.post("/students/:studentId/guardians", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(StudentService.linkGuardian(orgId, req.params.studentId, req.body || {}, actor(req))); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.put("/students/:studentId/guardians/:guardianContactId/consent", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(StudentService.setConsent(orgId, req.params.studentId, req.params.guardianContactId, !!(req.body || {}).consent, actor(req))); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

// ── Agenda do dia (fonte do resumo) ──────────────────────────────────────
router.get("/students/:studentId/agenda", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const date = String(req.query.date || "");
  res.json(StudentService.agendaForDay(orgId, req.params.studentId, date));
});

router.post("/students/:studentId/agenda", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(StudentService.addAgendaItem(orgId, req.params.studentId, req.body || {}, actor(req))); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

// ── Sinal de coordenação: falta ──────────────────────────────────────────
router.post("/students/:studentId/absence", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const { date, reason } = req.body || {};
  try { res.json(StudentService.recordAbsence(orgId, req.params.studentId, String(date || ""), reason, actor(req))); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

// ── Prévia + envio de teste do resumo diário ─────────────────────────────
router.get("/students/:studentId/digest/preview", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const date = String(req.query.date || SchoolDigestService.spParts(new Date()).dateSP);
  try { res.json(SchoolDigestService.dailyDigest(orgId, req.params.studentId, date)); }
  catch (e: any) { res.status(404).json({ error: e.message }); }
});

router.post("/students/:studentId/digest/send-test", async (req: AuthRequest, res): Promise<any> => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const channel = db.prepare(`SELECT id FROM channels WHERE organization_id = ? AND status != 'disabled' ORDER BY (provider LIKE 'evolution%') DESC, created_at ASC LIMIT 1`).get(orgId) as any;
  if (!channel) return res.status(400).json({ error: "Nenhum canal conectado para enviar." });
  const send = (target: string, message: string) => MessageProviderService.sendMessage(channel.id, target, message);
  try {
    const r = await SchoolDigestService.sendNow(orgId, req.params.studentId, { send });
    if (!r.sent) return res.status(400).json({ error: "Nenhum responsável com consentimento e telefone válido." });
    res.json(r);
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

// ── Professores (Fatia 2) ────────────────────────────────────────────────
router.get("/teachers", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json(TeacherService.listTeachers(orgId, { q: req.query.q as string, subject: req.query.subject as string }));
});

router.post("/teachers", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(TeacherService.createTeacher(orgId, req.body || {}, actor(req))); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.get("/teachers/:teacherId", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(TeacherService.getTeacher(orgId, req.params.teacherId)); }
  catch (e: any) { res.status(404).json({ error: e.message }); }
});

router.put("/teachers/:teacherId", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(TeacherService.updateTeacher(orgId, req.params.teacherId, req.body || {}, actor(req))); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

// Opt-in do resumo antes da aula (a porta do envio ao professor)
router.put("/teachers/:teacherId/notify", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(TeacherService.setNotifyOptIn(orgId, req.params.teacherId, !!(req.body || {}).optIn, actor(req))); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

// ── Grade por turma (recorrente) ─────────────────────────────────────────
router.post("/teachers/:teacherId/schedule", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(TeacherService.addScheduleItem(orgId, req.params.teacherId, req.body || {}, actor(req))); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.delete("/schedule/:scheduleItemId", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json(TeacherService.removeScheduleItem(orgId, req.params.scheduleItemId));
});

router.get("/teachers/:teacherId/schedule", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const date = String(req.query.date || "");
  try { res.json(TeacherService.scheduleForDay(orgId, req.params.teacherId, date)); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

// Grade de uma turma num dia (base p/ visão da coordenação)
router.get("/turmas/:turma/schedule", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const date = String(req.query.date || "");
  try { res.json(TeacherService.turmaScheduleForDay(orgId, req.params.turma, date)); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

// ── Confirmação pós-aula (alimenta a coordenação) ────────────────────────
router.post("/classes/confirm", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(TeacherService.confirmClass(orgId, req.body || {}, actor(req))); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

// ── Prévia + envio de teste do resumo antes da aula ──────────────────────
router.get("/teachers/:teacherId/agenda/preview", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const date = String(req.query.date || TeacherDigestService.spParts(new Date()).dateSP);
  try { res.json(TeacherDigestService.dailyAgenda(orgId, req.params.teacherId, date)); }
  catch (e: any) { res.status(404).json({ error: e.message }); }
});

router.post("/teachers/:teacherId/agenda/send-test", async (req: AuthRequest, res): Promise<any> => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const channel = db.prepare(`SELECT id FROM channels WHERE organization_id = ? AND status != 'disabled' ORDER BY (provider LIKE 'evolution%') DESC, created_at ASC LIMIT 1`).get(orgId) as any;
  if (!channel) return res.status(400).json({ error: "Nenhum canal conectado para enviar." });
  const send = (target: string, message: string) => MessageProviderService.sendMessage(channel.id, target, message);
  try {
    const r = await TeacherDigestService.sendNow(orgId, req.params.teacherId, { send });
    if (!r.sent) return res.status(400).json({ error: "Professor sem opt-in, telefone válido ou aulas hoje." });
    res.json(r);
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

// ── Extracurriculares (Fatia 3) ──────────────────────────────────────────
router.get("/activities", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json(ExtracurricularService.listActivities(orgId, { q: req.query.q as string }));
});

router.post("/activities", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(ExtracurricularService.createActivity(orgId, req.body || {}, actor(req))); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.get("/activities/:activityId", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(ExtracurricularService.getActivity(orgId, req.params.activityId)); }
  catch (e: any) { res.status(404).json({ error: e.message }); }
});

router.put("/activities/:activityId", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(ExtracurricularService.updateActivity(orgId, req.params.activityId, req.body || {}, actor(req))); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.get("/activities/:activityId/roster", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(ExtracurricularService.roster(orgId, req.params.activityId)); }
  catch (e: any) { res.status(404).json({ error: e.message }); }
});

// Matrícula → aviso ao responsável (matrícula confirmada ou lista de espera)
router.post("/activities/:activityId/enroll", async (req: AuthRequest, res): Promise<any> => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const studentId = String((req.body || {}).studentId || "");
  try {
    const r = ExtracurricularService.enroll(orgId, req.params.activityId, studentId, actor(req));
    if (!r.deduped) {
      const send = channelSend(orgId);
      if (send) {
        const { activity } = ExtracurricularService.getActivity(orgId, req.params.activityId);
        const name = ExtracurricularNoticeService.studentName(orgId, studentId);
        await ExtracurricularNoticeService.notifyGuardians(orgId, studentId, ExtracurricularNoticeService.enrollmentText(name, activity, r.status, r.position), { send });
      }
    }
    res.json(r);
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

// Cancelar matrícula → se promoveu alguém da espera, avisa o responsável do promovido
router.post("/activities/:activityId/cancel", async (req: AuthRequest, res): Promise<any> => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const studentId = String((req.body || {}).studentId || "");
  try {
    const r = ExtracurricularService.cancelEnrollment(orgId, req.params.activityId, studentId, actor(req));
    if (r.promotedStudentId) {
      const send = channelSend(orgId);
      if (send) {
        const { activity } = ExtracurricularService.getActivity(orgId, req.params.activityId);
        const name = ExtracurricularNoticeService.studentName(orgId, r.promotedStudentId);
        await ExtracurricularNoticeService.notifyGuardians(orgId, r.promotedStudentId, ExtracurricularNoticeService.promotionText(name, activity), { send });
      }
    }
    res.json(r);
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

// Presença → falta avisa o responsável
router.post("/activities/:activityId/attendance", async (req: AuthRequest, res): Promise<any> => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const { studentId, date, status, note } = req.body || {};
  try {
    const r = ExtracurricularService.recordAttendance(orgId, { activityId: req.params.activityId, studentId: String(studentId || ""), date: String(date || ""), status: String(status || ""), note }, actor(req));
    if (r.status === "absent") {
      const send = channelSend(orgId);
      if (send) {
        const { activity } = ExtracurricularService.getActivity(orgId, req.params.activityId);
        const name = ExtracurricularNoticeService.studentName(orgId, String(studentId));
        await ExtracurricularNoticeService.notifyGuardians(orgId, String(studentId), ExtracurricularNoticeService.absenceText(name, activity, String(date)), { send });
      }
    }
    res.json(r);
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

export default router;
