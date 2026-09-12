import { Router } from "express";
import { AuthRequest, requireRole } from "../middleware/auth.js";
import { SalesCoachService } from "../SalesCoachService.js";

/**
 * Rotas do Sales Coach (ADR-202 F6). Superfície INTERNA (treina o vendedor, RN-SC-1 —
 * nada aqui fala com cliente). Gate SERVER-SIDE por flag `sales_coach_enabled` (RN-SC-7)
 * + RBAC (RN-SC-9): gestor (owner/admin) vê o time; o vendedor vê só a si mesmo.
 */
const router = Router();

// Feature-flag: desligada → 404 (a superfície "não existe"). 0-regressão default.
router.use((req: AuthRequest, res, next): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  if (!SalesCoachService.isEnabled(orgId)) return res.status(404).json({ error: "Sales Coach não está habilitado." });
  next();
});

const managerOnly = requireRole("owner", "admin");

// Vendedores do org (gestor escolhe). Só gestor.
router.get("/sellers", managerOnly, (req: AuthRequest, res): any => {
  return res.json({ sellers: SalesCoachService.listSellers(req.organizationId!) });
});

// Visão do PRÓPRIO vendedor (resolve pelo usuário logado).
router.get("/me", (req: AuthRequest, res): any => {
  const orgId = req.organizationId!;
  const sellerId = SalesCoachService.sellerForUser(orgId, req.user?.userId);
  if (!sellerId) return res.status(404).json({ error: "Seu usuário não está vinculado a um vendedor." });
  return res.json(SalesCoachService.bundle(orgId, sellerId));
});

// Visão de um vendedor específico — RBAC: gestor vê qualquer um; vendedor só a si.
router.get("/seller/:sellerId", (req: AuthRequest, res): any => {
  const orgId = req.organizationId!;
  const sellerId = req.params.sellerId;
  if (!SalesCoachService.canView(orgId, req.user, sellerId)) return res.status(403).json({ error: "Sem acesso a este vendedor." });
  const bundle = SalesCoachService.bundle(orgId, sellerId);
  if (!bundle) return res.status(404).json({ error: "Vendedor não encontrado." });
  return res.json(bundle);
});

export default router;
