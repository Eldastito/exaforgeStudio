import { Router } from "express";
import { AuthRequest, requireRole } from "../middleware/auth.js";
import { BusinessConstraintService } from "../BusinessConstraintService.js";

/**
 * Restrições do negócio (PRD 3 F4 / §15) — o dono declara LIMITES/POLÍTICAS que as
 * decisões devem respeitar (teto de desconto, limite de orçamento, piso de margem,
 * prazo máximo, política). Leitura pra qualquer papel autenticado; criar/editar/
 * remover é do gestor (owner/admin). Inerte até o dono declarar a 1ª (0 regressão).
 * O Context Engine só LÊ e anexa ao pacote — enforcement segue no RBAC/ApprovalPolicy.
 */
const router = Router();
const actor = (req: AuthRequest) => req.user?.userId;

// GET /api/constraints — restrições (ativas por padrão; ?includeInactive=1 p/ todas).
router.get("/", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const includeInactive = String(req.query.includeInactive || "") === "1";
  res.json({ constraints: BusinessConstraintService.list(orgId, { includeInactive, kind: req.query.kind as string | undefined, scopeType: req.query.scopeType as string | undefined }) });
});

// GET /api/constraints/applicable?scopeType=&scopeRef= — aplicáveis a um escopo.
router.get("/applicable", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json({ constraints: BusinessConstraintService.applicable(orgId, { scopeType: req.query.scopeType as string | undefined, scopeRef: req.query.scopeRef as string | undefined }) });
});

// POST /api/constraints — cria uma restrição (gestor).
router.post("/", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    res.json({ ok: true, constraint: BusinessConstraintService.create(orgId, req.body || {}, actor(req)) });
  } catch (e: any) {
    res.status(400).json({ error: String(e?.message || e) });
  }
});

// PUT /api/constraints/:id — atualiza uma restrição (gestor).
router.put("/:id", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    res.json({ ok: true, constraint: BusinessConstraintService.update(orgId, req.params.id, req.body || {}, actor(req)) });
  } catch (e: any) {
    res.status(400).json({ error: String(e?.message || e) });
  }
});

// DELETE /api/constraints/:id — remove uma restrição (gestor). Idempotente.
router.delete("/:id", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json({ ok: true, ...BusinessConstraintService.remove(orgId, req.params.id, actor(req)) });
});

export default router;
