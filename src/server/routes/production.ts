import { Router } from "express";
import { AuthRequest, requirePermission } from "../middleware/auth.js";
import { ProductionService } from "../ProductionService.js";

// Produção (Supervisor de Produção IA, ADR-141) — produto fabricado + BOM +
// necessidade de materiais. Gateado pelo módulo `production` (só gestores por
// padrão; via fallback, owner/admin). Isolado por organização.
const router = Router();
const orgOf = (req: AuthRequest) => req.organizationId as string;

router.get("/products", requirePermission("production", "read"), (req: AuthRequest, res): any => {
  res.json({ products: ProductionService.listProducts(orgOf(req)) });
});
router.post("/products", requirePermission("production", "write"), (req: AuthRequest, res): any => {
  const r = ProductionService.createProduct(orgOf(req), { productServiceId: req.body?.productServiceId, name: req.body?.name });
  if (!r.ok) return res.status(400).json({ error: r.error });
  res.status(201).json(r);
});

router.post("/products/:id/bom", requirePermission("production", "write"), (req: AuthRequest, res): any => {
  const r = ProductionService.createBom(orgOf(req), req.params.id, req.body?.name);
  if (!r.ok) return res.status(400).json({ error: r.error });
  res.status(201).json(r);
});

router.get("/bom/:id", requirePermission("production", "read"), (req: AuthRequest, res): any => {
  const bom = ProductionService.getBom(orgOf(req), req.params.id);
  if (!bom) return res.status(404).json({ error: "BOM não encontrada." });
  res.json(bom);
});
router.post("/bom/:id/items", requirePermission("production", "write"), (req: AuthRequest, res): any => {
  const b = req.body || {};
  const r = ProductionService.addBomItem(orgOf(req), req.params.id, { materialProductServiceId: b.materialProductServiceId, quantity: b.quantity, unit: b.unit });
  if (!r.ok) return res.status(400).json({ error: r.error });
  res.status(201).json(r);
});

// GET /api/production/bom/:id/requirements?quantity=100 — necessidade de materiais.
router.get("/bom/:id/requirements", requirePermission("production", "read"), (req: AuthRequest, res): any => {
  const quantity = Number(req.query?.quantity) || 0;
  const r = ProductionService.materialRequirements(orgOf(req), req.params.id, quantity);
  if (!r) return res.status(404).json({ error: "BOM não encontrada." });
  res.json(r);
});

export default router;
