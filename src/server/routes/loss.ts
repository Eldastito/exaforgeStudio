import { Router } from "express";
import db from "../db.js";
import { randomUUID } from "crypto";
import { AuthRequest } from "../middleware/auth.js";
import { LossMarginService } from "../LossMarginService.js";

// Margem de Perda Aceitável (ADR-114) — indicador global. Rota core (não é
// módulo opcional): disponível em todas as verticais.
const router = Router();

const audit = (orgId?: string, actorId?: string, eventType = "", meta: any = {}) => {
  try {
    db.prepare(`INSERT INTO auth_audit_logs (id, organization_id, actor_user_id, event_type, metadata_json) VALUES (?, ?, ?, ?, ?)`)
      .run(randomUUID(), orgId || null, actorId || null, eventType, JSON.stringify(meta));
  } catch { /* noop */ }
};

// GET /api/loss — visão completa (config + mês atual + histórico + média).
router.get("/", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json(LossMarginService.overview(orgId));
});

// PUT /api/loss/settings — define a margem de perda aceitável.
router.put("/settings", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const cfg = LossMarginService.setConfig(orgId, Number(req.body?.acceptablePct) || 0, req.body?.basis);
  audit(orgId, req.user?.userId, "loss_acceptable_set", cfg);
  res.json(cfg);
});

// POST /api/loss/events — lança uma perda (tipada por driver).
router.post("/events", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const { driver, amount, period, note, isEstimate } = req.body || {};
  const out = LossMarginService.recordLoss(orgId, { driver, amount: Number(amount), period, note, isEstimate: !!isEstimate, createdBy: req.user?.userId });
  if (!out.ok) return res.status(400).json(out);
  audit(orgId, req.user?.userId, "loss_event", { driver: out.driver, amount: out.amount, period: out.period });
  res.status(201).json(out);
});

// POST /api/loss/snapshot — fecha o snapshot do mês (idempotente).
router.post("/snapshot", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json(LossMarginService.snapshotMonth(orgId, req.body?.period));
});

export default router;
