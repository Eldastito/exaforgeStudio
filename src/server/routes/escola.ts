import { Router } from "express";
import { AuthRequest } from "../middleware/auth.js";
import { StudentService } from "../StudentService.js";
import { SchoolDigestService } from "../SchoolDigestService.js";
import { MessageProviderService } from "../MessageProviderService.js";
import db from "../db.js";

/**
 * Módulo Escola (ADR-144, Fatia 1) — rotas sob /api/escola, gated pelo módulo
 * "escola" (ModuleService.MODULE_BY_ROUTE.escola). Cadastro de alunos, vínculo
 * com o responsável, CONSENTIMENTO-DE-MENOR (porta do envio) e o resumo diário.
 */
const router = Router();
const actor = (req: any) => req.user?.userId || req.user?.id;

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

export default router;
