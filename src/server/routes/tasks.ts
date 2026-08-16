import { Router } from "express";
import { AuthRequest } from "../middleware/auth.js";
import { TaskService } from "../TaskService.js";
import { TaskRecurrenceService } from "../TaskRecurrenceService.js";
import { ExecutiveAdvisorService } from "../ExecutiveAdvisorService.js";

const router = Router();
const actor = (req: any) => req.user?.userId || req.user?.id;

// GET /api/tasks?status=&assignedTo=
router.get("/", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json(TaskService.list(orgId, { status: req.query.status as string, assignedTo: req.query.assignedTo as string }));
});

// GET /api/tasks/summary — contadores por status (para badges)
router.get("/summary", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json(TaskService.summary(orgId));
});

// --- Tarefas recorrentes (ADR-171) — REGISTRAR ANTES de /:id ---------------
// GET /api/tasks/recurrence?status=
router.get("/recurrence", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json({ rules: TaskRecurrenceService.list(orgId, { status: req.query.status as string }) });
});

// POST /api/tasks/recurrence — cria a regra recorrente
router.post("/recurrence", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    res.status(201).json(TaskRecurrenceService.create(orgId, req.body || {}, actor(req)));
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

// GET /api/tasks/recurrence/:id
router.get("/recurrence/:id", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const r = TaskRecurrenceService.get(orgId, req.params.id);
  if (!r) return res.status(404).json({ error: "Regra não encontrada." });
  res.json(r);
});

// POST /api/tasks/recurrence/:id/pause | /resume ; DELETE encerra
router.post("/recurrence/:id/pause", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const r = TaskRecurrenceService.pause(orgId, req.params.id, actor(req));
  if (!r) return res.status(404).json({ error: "Regra não encontrada." });
  res.json(r);
});
router.post("/recurrence/:id/resume", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const r = TaskRecurrenceService.resume(orgId, req.params.id, actor(req));
    if (!r) return res.status(404).json({ error: "Regra não encontrada." });
    res.json(r);
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});
router.delete("/recurrence/:id", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const r = TaskRecurrenceService.end(orgId, req.params.id, actor(req));
  if (!r) return res.status(404).json({ error: "Regra não encontrada." });
  res.json({ ok: true, rule: r });
});

// GET /api/tasks/:id
router.get("/:id", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const t = TaskService.get(orgId, req.params.id);
  if (!t) return res.status(404).json({ error: "Tarefa não encontrada." });
  res.json(t);
});

// POST /api/tasks
router.post("/", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    res.json(TaskService.create(orgId, req.body || {}, actor(req)));
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

// PATCH /api/tasks/:id
router.patch("/:id", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    res.json(TaskService.update(orgId, req.params.id, req.body || {}, actor(req)));
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

// POST /api/tasks/:id/move { status }
router.post("/:id/move", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    res.json(TaskService.move(orgId, req.params.id, String(req.body?.status || ""), actor(req)));
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

// POST /api/tasks/:id/result { resultFinal?, evidenceUrl? } — conclui com resultado + evidência (ADR-134).
router.post("/:id/result", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    res.json(TaskService.recordResult(orgId, req.params.id, { resultFinal: req.body?.resultFinal, evidenceUrl: req.body?.evidenceUrl }, actor(req)));
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

// POST /api/tasks/:id/resources { kind, productId?, label?, quantity?, amount? }
router.post("/:id/resources", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    res.json(TaskService.addResource(orgId, req.params.id, req.body || {}));
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

// DELETE /api/tasks/:id/resources/:rid
router.delete("/:id/resources/:rid", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    res.json(TaskService.removeResource(orgId, req.params.id, req.params.rid));
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

// POST /api/tasks/:id/notes { text }
router.post("/:id/notes", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    res.json(TaskService.addNote(orgId, req.params.id, String(req.body?.text || ""), actor(req)));
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

// POST /api/tasks/:id/assist — Coordenador IA assessora a entrega (sob demanda)
router.post("/:id/assist", async (req: AuthRequest, res): Promise<any> => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const t = TaskService.get(orgId, req.params.id);
  if (!t) return res.status(404).json({ error: "Tarefa não encontrada." });
  try {
    const text = await ExecutiveAdvisorService.taskAssist(orgId, {
      title: t.title, description: t.description, contactName: t.contact?.name, refLabel: t.ref_label,
    });
    res.json({ assist: text });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;
