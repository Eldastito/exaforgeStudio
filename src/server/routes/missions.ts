/**
 * MISSIONS — API do Mission Contract (ADR-189 F1, Mission OS). Montada em /api/missions.
 * owner/admin (missão é decisão de negócio do dono). GATE SERVER-SIDE pela flag
 * `mission_layer_enabled` (esconder botão não é segurança): desligada → 404, o recurso
 * não existe pro tenant. A rota valida FORMA; o invariante vive no MissionService.
 */
import { Router } from "express";
import { AuthRequest, requireRole } from "../middleware/auth.js";
import { MissionService } from "../MissionService.js";
import { MissionIntentService } from "../MissionIntentService.js";
import { MissionReversePlanner } from "../MissionReversePlanner.js";
import { MissionReadinessService } from "../MissionReadinessService.js";
import { MissionRuntimeService } from "../MissionRuntimeService.js";
import { MissionCheckpointService } from "../MissionCheckpointService.js";
import { MissionDebriefService } from "../MissionDebriefService.js";
import { MissionProactiveService } from "../MissionProactiveService.js";
import { MissionNextStepService } from "../MissionNextStepService.js";
import { MissionMetricsService } from "../MissionMetricsService.js";

const router = Router();
const actor = (req: any) => req.user?.userId || req.user?.id;
function fail(res: any, e: any) { res.status(400).json({ error: e?.message || "erro" }); }

/** Gate: o Mission Layer precisa estar ligado pra org (opt-in). */
function requireMissionLayer(req: AuthRequest, res: any, next: any): any {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  if (!MissionService.isEnabled(orgId)) return res.status(404).json({ error: "Mission Layer indisponível para esta organização." });
  next();
}

/** ADR-189 F18 — HABILITAÇÃO DO PILOTO. Estas 2 rotas ficam ANTES do gate `requireMissionLayer`
 * (senão o dono nunca alcançaria a rota pra ligar a flag — ovo-e-galinha). Ainda owner/admin.
 * GET = estado atual (habilitado? postura proativa? nº de missões). PUT = liga/desliga (reversível). */
router.get("/enablement", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  try { res.json(MissionService.settings(req.organizationId!)); } catch (e: any) { fail(res, e); }
});
router.put("/enablement", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  try { res.json(MissionService.setEnabled(req.organizationId!, req.body?.enabled === true || req.body?.enabled === 1, actor(req))); }
  catch (e: any) { fail(res, e); }
});

router.use(requireRole("owner", "admin"), requireMissionLayer);

/** Lista as missões (opcional ?status=). */
router.get("/", (req: AuthRequest, res): any => {
  try {
    const status = typeof req.query?.status === "string" ? req.query.status : undefined;
    res.json({ missions: MissionService.list(req.organizationId!, { status }) });
  } catch (e: any) { fail(res, e); }
});

/** Cria uma missão (nasce draft, autonomia off). */
router.post("/", (req: AuthRequest, res): any => {
  try { res.json(MissionService.create(req.organizationId!, req.body || {}, actor(req))); }
  catch (e: any) { fail(res, e); }
});

/** ADR-189 F2 — Intenção → Missão (shadow). Detecta objetivo de negócio e PROPÕE uma missão.
 * ?persist=1 (ou body.persist) grava um rascunho system_proposed (nunca executa). */
router.post("/intent", (req: AuthRequest, res): any => {
  try {
    const text = String(req.body?.text || "");
    const persist = req.body?.persist === true || req.query?.persist === "1";
    res.json(MissionIntentService.propose(req.organizationId!, text, { persist, actor: actor(req) }));
  } catch (e: any) { fail(res, e); }
});

/** ADR-189 F11 — Missões proativas (§34). Preview (read-only) do que os sinais proporiam. */
router.get("/proactive/scan", (req: AuthRequest, res): any => {
  try { res.json({ mode: MissionProactiveService.mode(req.organizationId!), proposals: MissionProactiveService.scan(req.organizationId!) }); }
  catch (e: any) { fail(res, e); }
});
/** Define a postura (off|shadow|suggest — nunca 'auto'). */
router.post("/proactive/mode", (req: AuthRequest, res): any => {
  try { res.json(MissionProactiveService.setMode(req.organizationId!, String(req.body?.mode || ""), actor(req))); }
  catch (e: any) { fail(res, e); }
});
/** Roda a materialização conforme a postura (suggest grava rascunhos; nunca executa). */
router.post("/proactive/run", (req: AuthRequest, res): any => {
  try { res.json(MissionProactiveService.run(req.organizationId!, { actor: actor(req) })); }
  catch (e: any) { fail(res, e); }
});

/** ADR-189 F20 — KPIs do piloto (derivados por query; honestos, null sem denominador). Read-only. */
router.get("/metrics", (req: AuthRequest, res): any => {
  try { res.json(MissionMetricsService.metrics(req.organizationId!)); } catch (e: any) { fail(res, e); }
});

/** Detalhe de uma missão. */
router.get("/:id", (req: AuthRequest, res): any => {
  try {
    const m = MissionService.get(req.organizationId!, String(req.params.id));
    if (!m) return res.status(404).json({ error: "Missão não encontrada." });
    res.json(m);
  } catch (e: any) { fail(res, e); }
});

/** ADR-189 F3 — Planejamento reverso: meta → eventos → gap vs base + gargalo + último momento seguro.
 * Premissas opcionais no body (avgTicket, saleConversionRate, contactConversionRate, baseAvailable,
 * leadTimeDays); sem elas, deriva do dado real ou marca `unknown` (nunca inventa). Read-only. */
router.post("/:id/plan", (req: AuthRequest, res): any => {
  try {
    const b = req.body || {};
    res.json(MissionReversePlanner.plan(req.organizationId!, String(req.params.id), {
      avgTicket: b.avgTicket != null ? Number(b.avgTicket) : undefined,
      saleConversionRate: b.saleConversionRate != null ? Number(b.saleConversionRate) : undefined,
      contactConversionRate: b.contactConversionRate != null ? Number(b.contactConversionRate) : undefined,
      baseAvailable: b.baseAvailable != null ? Number(b.baseAvailable) : undefined,
      leadTimeDays: b.leadTimeDays != null ? Number(b.leadTimeDays) : undefined,
      showRate: b.showRate != null ? Number(b.showRate) : undefined,
      bookingConversionRate: b.bookingConversionRate != null ? Number(b.bookingConversionRate) : undefined,
    }));
  } catch (e: any) { fail(res, e); }
});

/** ADR-189 F4 — Prontidão + risco da missão (compõe; Pre-Mortem light). Premissas do plano opcionais. */
router.post("/:id/readiness", (req: AuthRequest, res): any => {
  try {
    const b = req.body || {};
    res.json(MissionReadinessService.assess(req.organizationId!, String(req.params.id), {
      avgTicket: b.avgTicket != null ? Number(b.avgTicket) : undefined,
      saleConversionRate: b.saleConversionRate != null ? Number(b.saleConversionRate) : undefined,
      contactConversionRate: b.contactConversionRate != null ? Number(b.contactConversionRate) : undefined,
      baseAvailable: b.baseAvailable != null ? Number(b.baseAvailable) : undefined,
      showRate: b.showRate != null ? Number(b.showRate) : undefined,
      bookingConversionRate: b.bookingConversionRate != null ? Number(b.bookingConversionRate) : undefined,
    }));
  } catch (e: any) { fail(res, e); }
});

/** ADR-189 F5 — propõe um efeito da missão como AÇÃO GOVERNADA (nunca executa direto). */
router.post("/:id/actions", (req: AuthRequest, res): any => {
  try {
    const b = req.body || {};
    res.json(MissionRuntimeService.proposeAction(req.organizationId!, String(req.params.id), {
      domain: String(b.domain || ""), actionType: String(b.actionType || ""), title: String(b.title || ""),
      description: b.description ?? null, commandType: b.commandType ?? null, commandPayload: b.commandPayload,
      expectedImpact: b.expectedImpact != null ? Number(b.expectedImpact) : null, impactUnit: b.impactUnit ?? null,
      basis: b.basis, confidence: b.confidence != null ? Number(b.confidence) : null,
    }, actor(req)));
  } catch (e: any) { fail(res, e); }
});

/** ADR-189 F15 — Próximo passo: deriva do gargalo uma ação governada sugerida (shadow, read-only).
 * Premissas do plano opcionais no body (mesmas do /plan). Não escreve nada. */
router.post("/:id/next-step", (req: AuthRequest, res): any => {
  try {
    const b = req.body || {};
    res.json(MissionNextStepService.suggest(req.organizationId!, String(req.params.id), {
      avgTicket: b.avgTicket != null ? Number(b.avgTicket) : undefined,
      saleConversionRate: b.saleConversionRate != null ? Number(b.saleConversionRate) : undefined,
      contactConversionRate: b.contactConversionRate != null ? Number(b.contactConversionRate) : undefined,
      baseAvailable: b.baseAvailable != null ? Number(b.baseAvailable) : undefined,
      leadTimeDays: b.leadTimeDays != null ? Number(b.leadTimeDays) : undefined,
      showRate: b.showRate != null ? Number(b.showRate) : undefined,
      bookingConversionRate: b.bookingConversionRate != null ? Number(b.bookingConversionRate) : undefined,
    }));
  } catch (e: any) { fail(res, e); }
});

/** Encaminha o próximo passo sugerido pelo caminho GOVERNADO (nunca executa direto; recusa 'off'). */
router.post("/:id/next-step/propose", (req: AuthRequest, res): any => {
  try {
    const b = req.body || {};
    res.json(MissionNextStepService.propose(req.organizationId!, String(req.params.id), {
      avgTicket: b.avgTicket != null ? Number(b.avgTicket) : undefined,
      saleConversionRate: b.saleConversionRate != null ? Number(b.saleConversionRate) : undefined,
      contactConversionRate: b.contactConversionRate != null ? Number(b.contactConversionRate) : undefined,
      baseAvailable: b.baseAvailable != null ? Number(b.baseAvailable) : undefined,
      leadTimeDays: b.leadTimeDays != null ? Number(b.leadTimeDays) : undefined,
    }, actor(req)));
  } catch (e: any) { fail(res, e); }
});

/** Visão de execução da missão (ações governadas + contagens). Read-only. */
router.get("/:id/runtime", (req: AuthRequest, res): any => {
  try { res.json(MissionRuntimeService.runtime(req.organizationId!, String(req.params.id))); }
  catch (e: any) { fail(res, e); }
});

/** ADR-189 F6 — Checkpoint (planejado × realizado × tempo → on_track/at_risk/off_track). Read-only. */
router.get("/:id/checkpoint", (req: AuthRequest, res): any => {
  try {
    const asOf = typeof req.query?.asOf === "string" ? req.query.asOf : undefined;
    res.json(MissionCheckpointService.checkpoint(req.organizationId!, String(req.params.id), { asOf }));
  } catch (e: any) { fail(res, e); }
});

/** Propõe um REPLAN governado (nunca executa direto). */
router.post("/:id/replan", (req: AuthRequest, res): any => {
  try { res.json(MissionCheckpointService.proposeReplan(req.organizationId!, String(req.params.id), { reason: req.body?.reason, actor: actor(req) })); }
  catch (e: any) { fail(res, e); }
});

/** ADR-189 F10 — Debrief da missão (read-model). */
router.get("/:id/debrief", (req: AuthRequest, res): any => {
  try { res.json(MissionDebriefService.debrief(req.organizationId!, String(req.params.id))); }
  catch (e: any) { fail(res, e); }
});

/** Alimenta o motor único a partir da missão terminada (só achieved/failed; idempotente). */
router.post("/:id/learn", (req: AuthRequest, res): any => {
  try { res.json(MissionDebriefService.learn(req.organizationId!, String(req.params.id), actor(req))); }
  catch (e: any) { fail(res, e); }
});

/** Patch parcial do contrato (não muda status). */
router.patch("/:id", (req: AuthRequest, res): any => {
  try { res.json(MissionService.update(req.organizationId!, String(req.params.id), req.body || {}, actor(req))); }
  catch (e: any) { fail(res, e); }
});

/** Muda o status da missão. */
router.post("/:id/status", (req: AuthRequest, res): any => {
  try { res.json(MissionService.setStatus(req.organizationId!, String(req.params.id), String(req.body?.status || ""), actor(req))); }
  catch (e: any) { fail(res, e); }
});

/** Ajusta a autonomia (autopilot é recusado — shadow-first). */
router.post("/:id/autonomy", (req: AuthRequest, res): any => {
  try { res.json(MissionService.setAutonomy(req.organizationId!, String(req.params.id), String(req.body?.level || ""), actor(req))); }
  catch (e: any) { fail(res, e); }
});

/** Cancela (preserva histórico — nunca deleta). */
router.post("/:id/cancel", (req: AuthRequest, res): any => {
  try { res.json(MissionService.cancel(req.organizationId!, String(req.params.id), actor(req))); }
  catch (e: any) { fail(res, e); }
});

export default router;
