import { Router } from "express";
import { AuthRequest } from "../middleware/auth.js";
import { StudioService, CAMPAIGN_OBJECTIVES } from "../StudioService.js";
import { InstagramService } from "../InstagramService.js";
import { BrandDnaService, BrandDnaPatch } from "../BrandDnaService.js";
import { CampaignObjectiveContractService } from "../CampaignObjectiveContractService.js";
import { HookIntelligenceService } from "../HookIntelligenceService.js";
import { ScriptIntelligenceService } from "../ScriptIntelligenceService.js";
import { ChannelAdaptationService } from "../ChannelAdaptationService.js";
import { StudioVisualRecipeService, VisualRecipeError } from "../StudioVisualRecipeService.js";

const router = Router();

// ── Visual Recipes (ADR-194 F1) — catálogo + resolver + prompt plan ──

// GET /api/studio/recipes — lista active versions de todos os recipes
router.get("/recipes", (req: AuthRequest, res): any => {
  if (!req.organizationId) return res.status(401).json({ error: "Unauthorized" });
  try {
    res.json({ recipes: StudioVisualRecipeService.list() });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "internal_error" });
  }
});

// GET /api/studio/recipes/:key — 1 recipe por key OU alias (case-insensitive)
router.get("/recipes/:key", (req: AuthRequest, res): any => {
  if (!req.organizationId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const recipe = StudioVisualRecipeService.get(req.params.key);
    if (!recipe) return res.status(404).json({ error: "not_found" });
    res.json(recipe);
  } catch (e: any) {
    if (e instanceof VisualRecipeError) return res.status(400).json({ error: e.message, code: e.code });
    res.status(500).json({ error: e?.message || "internal_error" });
  }
});

// POST /api/studio/recipes/plan { recipe: 'KEY_OR_ALIAS', inputs?: {...}, format: 'feed_1_1' }
router.post("/recipes/plan", (req: AuthRequest, res): any => {
  if (!req.organizationId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const b = req.body || {};
    if (!b.recipe) return res.status(400).json({ error: "recipe é obrigatório" });
    if (!b.format) return res.status(400).json({ error: "format é obrigatório" });
    const plan = StudioVisualRecipeService.buildPromptPlan({
      recipe_key_or_alias: String(b.recipe),
      inputs: b.inputs || {},
      format: b.format,
    });
    res.json(plan);
  } catch (e: any) {
    if (e instanceof VisualRecipeError) {
      const s = e.code === "recipe_not_found" ? 404 : 400;
      return res.status(s).json({ error: e.message, code: e.code });
    }
    res.status(500).json({ error: e?.message || "internal_error" });
  }
});

// POST /api/studio/recipes/generate — F2. Executa geração via provider real
// (Gemini/OpenAI). Gate de plano continua com PlanService.studioAllowed
// (mesmo do /api/studio/generate). brand_hint opcional carrega contexto de
// marca (paleta, tom, nome). Retorna id + mediaUrl + prompt marcado.
router.post("/recipes/generate", async (req: AuthRequest, res): Promise<any> => {
  if (!req.organizationId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const b = req.body || {};
    if (!b.recipe) return res.status(400).json({ error: "recipe é obrigatório" });
    if (!b.format) return res.status(400).json({ error: "format é obrigatório" });

    // Gate de plano — reusa a mesma política do StudioService.generateImage.
    // Import dinâmico pra evitar ciclo com PlanService.
    const { PlanService } = await import("../PlanService.js");
    const gate = PlanService.studioAllowed(req.organizationId, "image");
    if (!gate.allowed) {
      const msg = gate.reason === "monthly_limit"
        ? `Limite de imagens do plano atingido (${gate.used}/${gate.limit} este mês).`
        : gate.reason === "plan_no_studio"
          ? "Seu plano não inclui geração no Estúdio."
          : "Geração indisponível no momento.";
      return res.status(402).json({ error: msg, code: gate.reason });
    }

    const result = await StudioVisualRecipeService.generate({
      orgId: req.organizationId,
      recipe_key_or_alias: String(b.recipe),
      inputs: b.inputs || {},
      format: b.format,
      brand_hint: b.brand_hint ? String(b.brand_hint) : undefined,
    });
    res.json(result);
  } catch (e: any) {
    if (e instanceof VisualRecipeError) {
      const s = e.code === "recipe_not_found" ? 404
        : e.code === "provider_empty" ? 502
        : 400;
      return res.status(s).json({ error: e.message, code: e.code });
    }
    res.status(500).json({ error: e?.message || "internal_error" });
  }
});

// ── Channel Adaptation (PRD 11 / ADR-168 F5) — reescreve o conteúdo por canal ──

// GET /api/studio/channels — normas dos canais suportados
router.get("/channels", (req: AuthRequest, res): any => {
  if (!req.organizationId) return res.status(401).json({ error: "Unauthorized" });
  res.json({ channels: ChannelAdaptationService.channels() });
});

// POST /api/studio/channel-adaptation { caption, hook?, format?, hashtags?, channels:[...] }
router.post("/channel-adaptation", (req: AuthRequest, res): any => {
  if (!req.organizationId) return res.status(401).json({ error: "Unauthorized" });
  const caption = String(req.body?.caption || "").trim();
  if (!caption) return res.status(400).json({ error: "Informe a legenda base." });
  const channels = Array.isArray(req.body?.channels) ? req.body.channels.map((c: any) => String(c)) : [];
  if (!channels.length) return res.status(400).json({ error: "Informe pelo menos um canal." });
  const base = {
    caption,
    hook: req.body?.hook ? String(req.body.hook) : null,
    format: req.body?.format ? String(req.body.format) : null,
    hashtags: Array.isArray(req.body?.hashtags) ? req.body.hashtags.map((h: any) => String(h)) : [],
  };
  res.json(ChannelAdaptationService.adaptMany(base, channels));
});

// ── Script Intelligence (PRD 11 / ADR-168 F4) — roteiro/storyboard de vídeo grounded ──

// POST /api/studio/script { topic, objectiveId?, format? }
router.post("/script", async (req: AuthRequest, res): Promise<any> => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const topic = String(req.body?.topic || "").trim();
  if (!topic) return res.status(400).json({ error: "Descreva o tópico do vídeo." });
  try {
    const out = await ScriptIntelligenceService.generate(orgId, {
      topic,
      objectiveId: req.body?.objectiveId ? String(req.body.objectiveId) : null,
      format: req.body?.format ? String(req.body.format) as any : undefined,
    });
    res.json(out);
  } catch (e: any) { res.status(400).json({ error: e.message || "Falha ao gerar o roteiro." }); }
});

// ── Hook Intelligence (PRD 11 / ADR-168 F3) — ganchos de abertura grounded ──

// POST /api/studio/hooks { topic, objectiveId?, count? }
router.post("/hooks", async (req: AuthRequest, res): Promise<any> => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const topic = String(req.body?.topic || "").trim();
  if (!topic) return res.status(400).json({ error: "Descreva o tópico do conteúdo." });
  try {
    const out = await HookIntelligenceService.generate(orgId, {
      topic,
      objectiveId: req.body?.objectiveId ? String(req.body.objectiveId) : null,
      count: req.body?.count !== undefined ? Number(req.body.count) : undefined,
    });
    res.json(out);
  } catch (e: any) { res.status(400).json({ error: e.message || "Falha ao gerar ganchos." }); }
});

// ── Campaign Objective Contract (PRD 11 / ADR-168 F2) — objetivo ligado a meta de negócio ──

// GET /api/studio/campaign-objectives — catálogo enriquecido (com métrica de negócio sugerida)
router.get("/campaign-objectives", (req: AuthRequest, res): any => {
  if (!req.organizationId) return res.status(401).json({ error: "Unauthorized" });
  res.json({ objectives: CampaignObjectiveContractService.objectives() });
});

// POST /api/studio/campaign-contracts { objectiveId, goalMetric?, title? }
router.post("/campaign-contracts", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const objectiveId = String(req.body?.objectiveId || "").trim();
  if (!objectiveId) return res.status(400).json({ error: "Informe o objetivo da campanha." });
  const input: { objectiveId: string; goalMetric?: string | null; title?: string | null } = { objectiveId };
  if (req.body?.goalMetric !== undefined) input.goalMetric = req.body.goalMetric === null ? null : String(req.body.goalMetric);
  if (req.body?.title !== undefined) input.title = req.body.title === null ? null : String(req.body.title);
  try { res.json(CampaignObjectiveContractService.create(orgId, req.user?.userId || null, input)); }
  catch (e: any) { res.status(400).json({ error: e.message || "Falha ao criar o contrato." }); }
});

// GET /api/studio/campaign-contracts?status=active
router.get("/campaign-contracts", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const status = req.query?.status ? String(req.query.status) : undefined;
  res.json({ contracts: CampaignObjectiveContractService.list(orgId, status ? { status: status as any } : undefined) });
});

// GET /api/studio/campaign-contracts/:id
router.get("/campaign-contracts/:id", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const c = CampaignObjectiveContractService.get(orgId, req.params.id);
  if (!c) return res.status(404).json({ error: "Contrato não encontrado." });
  res.json(c);
});

// GET /api/studio/campaign-contracts/:id/progress — distância-à-meta do contrato
router.get("/campaign-contracts/:id/progress", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const p = CampaignObjectiveContractService.progress(orgId, req.params.id);
  if (!p) return res.status(404).json({ error: "Contrato não encontrado." });
  res.json(p);
});

// POST /api/studio/campaign-contracts/:id/cancel
router.post("/campaign-contracts/:id/cancel", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const ok = CampaignObjectiveContractService.cancel(orgId, req.params.id);
  res.json({ canceled: ok });
});

// ── Brand DNA 2.0 (PRD 11 / ADR-168 F1) — identidade estruturada + unificada + versionada ──

// GET /api/studio/brand-dna — leitura unificada (visual + voz + estruturado + completeness)
router.get("/brand-dna", async (req: AuthRequest, res): Promise<any> => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(await BrandDnaService.get(orgId)); }
  catch (e: any) { res.status(500).json({ error: e.message || "Falha ao ler o Brand DNA." }); }
});

// PUT /api/studio/brand-dna — grava patch parcial (nunca inventa), sobe versão + snapshot
router.put("/brand-dna", async (req: AuthRequest, res): Promise<any> => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const b = req.body || {};
  // Só repassa chaves reconhecidas (a rota valida FORMA; o service valida invariante).
  const patch: BrandDnaPatch = {};
  for (const k of ["tone", "style", "summary", "voice", "persona", "audience", "positioning"] as const) {
    if (b[k] !== undefined) (patch as any)[k] = b[k] === null ? null : String(b[k]);
  }
  if (b.voiceEnabled !== undefined) patch.voiceEnabled = !!b.voiceEnabled;
  for (const k of ["palette", "forbidden", "doExamples", "dontExamples"] as const) {
    if (b[k] !== undefined) (patch as any)[k] = Array.isArray(b[k]) ? b[k].map((x: any) => String(x)) : [];
  }
  if (Object.keys(patch).length === 0) return res.status(400).json({ error: "Nada para atualizar." });
  try { res.json(await BrandDnaService.save(orgId, req.user?.userId || null, patch)); }
  catch (e: any) { res.status(400).json({ error: e.message || "Falha ao salvar o Brand DNA." }); }
});

// GET /api/studio/brand-dna/versions — histórico de versões (metadados)
router.get("/brand-dna/versions", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json({ versions: BrandDnaService.versions(orgId) });
});

// GET /api/studio/brand-dna/versions/:version — snapshot congelado de uma versão
router.get("/brand-dna/versions/:version", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const v = Number(req.params.version);
  if (!Number.isInteger(v) || v < 1) return res.status(400).json({ error: "Versão inválida." });
  const snap = BrandDnaService.snapshot(orgId, v);
  if (!snap) return res.status(404).json({ error: "Versão não encontrada." });
  res.json(snap);
});

// POST /api/studio/brand-dna/restore/:version — restaura (como nova versão)
router.post("/brand-dna/restore/:version", async (req: AuthRequest, res): Promise<any> => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const v = Number(req.params.version);
  if (!Number.isInteger(v) || v < 1) return res.status(400).json({ error: "Versão inválida." });
  try { res.json(await BrandDnaService.restore(orgId, req.user?.userId || null, v)); }
  catch (e: any) { res.status(404).json({ error: e.message || "Falha ao restaurar." }); }
});

// GET /api/studio/brand — identidade visual atual da empresa
router.get("/brand", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json(StudioService.getBrand(orgId) || { palette: [], tone: "", style: "", summary: "" });
});

// POST /api/studio/brand/analyze { images: [{ base64, mime }] }
router.post("/brand/analyze", async (req: AuthRequest, res): Promise<any> => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const images = Array.isArray(req.body?.images) ? req.body.images : [];
  if (!images.length) return res.status(400).json({ error: "Envie de 1 a 5 imagens de referência." });
  try {
    const profile = await StudioService.analyzeBrand(orgId, images);
    res.json(profile);
  } catch (e: any) {
    res.status(500).json({ error: e.message || "Falha ao analisar a identidade." });
  }
});

// POST /api/studio/generate { prompt, format }
router.post("/generate", async (req: AuthRequest, res): Promise<any> => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const briefing = String(req.body?.prompt || "").trim();
  const format = (["post", "story", "banner"].includes(req.body?.format) ? req.body.format : "post");
  if (!briefing) return res.status(400).json({ error: "Descreva o que você quer criar." });
  try {
    const out = await StudioService.generate(orgId, briefing, format);
    res.json(out);
  } catch (e: any) {
    res.status(500).json({ error: e.message || "Falha ao gerar a imagem." });
  }
});

// POST /api/studio/video { prompt, format } — inicia a geração de vídeo (Veo)
router.post("/video", async (req: AuthRequest, res): Promise<any> => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const briefing = String(req.body?.prompt || "").trim();
  const format = (["post", "story", "banner"].includes(req.body?.format) ? req.body.format : "story");
  if (!briefing) return res.status(400).json({ error: "Descreva o vídeo que você quer criar." });
  try {
    const out = await StudioService.startVideo(orgId, briefing, format);
    res.json(out);
  } catch (e: any) {
    res.status(500).json({ error: e.message || "Falha ao iniciar o vídeo." });
  }
});

// GET /api/studio/video/:jobId — andamento/resultado do vídeo
router.get("/video/:jobId", async (req: AuthRequest, res): Promise<any> => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const out = await StudioService.pollVideo(orgId, req.params.jobId);
    res.json(out);
  } catch (e: any) {
    res.status(500).json({ error: e.message || "Falha ao consultar o vídeo." });
  }
});

// GET /api/studio/creations — galeria das criações
router.get("/creations", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json(StudioService.listCreations(orgId));
});

// GET /api/studio/instagram/status — conta de Instagram conectada?
router.get("/instagram/status", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const ch = InstagramService.getChannel(orgId);
  res.json({ connected: !!ch, username: ch?.username || "" });
});

// POST /api/studio/instagram/analyze — lê o feed, capta a identidade e o que performa
router.post("/instagram/analyze", async (req: AuthRequest, res): Promise<any> => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const out = await InstagramService.analyzeAccount(orgId);
    if (!out.connected) return res.status(400).json({ error: "Instagram não conectado. Conecte em Canais e I.A." });
    res.json(out);
  } catch (e: any) {
    res.status(500).json({ error: e.message || "Falha ao analisar o Instagram." });
  }
});

// GET /api/studio/objectives — objetivos de campanha disponíveis
router.get("/objectives", (_req: AuthRequest, res): any => {
  res.json(CAMPAIGN_OBJECTIVES.map(o => ({ id: o.id, label: o.label })));
});

// POST /api/studio/instagram/caption { prompt, objective } — sugere uma legenda com IA
router.post("/instagram/caption", async (req: AuthRequest, res): Promise<any> => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const caption = await StudioService.suggestCaption(orgId, String(req.body?.prompt || "").trim(), req.body?.objective);
    res.json({ caption });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// POST /api/studio/schedule { creationId, objective, caption, scheduledAt } — agenda a publicação
router.post("/schedule", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const { creationId, objective, caption, scheduledAt } = req.body || {};
  if (!creationId || !scheduledAt) return res.status(400).json({ error: "Informe a criação e a data/hora." });
  try {
    const out = StudioService.schedulePost(orgId, { creationId: String(creationId), objective, caption, scheduledAt: String(scheduledAt) });
    res.json({ success: true, ...out });
  } catch (e: any) {
    res.status(400).json({ error: e.message || "Falha ao agendar." });
  }
});

// GET /api/studio/scheduled — posts agendados/recentes
router.get("/scheduled", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json(StudioService.listScheduled(orgId));
});

// DELETE /api/studio/scheduled/:id — cancela um agendamento ainda não publicado
router.delete("/scheduled/:id", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const ok = StudioService.cancelScheduled(orgId, String(req.params.id));
  if (!ok) return res.status(400).json({ error: "Agendamento não encontrado ou já publicado." });
  res.json({ success: true });
});

// POST /api/studio/instagram/publish { creationId, caption } — publica no Instagram
router.post("/instagram/publish", async (req: AuthRequest, res): Promise<any> => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const { creationId, caption } = req.body || {};
  const creation = creationId ? StudioService.getCreation(orgId, String(creationId)) : null;
  if (!creation || !creation.media_url) return res.status(400).json({ error: "Criação não encontrada." });
  try {
    const out = await InstagramService.publish(orgId, creation.media_url, String(caption || ""), creation.kind === "video");
    StudioService.markPosted(orgId, String(creationId), out.mediaId);
    res.json({ success: true, ...out });
  } catch (e: any) {
    res.status(500).json({ error: e.message || "Falha ao publicar no Instagram." });
  }
});

// GET /api/studio/limits — uso vs limite do plano (imagens/vídeos no mês)
router.get("/limits", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json(StudioService.limits(orgId));
});

export default router;
