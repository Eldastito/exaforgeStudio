import { Router } from "express";
import { AuthRequest, requirePermission } from "../middleware/auth.js";
import { EmployeeService } from "../EmployeeService.js";
import { WorkloadService } from "../WorkloadService.js";
import { PeopleDevelopmentService } from "../PeopleDevelopmentService.js";
import { PeopleCheckinService } from "../PeopleCheckinService.js";

// RH / People Intelligence (Epic 7, ADR-140) — cadastro funcional. Gateado pelo
// módulo `people` (só gestores por padrão; via fallback, owner/admin). Isolado
// por organização. Só registro — decisões trabalhistas seguem humanas.
const router = Router();
const orgOf = (req: AuthRequest) => req.organizationId as string;

// ── Funções (catálogo) ──
router.get("/roles", requirePermission("people", "read"), (req: AuthRequest, res): any => {
  res.json({ roles: EmployeeService.listRoles(orgOf(req)) });
});

router.post("/roles", requirePermission("people", "write"), (req: AuthRequest, res): any => {
  const r = EmployeeService.createRole(orgOf(req), req.body?.name, req.body?.description);
  if (!r.ok) return res.status(400).json({ error: r.error });
  res.status(201).json(r);
});

// ── Colaboradores ──
router.get("/employees", requirePermission("people", "read"), (req: AuthRequest, res): any => {
  const status = typeof req.query?.status === "string" ? req.query.status : undefined;
  const managerUserId = typeof req.query?.managerUserId === "string" ? req.query.managerUserId : undefined;
  res.json({ employees: EmployeeService.list(orgOf(req), { status, managerUserId }) });
});

router.get("/employees/:id", requirePermission("people", "read"), (req: AuthRequest, res): any => {
  const e = EmployeeService.get(orgOf(req), req.params.id);
  if (!e) return res.status(404).json({ error: "Colaborador não encontrado." });
  res.json(e);
});

router.post("/employees", requirePermission("people", "write"), (req: AuthRequest, res): any => {
  const r = EmployeeService.create(orgOf(req), req.body || {});
  if (!r.ok) return res.status(400).json({ error: r.error });
  res.status(201).json(r);
});

router.put("/employees/:id", requirePermission("people", "write"), (req: AuthRequest, res): any => {
  const r = EmployeeService.update(orgOf(req), req.params.id, req.body || {});
  if (!r.ok) return res.status(400).json({ error: r.error });
  res.json(r);
});

// ── Disponibilidade declarada ──
router.get("/employees/:id/availability", requirePermission("people", "read"), (req: AuthRequest, res): any => {
  res.json({ events: WorkloadService.listAvailability(orgOf(req), req.params.id) });
});

router.post("/employees/:id/availability", requirePermission("people", "write"), (req: AuthRequest, res): any => {
  const b = req.body || {};
  const r = WorkloadService.addAvailability(orgOf(req), { employeeId: req.params.id, kind: b.kind, startDate: b.startDate, endDate: b.endDate, note: b.note, createdBy: req.user?.userId });
  if (!r.ok) return res.status(400).json({ error: r.error });
  res.status(201).json(r);
});

// ── Sobrecarga (tarefas + disponibilidade, com evidência) ──
router.get("/workload", requirePermission("people", "read"), (req: AuthRequest, res): any => {
  const asOfDate = typeof req.query?.asOfDate === "string" ? req.query.asOfDate : undefined;
  res.json(WorkloadService.assess(orgOf(req), { asOfDate }));
});

// Publica os sinais de sobrecarga no ledger (idempotente por dia).
router.post("/workload/publish-signals", requirePermission("people", "write"), (req: AuthRequest, res): any => {
  res.json(WorkloadService.publishOverloadSignals(orgOf(req), { asOfDate: req.body?.asOfDate }));
});

// ── Competências e treinamentos (fatia 2) ──
router.get("/skills", requirePermission("people", "read"), (req: AuthRequest, res): any => {
  res.json({ skills: PeopleDevelopmentService.listSkills(orgOf(req)) });
});
router.post("/skills", requirePermission("people", "write"), (req: AuthRequest, res): any => {
  const r = PeopleDevelopmentService.createSkill(orgOf(req), req.body?.name, req.body?.category);
  if (!r.ok) return res.status(400).json({ error: r.error });
  res.status(201).json(r);
});

router.get("/employees/:id/skills", requirePermission("people", "read"), (req: AuthRequest, res): any => {
  res.json({ skills: PeopleDevelopmentService.listEmployeeSkills(orgOf(req), req.params.id) });
});
router.put("/employees/:id/skills", requirePermission("people", "write"), (req: AuthRequest, res): any => {
  const r = PeopleDevelopmentService.setEmployeeSkill(orgOf(req), req.params.id, req.body?.skillId, req.body?.level);
  if (!r.ok) return res.status(400).json({ error: r.error });
  res.json(r);
});

router.get("/training-paths", requirePermission("people", "read"), (req: AuthRequest, res): any => {
  res.json({ paths: PeopleDevelopmentService.listPaths(orgOf(req)) });
});
router.post("/training-paths", requirePermission("people", "write"), (req: AuthRequest, res): any => {
  const r = PeopleDevelopmentService.createPath(orgOf(req), req.body || {});
  if (!r.ok) return res.status(400).json({ error: r.error });
  res.status(201).json(r);
});

router.post("/employees/:id/training", requirePermission("people", "write"), (req: AuthRequest, res): any => {
  const r = PeopleDevelopmentService.assign(orgOf(req), req.params.id, req.body?.pathId);
  if (!r.ok) return res.status(400).json({ error: r.error });
  res.status(201).json(r);
});
router.put("/training-assignments/:id", requirePermission("people", "write"), (req: AuthRequest, res): any => {
  const r = PeopleDevelopmentService.setAssignmentStatus(orgOf(req), req.params.id, req.body?.status);
  if (!r.ok) return res.status(400).json({ error: r.error });
  res.json(r);
});

// Plano de desenvolvimento: lacuna de competência + trilhas recomendadas.
router.get("/employees/:id/development", requirePermission("people", "read"), (req: AuthRequest, res): any => {
  const plan = PeopleDevelopmentService.developmentPlan(orgOf(req), req.params.id);
  if (!plan) return res.status(404).json({ error: "Colaborador não encontrado." });
  res.json(plan);
});

// ── Check-ins / reconhecimento / feedback documentado (fatia 4) ──
router.get("/employees/:id/checkins", requirePermission("people", "read"), (req: AuthRequest, res): any => {
  const kind = typeof req.query?.kind === "string" ? req.query.kind : undefined;
  res.json({ checkins: PeopleCheckinService.list(orgOf(req), req.params.id, { kind }), summary: PeopleCheckinService.summaryFor(orgOf(req), req.params.id) });
});
router.post("/employees/:id/checkins", requirePermission("people", "write"), (req: AuthRequest, res): any => {
  const b = req.body || {};
  const r = PeopleCheckinService.create(orgOf(req), { employeeId: req.params.id, kind: b.kind, period: b.period, summary: b.summary, strengths: b.strengths, nextSteps: b.nextSteps, authorUserId: req.user?.userId });
  if (!r.ok) return res.status(400).json({ error: r.error });
  res.status(201).json(r);
});

export default router;
