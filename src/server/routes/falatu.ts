import { Router, Response, NextFunction } from "express";
import { AuthRequest } from "../middleware/auth.js";
import { MASTER_ADMIN_EMAIL } from "../config/secret.js";
import { FalaTuService } from "../FalaTuService.js";
import { FalaTuPurchaseService } from "../FalaTuPurchaseService.js";

// FalaTu (ADR-151) — captura multimodal "Fala → Faz → Confere". Fatia 2: o
// gate deixou de ser requireMasterAdmin e virou (a) flag opt-in da org
// (`falatu_enabled`, ligada pelo operador no Admin Master) via o middleware
// abaixo + (b) RBAC granular ADR-095 (módulo "falatu"), aplicado pelo
// enforceModulePermission global do protectedApi — não repetimos a checagem
// aqui (mesma razão de não validar em service + rota ao mesmo tempo). Os
// dados seguem chaveados por (organization_id, user_id) do JWT — ver o porquê
// no header do FalaTuService. A rota valida FORMA; invariantes ficam no service.

// Exportado pra ser testável sem subir o Express (scripts/test-falatu-rollout.ts).
// Master Admin entra sempre (operador da plataforma, mesmo racional do bypass
// no requirePermission); as demais orgs precisam da flag.
export const falatuGate = (req: AuthRequest, res: Response, next: NextFunction): any => {
  if (req.user?.email && req.user.email === MASTER_ADMIN_EMAIL) return next();
  if (!FalaTuService.orgEnabled(req.organizationId!)) {
    return res.status(403).json({ error: "FalaTu não está habilitado para esta organização." });
  }
  next();
};

const router = Router();
router.use(falatuGate);

const actorId = (req: any) => req.user?.userId || req.user?.id;

// Mídia inline em base64 dentro do JSON. O limite global do body é 2mb
// (server.ts), então ~1.4MB de mídia real — suficiente pra memos de voz e
// fotos comprimidas. Validamos aqui pra falhar com mensagem clara em vez do
// 413 genérico do body-parser.
const MAX_MEDIA_B64 = 1_900_000;

router.post("/capture", async (req: AuthRequest, res): Promise<any> => {
  const { text, audio, image, source } = req.body || {};
  if (text !== undefined && typeof text !== "string") return res.status(400).json({ error: "text deve ser string." });
  for (const [name, media] of [["audio", audio], ["image", image]] as const) {
    if (media === undefined) continue;
    if (typeof media?.mimeType !== "string" || typeof media?.data !== "string") {
      return res.status(400).json({ error: `${name} deve ter mimeType e data (base64).` });
    }
    if (media.data.length > MAX_MEDIA_B64) return res.status(400).json({ error: `${name} muito grande (máx ~1.4MB).` });
  }
  if (audio && image) return res.status(400).json({ error: "Envie áudio OU imagem, não ambos." });
  try {
    res.json(await FalaTuService.capture(req.organizationId!, actorId(req), { text, audio, image, source }));
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.get("/inbox", (req: AuthRequest, res): any => {
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  try { res.json(FalaTuService.listInbox(req.organizationId!, actorId(req), status)); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.post("/inbox/:id/confirm", (req: AuthRequest, res): any => {
  const { intent, title, eventDate, eventTime, listItems, listType } = req.body || {};
  if (listItems !== undefined && !Array.isArray(listItems)) return res.status(400).json({ error: "listItems deve ser array." });
  try { res.json(FalaTuService.confirm(req.organizationId!, actorId(req), req.params.id, { intent, title, eventDate, eventTime, listItems, listType })); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.post("/inbox/:id/discard", (req: AuthRequest, res): any => {
  try { res.json(FalaTuService.discard(req.organizationId!, actorId(req), req.params.id)); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.get("/tasks", (req: AuthRequest, res): any => {
  res.json(FalaTuService.tasks(req.organizationId!, actorId(req)));
});

router.post("/tasks/:id/toggle", (req: AuthRequest, res): any => {
  try { res.json(FalaTuService.toggleTask(req.organizationId!, actorId(req), req.params.id, !!req.body?.completed)); }
  catch (e: any) { res.status(404).json({ error: e.message }); }
});

router.get("/events", (req: AuthRequest, res): any => {
  res.json(FalaTuService.events(req.organizationId!, actorId(req)));
});

router.get("/lists", (req: AuthRequest, res): any => {
  res.json(FalaTuService.lists(req.organizationId!, actorId(req)));
});

router.get("/lists/:id/items", (req: AuthRequest, res): any => {
  try { res.json(FalaTuService.listItems(req.organizationId!, actorId(req), req.params.id)); }
  catch (e: any) { res.status(404).json({ error: e.message }); }
});

router.post("/list-items/:id/toggle", (req: AuthRequest, res): any => {
  try { res.json(FalaTuService.toggleListItem(req.organizationId!, actorId(req), req.params.id, !!req.body?.realized)); }
  catch (e: any) { res.status(404).json({ error: e.message }); }
});

// ── Compras com conferência (Fatia 4): lista planejada × nota fotografada ──

router.post("/lists/:id/purchase-check", async (req: AuthRequest, res): Promise<any> => {
  const { image } = req.body || {};
  if (typeof image?.mimeType !== "string" || typeof image?.data !== "string") {
    return res.status(400).json({ error: "image deve ter mimeType e data (base64)." });
  }
  if (image.data.length > MAX_MEDIA_B64) return res.status(400).json({ error: "image muito grande (máx ~1.4MB)." });
  try {
    res.json(await FalaTuPurchaseService.check(req.organizationId!, actorId(req), req.params.id, image));
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.get("/lists/:id/purchase-check", async (req: AuthRequest, res): Promise<any> => {
  res.json(FalaTuPurchaseService.latestForList(req.organizationId!, actorId(req), req.params.id));
});

router.post("/purchase-checks/:id/confirm", async (req: AuthRequest, res): Promise<any> => {
  const { listItemIds, addExtras } = req.body || {};
  if (listItemIds !== undefined && !Array.isArray(listItemIds)) return res.status(400).json({ error: "listItemIds deve ser array." });
  if (addExtras !== undefined && !Array.isArray(addExtras)) return res.status(400).json({ error: "addExtras deve ser array." });
  try {
    res.json(FalaTuPurchaseService.confirm(req.organizationId!, actorId(req), req.params.id, { listItemIds, addExtras }));
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.post("/purchase-checks/:id/discard", async (req: AuthRequest, res): Promise<any> => {
  try {
    res.json(FalaTuPurchaseService.discard(req.organizationId!, actorId(req), req.params.id));
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.get("/entities", (req: AuthRequest, res): any => {
  res.json(FalaTuService.entities(req.organizationId!, actorId(req)));
});

router.get("/briefing", (req: AuthRequest, res): any => {
  res.json(FalaTuService.briefing(req.organizationId!, actorId(req)));
});

export default router;
