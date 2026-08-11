import { Router } from "express";
import { AuthRequest, requireRole } from "../middleware/auth.js";
import { BusinessSignalService } from "../BusinessSignalService.js";
import { SignalCorrelationService } from "../SignalCorrelationService.js";
import { SignalInvestigationService } from "../SignalInvestigationService.js";
import { SignalEnrichmentService } from "../SignalEnrichmentService.js";
import { SignalCalibrationService } from "../SignalCalibrationService.js";
import { HumanSignalService } from "../HumanSignalService.js";
import { ExternalSignalService } from "../ExternalSignalService.js";
import { RadarHealthService } from "../RadarHealthService.js";
import { DetectorBudgetService } from "../DetectorBudgetService.js";
import { FinanceSignalPublisher } from "../FinanceSignalPublisher.js";
import { logAuthEvent } from "../auditLog.js";
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

// PRD 2 F11 (§66/CA19) — GET /api/signals/calibration — qualidade do Radar por
// detector (false-positive rate, dismissal rate, calibração). UI admin (§94).
router.get("/calibration", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const days = req.query?.days !== undefined ? Number(req.query.days) : undefined;
  res.json(SignalCalibrationService.detectorMetrics(orgId, { days }));
});

// PRD 2 F12.1 (§94-98, CA16) — GET /api/signals/health — saúde OPERACIONAL do
// Radar pra o admin: volume, freshness (detector que parou), storm, calibração
// (reusa F11) e status geral. Observabilidade — não publica nem executa nada.
router.get("/health", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const windowHours = req.query?.windowHours ? Number(req.query.windowHours) : undefined;
  const staleHours = req.query?.staleHours ? Number(req.query.staleHours) : undefined;
  const calibrationDays = req.query?.calibrationDays !== undefined ? Number(req.query.calibrationDays) : undefined;
  res.json(RadarHealthService.overview(orgId, { windowHours, staleHours, calibrationDays }));
});

// PRD 2 F12.2 (§84, CA17) — GET /api/signals/detector-budget — teto diário de
// investigação profunda (LLM) por detector + consumo do dia. Observabilidade
// admin do custo de IA por detector (evita que um storm drene a verba da org).
router.get("/detector-budget", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json(DetectorBudgetService.overview(orgId));
});

// PRD 2 F6.1 — GET /api/signals/:id/investigate — causas-candidatas determinísticas
// (evidência a favor/contra + confiança), sem IA. "Por que provavelmente acontece?"
router.get("/:id/investigate", async (req: AuthRequest, res): Promise<any> => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  // F6.2 — ?deep=1 tenta a síntese por IA (gated por nível de impacto §83);
  // sem a flag (ou fora do gate) devolve só a leitura determinística (F6.1).
  if (req.query?.deep === "1" || req.query?.deep === "true") {
    return res.json(await SignalInvestigationService.investigateDeep(orgId, req.params.id));
  }
  res.json(SignalInvestigationService.investigate(orgId, req.params.id));
});

// PRD 3 F5 (§38/§39) — GET /api/signals/:id/context — SIGNAL CONTEXT ENRICHMENT:
// o contexto DAQUELE sinal (resolver ancorado no sujeito + meta ameaçada + ação
// recomendada + restrições aplicáveis + correlatos do mesmo sujeito). A ponte
// percepção→contexto pro Maestro (PRD 4). READ+DERIVE — não executa nada.
// ?profile=minimal|standard|deep controla a profundidade (default standard).
router.get("/:id/context", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const p = req.query?.profile;
  const profile = p === "minimal" || p === "deep" ? p : undefined;
  const out = SignalEnrichmentService.enrich(orgId, req.params.id, { profile });
  if (!out.found) return res.status(404).json({ error: "Sinal não encontrado." });
  res.json(out);
});

// PRD 2 F9 (§45-46, CA2) — POST /api/signals/observe — a origem HUMANA da
// percepção: uma observação do humano vira um sinal normalizado no ledger, com
// ACÚMULO DE EVIDÊNCIA (mesmo assunto sobe confiança/severidade). Opt-in por org;
// nunca vira fato (§13). A rota valida a FORMA; o service guarda a invariante.
router.post("/observe", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const b = req.body || {};
  const observation = typeof b.observation === "string" ? b.observation.trim() : "";
  const domain = typeof b.domain === "string" ? b.domain.trim() : "";
  if (!observation) return res.status(400).json({ error: "observation é obrigatória." });
  if (!domain) return res.status(400).json({ error: "domain é obrigatório." });
  const actor = (req as any).user?.userId || null;
  const out = HumanSignalService.observe(orgId, {
    observerId: actor,
    observation,
    domain,
    signalType: typeof b.signalType === "string" ? b.signalType : undefined,
    subjectType: typeof b.subjectType === "string" ? b.subjectType : null,
    subjectId: typeof b.subjectId === "string" ? b.subjectId : null,
    basis: b.basis === "hypothesis" ? "hypothesis" : "estimate",
    sourceEntityType: typeof b.sourceEntityType === "string" ? b.sourceEntityType : null,
    sourceEntityId: typeof b.sourceEntityId === "string" ? b.sourceEntityId : null,
    correlationId: typeof b.correlationId === "string" ? b.correlationId : null,
  });
  if (!out.ok) {
    // 'disabled' → 403 (feature não habilitada); demais formas → 400.
    const code = out.reason === "disabled" ? 403 : 400;
    return res.status(code).json({ error: out.reason || "invalid" });
  }
  logAuthEvent(orgId, actor, null, "RADAR_HUMAN_OBSERVATION", { signalId: out.signalId, domain, observationCount: out.observationCount, severity: out.severity });
  res.json(out);
});

// PRD 2 F10 (§48-51, CA2) — POST /api/signals/ingest-external — o MOLDE de
// ingestão da origem EXTERNA: um conector (Reclame AQUI, reviews, market intel)
// entrega um sinal externo JÁ CAPTURADO e este endpoint o normaliza no ledger,
// com proveniência (source+externalId) e sem promover a fato não verificado (§13).
// Opt-in por org. A rota valida a FORMA; o service guarda a invariante.
router.post("/ingest-external", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const b = req.body || {};
  const source = typeof b.source === "string" ? b.source.trim() : "";
  const externalId = typeof b.externalId === "string" ? b.externalId.trim() : "";
  const domain = typeof b.domain === "string" ? b.domain.trim() : "";
  const content = typeof b.content === "string" ? b.content.trim() : "";
  if (!source) return res.status(400).json({ error: "source é obrigatório." });
  if (!externalId) return res.status(400).json({ error: "externalId é obrigatório." });
  if (!domain) return res.status(400).json({ error: "domain é obrigatório." });
  if (!content) return res.status(400).json({ error: "content é obrigatório." });
  const actor = (req as any).user?.userId || null;
  const out = ExternalSignalService.ingest(orgId, {
    source, externalId, domain, content,
    signalType: typeof b.signalType === "string" ? b.signalType : undefined,
    subjectType: typeof b.subjectType === "string" ? b.subjectType : null,
    subjectId: typeof b.subjectId === "string" ? b.subjectId : null,
    severity: typeof b.severity === "string" ? b.severity : null,
    basis: b.basis === "fact" || b.basis === "hypothesis" ? b.basis : "estimate",
    verifiable: b.verifiable === true,
    url: typeof b.url === "string" ? b.url : null,
    publishedAt: typeof b.publishedAt === "string" ? b.publishedAt : null,
    author: typeof b.author === "string" ? b.author : null,
    sentiment: b.sentiment === "negative" || b.sentiment === "neutral" || b.sentiment === "positive" ? b.sentiment : null,
    rating: typeof b.rating === "number" ? b.rating : null,
    ratingScale: typeof b.ratingScale === "number" ? b.ratingScale : null,
    expiresAt: typeof b.expiresAt === "string" ? b.expiresAt : null,
    correlationId: typeof b.correlationId === "string" ? b.correlationId : null,
  });
  if (!out.ok) {
    const code = out.reason === "disabled" ? 403 : 400;
    return res.status(code).json({ error: out.reason || "invalid" });
  }
  logAuthEvent(orgId, actor, null, "RADAR_EXTERNAL_INGEST", { signalId: out.signalId, source, externalId, domain, basis: out.basis, severity: out.severity });
  res.json(out);
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
  // F11 (§65) — motivo opcional do descarte (expected|irrelevant|incorrect|duplicate|already_resolved).
  const reason = typeof req.body?.reason === "string" ? req.body.reason : null;
  const out = BusinessSignalService.dismiss(orgId, signalId, reason);
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
