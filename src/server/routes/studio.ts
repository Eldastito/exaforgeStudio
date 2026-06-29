import { Router } from "express";
import { AuthRequest } from "../middleware/auth.js";
import { StudioService } from "../StudioService.js";
import { InstagramService } from "../InstagramService.js";

const router = Router();

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

// POST /api/studio/instagram/caption { prompt } — sugere uma legenda com IA
router.post("/instagram/caption", async (req: AuthRequest, res): Promise<any> => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const caption = await StudioService.suggestCaption(orgId, String(req.body?.prompt || "").trim());
    res.json({ caption });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
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
