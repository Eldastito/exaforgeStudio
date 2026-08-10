import { Router } from "express";
import { AuthRequest } from "../middleware/auth.js";
import { BusinessSignalService } from "../BusinessSignalService.js";
import { SignalCorrelationService } from "../SignalCorrelationService.js";
import { FinanceSignalPublisher } from "../FinanceSignalPublisher.js";
import { UpgradeRecommendationService } from "../UpgradeRecommendationService.js";
import db from "../db.js";

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

// ADR-160 F1 (Onda A) — GET /api/signals/attention — leitura TRANSVERSAL de
// atenção: sinais abertos (não expirados) + riscos vivos, ranqueados por
// severidade, num único feed (funde as pontas de percepção pra a UX invisível).
router.get("/attention", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const limit = req.query?.limit ? Number(req.query.limit) : undefined;
  // F3.2 — ?correlate=1 força o colapso de situações; omitido segue a flag da org.
  const correlate = req.query?.correlate === "1" || req.query?.correlate === "true" ? true : undefined;
  res.json(BusinessSignalService.attention(orgId, { limit, correlate }));
});

// PRD 2 F3.1 — GET /api/signals/correlations — situações: sinais abertos do
// MESMO sujeito agrupados (confiança alta), derivados sobre o ledger. Evidência
// individual preservada (o cluster referencia os signalIds).
router.get("/correlations", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const windowHours = req.query?.windowHours ? Number(req.query.windowHours) : undefined;
  res.json(SignalCorrelationService.clusters(orgId, { windowHours }));
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
// ADR-153 F7.3: se o sinal for `domain='plan'`, propaga cooldown pra
// UpgradeRecommendationService (LGPD §14 — rejeição pausa nova oferta).
router.post("/:id/dismiss", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const signalId = req.params.id;
  const out = BusinessSignalService.dismiss(orgId, signalId);
  if (!out.ok) return res.status(404).json({ error: "Sinal não encontrado." });

  // Best-effort: checa se é sinal 'plan' e aplica cooldown na recomendação
  // linkada. Erro aqui NÃO deve falhar o dismiss original (idempotência UX).
  try {
    const row = db.prepare("SELECT domain FROM business_signals WHERE id = ? AND organization_id = ?").get(signalId, orgId) as any;
    if (row?.domain === "plan") {
      const actor = (req as any).user?.userId || null;
      UpgradeRecommendationService.dismissBySignalId(orgId, signalId, actor);
    }
  } catch (e) {
    console.error("[routes/signals] hook UpgradeRecommendationService falhou (best-effort)", e);
  }
  res.json(out);
});

export default router;
