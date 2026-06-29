import { Router } from "express";
import { AuthRequest } from "../middleware/auth.js";
import { TaskService } from "../TaskService.js";
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
