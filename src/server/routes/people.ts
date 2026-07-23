import { Router } from "express";
import { AuthRequest, requirePermission } from "../middleware/auth.js";
import { EmployeeService } from "../EmployeeService.js";

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

export default router;
