import { Router } from "express";
import { AuthRequest } from "../middleware/auth.js";
import { BusinessHealthService } from "../BusinessHealthService.js";
import { SurvivalIndexService } from "../SurvivalIndexService.js";
import { BusinessTutorService } from "../BusinessTutorService.js";
import { DecisionSimulatorService } from "../DecisionSimulatorService.js";
import { MessageProviderService } from "../MessageProviderService.js";
import { SkillOsObservabilityService } from "../SkillOsObservabilityService.js";
import db from "../db.js";
import { ChannelBindingService } from "../ChannelBindingService.js";
import { StoreSignalScopeService } from "../StoreSignalScopeService.js";

// Central de Saúde e Decisão (ADR-126) — síntese: status + 3 prioridades do dia.
// Rota core (não é módulo opcional): disponível em todas as verticais.
const router = Router();

// GET /api/health-center — status geral + frase-síntese + top-3 prioridades.
router.get("/", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const minCash = Number(req.query?.minCash) || 0;
  // Gerente de loja (admin COM loja): só os sinais da(s) loja(s) dele no "precisam de atenção".
  res.json(BusinessHealthService.overview(orgId, minCash, StoreSignalScopeService.hiddenFor(orgId, req.user)));
});

// GET /api/health-center/survival-index — placar 0-100 + faixa + composição + histórico.
router.get("/survival-index", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json(SurvivalIndexService.scoreWithHistory(orgId));
});

// POST /api/health-center/survival-index/snapshot — fecha o snapshot do mês.
router.post("/survival-index/snapshot", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json(SurvivalIndexService.snapshot(orgId));
});

// POST /api/health-center/apply — aplica uma prioridade → ação no Impact Ledger.
router.post("/apply", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const { source, title, impact, rationale, baselineShortfall } = req.body || {};
  const out = BusinessHealthService.apply(orgId, { source, title, impact: Number(impact) || 0, rationale, baselineShortfall: Number(baselineShortfall) || 0 }, req.user?.userId);
  if (!out.ok) return res.status(400).json(out);
  res.status(201).json(out);
});

// POST /api/health-center/simulate/hire — "posso contratar?" (ADR-133 Fatia 1).
router.post("/simulate/hire", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json(DecisionSimulatorService.hire(orgId, { monthlyCost: Number(req.body?.monthlyCost) || 0 }));
});

// POST /api/health-center/simulate/buy-stock — "posso comprar esse estoque?" (ADR-133 Fatia 2).
router.post("/simulate/buy-stock", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json(DecisionSimulatorService.buyStock(orgId, { amount: Number(req.body?.amount) || 0 }));
});

// POST /api/health-center/simulate/purchase-scenarios — ADR-204 F3.9: compra em 3 cenários (caixa + cobertura + reserva). SÓ ANÁLISE:
// não cria pedido, não paga, não fala com fornecedor. É dinheiro da empresa → só quem tem visão completa do negócio (§73).
router.post("/simulate/purchase-scenarios", async (req: AuthRequest, res): Promise<any> => {
  const orgId = req.organizationId;
  if (!orgId || !req.user) return res.status(401).json({ error: "Unauthorized" });
  try {
    const { ContextProjectionService } = await import("../ContextProjectionService.js");
    if (!ContextProjectionService.hasFullBusinessVisibility(orgId, req.user)) return res.status(403).json({ error: "A análise de compra mostra caixa e margem — é do gestor." });
    const { PurchaseScenarioService } = await import("../PurchaseScenarioService.js");
    const out = PurchaseScenarioService.analyze(orgId, { amount: req.body?.amount, minCash: req.body?.minCash, payInWeeks: req.body?.payInWeeks });
    res.status(out.ok ? 200 : 400).json(out);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ADR-205 F4.1 — ScenarioEngine: contrato único de simulação ("e se eu fizer isso?") sobre os simuladores existentes. SÓ ANÁLISE (executes:false), cenário ≠ previsão.
// Mostra caixa, margem e receita → só quem tem visão completa do negócio (§73). `kinds` é só o catálogo (sem número).
router.get("/simulate/scenario/kinds", async (req: AuthRequest, res): Promise<any> => {
  if (!req.organizationId || !req.user) return res.status(401).json({ error: "Unauthorized" });
  const { ScenarioEngine } = await import("../ScenarioEngine.js");
  res.json({ kinds: ScenarioEngine.kinds() });
});
router.post("/simulate/scenario", async (req: AuthRequest, res): Promise<any> => {
  const orgId = req.organizationId;
  if (!orgId || !req.user) return res.status(401).json({ error: "Unauthorized" });
  try {
    const { ContextProjectionService } = await import("../ContextProjectionService.js");
    if (!ContextProjectionService.hasFullBusinessVisibility(orgId, req.user)) return res.status(403).json({ error: "O cenário mostra caixa, margem e receita — é do gestor." });
    const { ScenarioEngine } = await import("../ScenarioEngine.js");
    const out = ScenarioEngine.run(orgId, String(req.body?.kind || ""), req.body?.inputs && typeof req.body.inputs === "object" ? req.body.inputs : {});
    res.status(out.ok ? 200 : 400).json(out);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ADR-205 F4.2 — decisões estratégicas (decisão → hipótese → resultado real). LER mostra caixa/margem → gestor (§73); ESCREVER é do dono/admin (decisão é humana, RN-F4-2).
const strat = async (req: AuthRequest, res: any, write: boolean) => {
  const orgId = req.organizationId;
  if (!orgId || !req.user) { res.status(401).json({ error: "Unauthorized" }); return null; }
  const { ContextProjectionService } = await import("../ContextProjectionService.js");
  if (!ContextProjectionService.hasFullBusinessVisibility(orgId, req.user)) { res.status(403).json({ error: "Decisão estratégica mostra números do negócio — é do gestor." }); return null; }
  if (write && !["owner", "admin"].includes(String(req.user.role || ""))) { res.status(403).json({ error: "Só o dono ou o administrador registra e decide." }); return null; }
  const { StrategicDecisionService } = await import("../StrategicDecisionService.js");
  return { orgId, S: StrategicDecisionService, actor: { userId: (req.user as any).userId || (req.user as any).id, role: String(req.user.role || "") } };
};
const stratFail = (res: any, e: any) => res.status(e?.code === "not_found" ? 404 : e?.code ? (e.code === "forbidden" ? 403 : 400) : 500).json({ error: e?.message || "Erro", code: e?.code });
router.get("/strategic/decisions", async (req: AuthRequest, res): Promise<any> => { try { const c = await strat(req, res, false); if (!c) return; res.json({ decisions: c.S.list(c.orgId, { status: req.query.status ? String(req.query.status) : undefined, category: req.query.category ? String(req.query.category) : undefined }) }); } catch (e) { stratFail(res, e); } });
router.get("/strategic/calibration", async (req: AuthRequest, res): Promise<any> => { try { const c = await strat(req, res, false); if (!c) return; res.json(c.S.calibration(c.orgId)); } catch (e) { stratFail(res, e); } });
router.get("/strategic/principles", async (req: AuthRequest, res): Promise<any> => { try { const c = await strat(req, res, false); if (!c) return; res.json({ principles: c.S.principles(c.orgId) }); } catch (e) { stratFail(res, e); } });
router.get("/strategic/due", async (req: AuthRequest, res): Promise<any> => { try { const c = await strat(req, res, false); if (!c) return; res.json({ due: c.S.due(c.orgId) }); } catch (e) { stratFail(res, e); } });
router.get("/strategic/decisions/:id", async (req: AuthRequest, res): Promise<any> => { try { const c = await strat(req, res, false); if (!c) return; const d = c.S.get(c.orgId, String(req.params.id)); d ? res.json(d) : res.status(404).json({ error: "Decisão não encontrada." }); } catch (e) { stratFail(res, e); } });
router.post("/strategic/decisions", async (req: AuthRequest, res): Promise<any> => { try { const c = await strat(req, res, true); if (!c) return; res.status(201).json(c.S.register(c.orgId, c.actor, req.body || {})); } catch (e) { stratFail(res, e); } });
router.post("/strategic/decisions/:id/decide", async (req: AuthRequest, res): Promise<any> => { try { const c = await strat(req, res, true); if (!c) return; res.json(c.S.decide(c.orgId, String(req.params.id), c.actor, req.body || {})); } catch (e) { stratFail(res, e); } });
router.post("/strategic/decisions/:id/revoke", async (req: AuthRequest, res): Promise<any> => { try { const c = await strat(req, res, true); if (!c) return; res.json(c.S.revoke(c.orgId, String(req.params.id), c.actor, req.body?.reason)); } catch (e) { stratFail(res, e); } });
router.post("/strategic/decisions/:id/revisit", async (req: AuthRequest, res): Promise<any> => { try { const c = await strat(req, res, true); if (!c) return; res.json(c.S.revisit(c.orgId, String(req.params.id), c.actor, req.body || {})); } catch (e) { stratFail(res, e); } });
router.post("/strategic/decisions/:id/outcome", async (req: AuthRequest, res): Promise<any> => { try { const c = await strat(req, res, true); if (!c) return; res.status(201).json(c.S.recordOutcome(c.orgId, String(req.params.id), c.actor, req.body || {})); } catch (e) { stratFail(res, e); } });

// POST /api/health-center/simulate/withdraw — "posso retirar mais?" (ADR-133 Fatia 3).
router.post("/simulate/withdraw", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json(DecisionSimulatorService.withdraw(orgId, { amount: Number(req.body?.amount) || 0 }));
});

// POST /api/health-center/simulate/payback — "quanto vender p/ pagar?" (ADR-133 Fatia 4).
router.post("/simulate/payback", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json(DecisionSimulatorService.payback(orgId, { amount: Number(req.body?.amount) || 0, months: Number(req.body?.months) || 12 }));
});

// GET /api/health-center/tutor — config do Tutor no WhatsApp + prévia do resumo.
router.get("/tutor", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const s = db.prepare("SELECT tutor_wa_enabled, tutor_wa_phone, tutor_wa_last_morning FROM organization_settings WHERE organization_id = ?").get(orgId) as any || {};
  const hasChannel = !!db.prepare(`SELECT 1 FROM channels WHERE organization_id = ? AND status != 'disabled' LIMIT 1`).get(orgId);
  res.json({
    enabled: !!Number(s.tutor_wa_enabled),
    phone: s.tutor_wa_phone || "",
    ownerPhoneFallback: BusinessTutorService.ownerPhone(orgId),
    lastMorning: s.tutor_wa_last_morning || null,
    hasChannel,
    preview: BusinessTutorService.morningBrief(orgId).text,
    previewMidday: BusinessTutorService.middayBrief(orgId).text || null,
    previewEvening: BusinessTutorService.eveningBrief(orgId).text,
  });
});

// PUT /api/health-center/tutor — liga/desliga e define o número do dono.
router.put("/tutor", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const enabled = req.body?.enabled ? 1 : 0;
  const phone = String(req.body?.phone || "").replace(/\D/g, "") || null;
  db.prepare("UPDATE organization_settings SET tutor_wa_enabled = ?, tutor_wa_phone = ? WHERE organization_id = ?").run(enabled, phone, orgId);
  res.json({ ok: true, enabled: !!enabled, phone: phone || "" });
});

// POST /api/health-center/tutor/test — envia o resumo agora (ignora janela/dedupe).
// try/catch obrigatório: o envio pelo provider (Evolution/WhatsApp) pode LANÇAR
// (canal fora do ar, número recusado). Sem o catch, a exceção subia pro handler
// de erro e voltava HTML — o front fazia `r.json()` e explodia com
// "Unexpected token '<'". Aqui a falha SEMPRE volta como JSON legível.
router.post("/tutor/test", async (req: AuthRequest, res): Promise<any> => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const channel = ChannelBindingService.selectOutboundChannel(orgId, "gestao");
    if (!channel) return res.status(400).json({ error: "Conecte um canal de WhatsApp primeiro." });
    const out = await BusinessTutorService.sendNow(orgId, { send: (target, message) => MessageProviderService.sendMessage(channel.id, target, message) });
    if (!out.ok) return res.status(400).json({ error: out.error });
    res.json({ ok: true, phone: out.phone });
  } catch (e: any) {
    return res.status(502).json({ error: `Não foi possível enviar pelo WhatsApp agora: ${String(e?.message || e).slice(0, 180)}` });
  }
});

// GET /api/health-center/ai-runs — observabilidade OPERACIONAL das AI Runs do tenant
// (PRD 4 F9, §17): status/fallback/grounding/validação/confiança + saúde de provider.
// §30-safe por construção E por guarda em runtime (assertTenantSafe) — NUNCA custo
// (R$/US$). O custo financeiro vive só em /api/admin/ai-usage (requireMasterAdmin).
router.get("/ai-runs", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json(SkillOsObservabilityService.aiRuns(orgId, Number(req.query?.days)));
});

export default router;
