import { Router } from "express";
import { AuthRequest } from "../middleware/auth.js";
import { DecisionActionService } from "../DecisionActionService.js";

// Decision & Action Ledger (ADR-136, Epic 2 — C2). Rota core.
const router = Router();
const actor = (req: AuthRequest) => req.user?.userId;

// GET /api/actions?status=awaiting_approval&domain=finance
router.get("/", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const status = typeof req.query?.status === "string" ? req.query.status : undefined;
  const domain = typeof req.query?.domain === "string" ? req.query.domain : undefined;
  res.json({ actions: DecisionActionService.list(orgId, { status, domain }) });
});

router.get("/:id", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const a = DecisionActionService.get(orgId, req.params.id);
  if (!a) return res.status(404).json({ error: "Ação não encontrada." });
  res.json(a);
});

// POST /api/actions — propõe uma ação (a política define se exige aprovação).
router.post("/", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    res.status(201).json(DecisionActionService.propose(orgId, { ...(req.body || {}), createdBy: req.body?.createdBy || "user" }));
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

// POST /api/actions/:id/approve — aprova (gestor/perfil exigido).
router.post("/:id/approve", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const a = DecisionActionService.get(orgId, req.params.id);
  if (!a) return res.status(404).json({ error: "Ação não encontrada." });
  // RBAC: perfil exigido pela política; na ausência, owner/admin aprovam.
  const role = req.user?.role;
  const required = a.approval_role;
  const ok = required ? (role === required || role === "owner") : ["owner", "admin"].includes(role);
  if (!ok) return res.status(403).json({ error: `Aprovação exige perfil ${required || "gestor (owner/admin)"}.` });
  try {
    res.json(DecisionActionService.approve(orgId, req.params.id, actor(req), { reason: req.body?.reason }));
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

// POST /api/actions/:id/reject
router.post("/:id/reject", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  if (!["owner", "admin"].includes(req.user?.role)) return res.status(403).json({ error: "Apenas gestores rejeitam." });
  try {
    res.json(DecisionActionService.reject(orgId, req.params.id, actor(req), { reason: req.body?.reason }));
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

// POST /api/actions/:id/assign { userId }
router.post("/:id/assign", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(DecisionActionService.assign(orgId, req.params.id, req.body?.userId || null)); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

// POST /api/actions/:id/reschedule { dueAt }
router.post("/:id/reschedule", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(DecisionActionService.reschedule(orgId, req.params.id, req.body?.dueAt || null)); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

// POST /api/actions/:id/complete { resultAmount? }
router.post("/:id/complete", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(DecisionActionService.complete(orgId, req.params.id, { resultAmount: req.body?.resultAmount })); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

// POST /api/actions/:id/cancel
router.post("/:id/cancel", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(DecisionActionService.cancel(orgId, req.params.id)); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

export default router;
