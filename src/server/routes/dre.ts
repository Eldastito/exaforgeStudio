import { Router } from "express";
import { AuthRequest, requireRole } from "../middleware/auth.js";
import { ManagerialDreService } from "../ManagerialDreService.js";
import { ResultProjectionService } from "../ResultProjectionService.js";
import { HealthyReserveService } from "../HealthyReserveService.js";

// DRE Gerencial Simplificada (ADR-128) — venda × lucro × caixa. Rota core
// (não é módulo opcional): disponível em todas as verticais.
const router = Router();

// GET /api/dre?period=YYYY-MM — DRE gerencial do mês (padrão: mês corrente).
// SEC-F25 (FE3/RN-CG-06/§73): DRE = receita × lucro × caixa (dinheiro de gestão) → owner/admin.
router.get("/", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const period = /^\d{4}-\d{2}$/.test(String(req.query?.period || "")) ? String(req.query.period) : undefined;
  res.json(ManagerialDreService.monthly(orgId, period));
});

// GET /api/dre/result-projection?period=YYYY-MM&asOf=YYYY-MM-DD — ADR-188: projeção do resultado do
// mês (run-rate) + ponto de equilíbrio pleno. Dinheiro de gestão (§73) → owner/admin.
router.get("/result-projection", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const period = /^\d{4}-\d{2}$/.test(String(req.query?.period || "")) ? String(req.query.period) : undefined;
  const asOf = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query?.asOf || "")) ? String(req.query.asOf) : undefined;
  res.json(ResultProjectionService.project(orgId, { period, asOf }));
});

// GET /api/dre/healthy-reserve?period=YYYY-MM — ADR-201: método das 4 contas (Reserva Saudável).
// Metas × realizado × status, base honesta por setor. Dinheiro de gestão (§73) → owner/admin.
router.get("/healthy-reserve", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const period = /^\d{4}-\d{2}$/.test(String(req.query?.period || "")) ? String(req.query.period) : undefined;
  res.json({ plan: HealthyReserveService.plan(orgId, period), config: HealthyReserveService.getConfig(orgId) });
});

// PUT /api/dre/healthy-reserve/config — alvos (%), base do rateio e flag do sinal proativo.
router.put("/healthy-reserve/config", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const b = req.body || {};
  const patch: any = {};
  if (b.enabled != null) patch.enabled = !!b.enabled;
  for (const k of ["profit", "prolabore", "taxes", "ops"]) if (b[k] != null) patch[k] = Number(b[k]);
  if (b.baseMode !== undefined) patch.baseMode = b.baseMode;
  res.json(HealthyReserveService.setConfig(orgId, patch));
});

export default router;
