import { Router } from "express";
import { AuthRequest } from "../middleware/auth.js";
import { OwnerDrawService } from "../OwnerDrawService.js";

// Empresa × Proprietário (ADR-129) — retiradas tipadas + pró-labore sustentável.
// Rota core (não é módulo opcional): disponível em todas as verticais.
const router = Router();

// GET /api/owner?period=YYYY-MM — painel Empresa × Proprietário.
router.get("/", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const period = /^\d{4}-\d{2}$/.test(String(req.query?.period || "")) ? String(req.query.period) : undefined;
  res.json(OwnerDrawService.summary(orgId, period));
});

// POST /api/owner/draws — registra uma retirada (gera saída de caixa se aplicável).
router.post("/draws", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const { kind, amount, date, note } = req.body || {};
  const out = OwnerDrawService.record(orgId, { kind, amount: Number(amount), date, note, createdBy: req.user?.userId });
  if (!out.ok) return res.status(400).json(out);
  res.status(201).json(out);
});

export default router;
