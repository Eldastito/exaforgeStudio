import { Router, Request, Response, NextFunction } from "express";
import multer from "multer";
import db from "../db.js";
import { FashionStudioService } from "../FashionStudioService.js";
import { FashionCustomerService } from "../FashionCustomerService.js";
import { FashionAvatarService } from "../FashionAvatarService.js";
import { FashionLookService } from "../FashionLookService.js";
import { FashionTryOnService } from "../FashionTryOnService.js";

// ============================================================================
// PROVADOR VIRTUAL — rotas públicas do cliente final (FAS-1, ADR-035).
// Montadas em /api/public/fashion, ANTES do middleware de auth do staff.
// Autenticação própria: JWT de cliente com segredo DERIVADO (ver
// FashionCustomerService) — um token daqui NUNCA passa no requireAuth do
// painel, e um token do painel nunca passa aqui.
// ============================================================================

const router = Router();

interface FashionRequest extends Request {
  fashionCustomerId?: string;
  fashionOrgId?: string;
}

// Rate limit simples em memória (mesmo padrão de radarPublic/products):
// registro/login são a superfície de força-bruta — 20/h por IP basta para
// humanos e trava scripts.
const buckets = new Map<string, { count: number; resetTime: number }>();
function rateLimited(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now > b.resetTime) b = { count: 0, resetTime: now + windowMs };
  b.count++;
  buckets.set(key, b);
  return b.count > max;
}
const ipOf = (req: Request) => String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown").split(",")[0].trim();

// Resolve a loja pelo slug e exige o módulo LIGADO (mesma resposta 404 do
// FAS-0 quando desligado — não revela que o recurso existe).
function resolveEnabledStore(slug: string): { orgId: string } | null {
  const store = db.prepare(`SELECT organization_id FROM storefront_settings WHERE slug = ? AND published = 1`).get(slug) as any;
  if (!store) return null;
  if (!FashionStudioService.isEnabled(store.organization_id)) return null;
  return { orgId: store.organization_id };
}

// Auth do cliente do provador (Bearer token próprio).
function requireCustomer(req: FashionRequest, res: Response, next: NextFunction): any {
  const token = (req.headers.authorization || "").split(" ")[1] || "";
  const verified = FashionCustomerService.verifyToken(token);
  if (!verified) return res.status(401).json({ error: "Sessão inválida ou expirada. Entre novamente." });
  // O módulo pode ter sido desligado depois do login (kill switch, RF-035).
  if (!FashionStudioService.isEnabled(verified.organizationId)) return res.status(404).json({ error: "Recurso não disponível." });
  req.fashionCustomerId = verified.customerId;
  req.fashionOrgId = verified.organizationId;
  next();
}

const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }, // RF-007: padrão 15 MB
  fileFilter: (_req, file, cb) => {
    if (["image/jpeg", "image/jpg", "image/png", "image/webp"].includes(file.mimetype)) return cb(null, true);
    if (file.mimetype === "image/heic" || file.mimetype === "image/heif") {
      // Mesma limitação real do sharp documentada na ADR-020 — recusa clara em
      // vez de aceitar e falhar em silêncio.
      return cb(new Error("Fotos em HEIC (padrão do iPhone) ainda não são suportadas. No iPhone: Ajustes > Câmera > Formatos > \"Mais Compatível\"."));
    }
    cb(new Error("Formato não suportado (use JPG, PNG ou WEBP)."));
  },
});

// ---- conta ----

// POST /api/public/fashion/store/:slug/register
router.post("/store/:slug/register", (req, res): any => {
  const store = resolveEnabledStore(req.params.slug);
  if (!store) return res.status(404).json({ error: "Recurso não disponível." });
  if (rateLimited(`fashion_reg:${ipOf(req)}`, 20, 60 * 60 * 1000)) return res.status(429).json({ error: "Muitas tentativas. Aguarde um pouco." });
  const { name, email, phone, password, birthDate } = req.body || {};
  const result = FashionCustomerService.register(store.orgId, { name, email, phone, password, birthDate });
  if (!result.ok) return res.status(400).json({ error: (result as any).error });
  res.status(201).json({ token: result.token });
});

// POST /api/public/fashion/store/:slug/login
router.post("/store/:slug/login", (req, res): any => {
  const store = resolveEnabledStore(req.params.slug);
  if (!store) return res.status(404).json({ error: "Recurso não disponível." });
  if (rateLimited(`fashion_login:${ipOf(req)}`, 20, 60 * 60 * 1000)) return res.status(429).json({ error: "Muitas tentativas. Aguarde um pouco." });
  const { email, password } = req.body || {};
  const result = FashionCustomerService.login(store.orgId, email, password);
  if (!result.ok) return res.status(401).json({ error: (result as any).error });
  res.json({ token: result.token, name: result.name });
});

// GET /api/public/fashion/me — conta + consentimentos ativos + avatares
router.get("/me", requireCustomer, (req: FashionRequest, res): any => {
  const orgId = req.fashionOrgId!, customerId = req.fashionCustomerId!;
  const customer = FashionCustomerService.getCustomer(orgId, customerId);
  if (!customer) return res.status(404).json({ error: "Conta não encontrada." });
  const avatarConsent = FashionAvatarService.activeConsent(orgId, customerId, "avatar_processing");
  res.json({
    name: customer.name,
    email: customer.email,
    consents: { avatar_processing: !!avatarConsent },
    avatars: FashionAvatarService.listAvatars(orgId, customerId),
    retentionDays: FashionAvatarService.retentionDays(orgId),
  });
});

// DELETE /api/public/fashion/me — apaga TUDO (RF-004/11.4)
router.delete("/me", requireCustomer, (req: FashionRequest, res): any => {
  FashionAvatarService.deleteAllCustomerData(req.fashionOrgId!, req.fashionCustomerId!);
  res.json({ ok: true });
});

// ---- consentimento ----

// POST /api/public/fashion/consents  { type, policyVersion }
router.post("/consents", requireCustomer, (req: FashionRequest, res): any => {
  const type = String(req.body?.type || "");
  if (!["avatar_processing", "personalization", "whatsapp_notification", "guardian_approval"].includes(type)) {
    return res.status(400).json({ error: "Tipo de consentimento inválido." });
  }
  FashionAvatarService.grantConsent(req.fashionOrgId!, req.fashionCustomerId!, type, String(req.body?.policyVersion || "v1"));
  res.status(201).json({ ok: true });
});

// DELETE /api/public/fashion/consents/:type — revogar (avatar_processing apaga as fotos na hora)
router.delete("/consents/:type", requireCustomer, (req: FashionRequest, res): any => {
  FashionAvatarService.revokeConsent(req.fashionOrgId!, req.fashionCustomerId!, req.params.type);
  res.json({ ok: true });
});

// ---- avatar ----

// POST /api/public/fashion/avatars (multipart, campo "file")
router.post("/avatars", requireCustomer, (req: FashionRequest, res): any => {
  if (rateLimited(`fashion_avatar:${req.fashionCustomerId}`, 10, 60 * 60 * 1000)) {
    return res.status(429).json({ error: "Muitos envios em pouco tempo. Aguarde um pouco." });
  }
  avatarUpload.single("file")(req as any, res as any, async (err: any) => {
    if (err) return res.status(400).json({ error: err.message || "Falha no upload." });
    const file = (req as any).file;
    if (!file) return res.status(400).json({ error: "Nenhuma imagem enviada." });
    try {
      const result = await FashionAvatarService.submitAvatar(req.fashionOrgId!, req.fashionCustomerId!, file.buffer);
      if (!result.ok) return res.status(400).json({ error: (result as any).error });
      res.status(201).json(result);
    } catch (e) {
      console.error("[Fashion] Falha no envio de avatar", e);
      res.status(500).json({ error: "Não foi possível processar sua foto agora. Tente novamente." });
    }
  });
});

// DELETE /api/public/fashion/avatars/:id
router.delete("/avatars/:id", requireCustomer, (req: FashionRequest, res): any => {
  const ok = FashionAvatarService.deleteAvatar(req.fashionOrgId!, req.fashionCustomerId!, req.params.id);
  if (!ok) return res.status(404).json({ error: "Foto não encontrada." });
  res.json({ ok: true });
});

// ---- consultora por ocasião + Look Builder (FAS-2, ADR-036) ----

// POST /api/public/fashion/look-requests — questionário -> até 3 looks
router.post("/look-requests", requireCustomer, async (req: FashionRequest, res): Promise<any> => {
  // Cada composição pode custar uma chamada de IA — limite generoso para
  // humanos, hostil para scripts (o limite de GERAÇÃO de imagem, 3/dia, é do
  // FAS-3; compor look é mais barato).
  if (rateLimited(`fashion_look:${req.fashionCustomerId}`, 20, 60 * 60 * 1000)) {
    return res.status(429).json({ error: "Muitos pedidos de look em pouco tempo. Aguarde um pouco." });
  }
  const b = req.body || {};
  const toList = (v: any) => Array.isArray(v) ? v.map((x: any) => String(x).trim()).filter(Boolean).slice(0, 10)
    : String(v || "").split(",").map((x) => x.trim()).filter(Boolean).slice(0, 10);
  try {
    const result = await FashionLookService.createRequestAndRecommend(req.fashionOrgId!, req.fashionCustomerId!, {
      occasion: b.occasion,
      dayNight: b.dayNight || null,
      style: b.style || null,
      colorsAvoid: toList(b.colorsAvoid),
      piecesAvoid: toList(b.piecesAvoid),
      budgetMax: b.budgetMax != null && b.budgetMax !== "" && Number(b.budgetMax) > 0 ? Number(b.budgetMax) : null,
    });
    if (!result.ok) return res.status(400).json({ error: (result as any).error });
    res.status(201).json(result);
  } catch (e) {
    console.error("[Fashion] Falha ao compor looks", e);
    res.status(500).json({ error: "Não foi possível montar seus looks agora. Tente novamente." });
  }
});

// GET /api/public/fashion/look-requests/:id — reabrir os looks de um pedido
router.get("/look-requests/:id", requireCustomer, (req: FashionRequest, res): any => {
  const data = FashionLookService.getRequestLooks(req.fashionOrgId!, req.fashionCustomerId!, req.params.id);
  if (!data) return res.status(404).json({ error: "Pedido de look não encontrado." });
  res.json(data);
});

// POST /api/public/fashion/looks/:id/save — salvar sem carrinho (RF-018)
router.post("/looks/:id/save", requireCustomer, (req: FashionRequest, res): any => {
  const ok = FashionLookService.saveLook(req.fashionOrgId!, req.fashionCustomerId!, req.params.id);
  if (!ok) return res.status(404).json({ error: "Look não encontrado." });
  res.json({ ok: true });
});

// POST /api/public/fashion/looks/:id/feedback — gostei / não gostei / não usaria (FAS-5, 11.2)
router.post("/looks/:id/feedback", requireCustomer, (req: FashionRequest, res): any => {
  const result = FashionLookService.recordLookFeedback(req.fashionOrgId!, req.fashionCustomerId!, req.params.id, String(req.body?.verdict || ""));
  if (!result.ok) return res.status(400).json({ error: (result as any).error });
  res.json({ ok: true });
});

// GET /api/public/fashion/profile — personalização + preferências (11.4)
router.get("/profile", requireCustomer, (req: FashionRequest, res): any => {
  res.json({
    personalizationEnabled: FashionLookService.personalizationEnabled(req.fashionOrgId!, req.fashionCustomerId!),
    preferences: FashionLookService.listPreferences(req.fashionOrgId!, req.fashionCustomerId!),
  });
});

// PATCH /api/public/fashion/profile — liga/desliga a personalização (11.4)
router.patch("/profile", requireCustomer, (req: FashionRequest, res): any => {
  if (req.body?.personalizationEnabled === undefined) return res.status(400).json({ error: "Nada para alterar." });
  FashionLookService.setPersonalization(req.fashionOrgId!, req.fashionCustomerId!, !!req.body.personalizationEnabled);
  res.json({ ok: true, personalizationEnabled: !!req.body.personalizationEnabled });
});

// GET /api/public/fashion/profile/preferences — a cliente vê o que foi salvo (11.4)
router.get("/profile/preferences", requireCustomer, (req: FashionRequest, res): any => {
  res.json({ preferences: FashionLookService.listPreferences(req.fashionOrgId!, req.fashionCustomerId!) });
});

// DELETE /api/public/fashion/profile/preferences/:id — apagar uma preferência (11.4)
router.delete("/profile/preferences/:id", requireCustomer, (req: FashionRequest, res): any => {
  const ok = FashionLookService.deletePreference(req.fashionOrgId!, req.fashionCustomerId!, req.params.id);
  if (!ok) return res.status(404).json({ error: "Preferência não encontrada." });
  res.json({ ok: true });
});

// ---- carrinho do look + compartilhamento (FAS-4, ADR-038) ----

// POST /api/public/fashion/looks/:id/add-to-cart — revalidação transacional (seção 10)
router.post("/looks/:id/add-to-cart", requireCustomer, (req: FashionRequest, res): any => {
  const result = FashionLookService.prepareCart(req.fashionOrgId!, req.fashionCustomerId!, req.params.id);
  if (!result.ok) return res.status(404).json({ error: (result as any).error });
  res.json(result);
});

// POST /api/public/fashion/looks/:id/share — token HMAC com expiração de 7 dias (RF-028)
router.post("/looks/:id/share", requireCustomer, (req: FashionRequest, res): any => {
  const result = FashionLookService.shareLook(req.fashionOrgId!, req.fashionCustomerId!, req.params.id);
  if (!result.ok) return res.status(404).json({ error: (result as any).error });
  res.json({ token: (result as any).token });
});

// GET /api/public/fashion/shared-looks/:token — PÚBLICO (quem tem o link vê a
// composição do look: peças/preços atuais; NUNCA avatar/foto gerada — RF-029)
router.get("/shared-looks/:token", (req, res): any => {
  const look = FashionLookService.resolveSharedLook(req.params.token);
  if (!look) return res.status(404).json({ error: "Link expirado ou inválido." });
  res.json(look);
});

// ---- try-on: "look em você" (FAS-3, ADR-037) ----

// POST /api/public/fashion/looks/:id/generate — cria o job (créditos: limite diário da loja)
router.post("/looks/:id/generate", requireCustomer, (req: FashionRequest, res): any => {
  const result = FashionTryOnService.requestGeneration(req.fashionOrgId!, req.fashionCustomerId!, req.params.id);
  if (!result.ok) return res.status(400).json({ error: (result as any).error });
  res.status(201).json({ ...result, credits: FashionTryOnService.creditsAvailable(req.fashionOrgId!, req.fashionCustomerId!) });
});

// GET /api/public/fashion/tryon-jobs/:id — status + URL assinada quando pronto
router.get("/tryon-jobs/:id", requireCustomer, (req: FashionRequest, res): any => {
  const job = FashionTryOnService.getJob(req.fashionOrgId!, req.fashionCustomerId!, req.params.id);
  if (!job) return res.status(404).json({ error: "Prévia não encontrada." });
  res.json(job);
});

// POST /api/public/fashion/tryon-jobs/:id/cancel — só na fila; devolve o crédito (RF-024)
router.post("/tryon-jobs/:id/cancel", requireCustomer, (req: FashionRequest, res): any => {
  const ok = FashionTryOnService.cancelJob(req.fashionOrgId!, req.fashionCustomerId!, req.params.id);
  if (!ok) return res.status(400).json({ error: "Essa prévia já está sendo gerada e não pode mais ser cancelada." });
  res.json({ ok: true });
});

// ---- mídia privada (URL assinada — único caminho de leitura de avatar) ----

// GET /api/public/fashion/media/:key?exp=&sig=
router.get("/media/:key", (req, res): any => {
  const file = FashionAvatarService.resolveSignedFile(req.params.key, String(req.query.exp || ""), String(req.query.sig || ""));
  if (!file) return res.status(404).json({ error: "Link expirado ou inválido." });
  res.setHeader("Cache-Control", "private, no-store");
  res.sendFile(file);
});

export default router;
