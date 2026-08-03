import { Router } from "express";
import { AuthRequest } from "../middleware/auth.js";
import { FalaTuService } from "../FalaTuService.js";

// FalaTu (ADR-151) — captura multimodal "Fala → Faz → Confere". Router
// INTEIRO montado atrás de `requireMasterAdmin` em server.ts (mesmo padrão de
// /api/admin e /api/radar-consultant): Fase 1 é exclusiva do operador da
// plataforma, então nenhuma checagem de papel acontece aqui dentro. Os dados
// continuam chaveados por (organization_id, user_id) do JWT — ver o porquê no
// header do FalaTuService. A rota valida FORMA; invariantes ficam no service.

const router = Router();

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

router.get("/entities", (req: AuthRequest, res): any => {
  res.json(FalaTuService.entities(req.organizationId!, actorId(req)));
});

router.get("/briefing", (req: AuthRequest, res): any => {
  res.json(FalaTuService.briefing(req.organizationId!, actorId(req)));
});

export default router;
