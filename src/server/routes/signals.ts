import { Router } from "express";
import { AuthRequest } from "../middleware/auth.js";
import { BusinessSignalService } from "../BusinessSignalService.js";
import { FinanceSignalPublisher } from "../FinanceSignalPublisher.js";

// Ledger de Sinais Empresariais (ADR-136, Epic 2 — C1). Rota core.
const router = Router();

// GET /api/signals?status=open&domain=finance — lista sinais (isolado por org).
router.get("/", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const status = typeof req.query?.status === "string" ? req.query.status : undefined;
  const domain = typeof req.query?.domain === "string" ? req.query.domain : undefined;
  res.json({ signals: BusinessSignalService.list(orgId, { status, domain }) });
});

// POST /api/signals/refresh — deriva e publica os sinais financeiros (sob demanda, idempotente).
router.post("/refresh", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const finance = FinanceSignalPublisher.run(orgId);
  res.json({ ok: true, finance, signals: BusinessSignalService.list(orgId, { status: "open" }) });
});

// POST /api/signals/:id/acknowledge — marca como reconhecido.
router.post("/:id/acknowledge", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const out = BusinessSignalService.acknowledge(orgId, req.params.id);
  if (!out.ok) return res.status(404).json({ error: "Sinal não encontrado." });
  res.json(out);
});

// POST /api/signals/:id/dismiss — dispensa o sinal.
router.post("/:id/dismiss", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const out = BusinessSignalService.dismiss(orgId, req.params.id);
  if (!out.ok) return res.status(404).json({ error: "Sinal não encontrado." });
  res.json(out);
});

export default router;
