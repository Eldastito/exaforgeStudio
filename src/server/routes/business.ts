import { Router } from "express";
import { AuthRequest } from "../middleware/auth.js";
import { BusinessSnapshotV2Service } from "../BusinessSnapshotV2Service.js";
import { ImpactPrioritizationService } from "../ImpactPrioritizationService.js";
import db from "../db.js";

// Enterprise Intelligence Kernel (ADR-135) — Business Snapshot V2 (read-only) +
// feature-flag do Diretor consumir o panorama financeiro. Rota core.
const router = Router();

// GET /api/business/snapshot?period=YYYY-MM — panorama estruturado por domínio.
router.get("/snapshot", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const period = typeof req.query?.period === "string" && /^\d{4}-\d{2}$/.test(req.query.period) ? req.query.period : undefined;
  res.json(BusinessSnapshotV2Service.build(orgId, period));
});

// GET /api/business/priorities — Pareto: até 3 prioridades globais e 3 por
// domínio, com score determinístico e explicação (ADR-136 C3, PRD §9).
router.get("/priorities", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json(ImpactPrioritizationService.prioritize(orgId));
});

// GET /api/business/snapshot/flag — estado da feature-flag do Diretor V2.
router.get("/snapshot/flag", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const s = db.prepare("SELECT diretor_snapshot_v2 FROM organization_settings WHERE organization_id = ?").get(orgId) as any;
  res.json({ enabled: !!Number(s?.diretor_snapshot_v2) });
});

// PUT /api/business/snapshot/flag { enabled } — liga/desliga o Diretor V2 (owner/admin).
router.put("/snapshot/flag", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  if (!["owner", "admin"].includes(req.user?.role)) return res.status(403).json({ error: "Apenas gestores podem alterar." });
  const enabled = req.body?.enabled ? 1 : 0;
  db.prepare("UPDATE organization_settings SET diretor_snapshot_v2 = ? WHERE organization_id = ?").run(enabled, orgId);
  res.json({ ok: true, enabled: !!enabled });
});

export default router;
