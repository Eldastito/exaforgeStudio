import { Router, Response, NextFunction } from "express";
import db from "../db.js";
import { AuthRequest } from "../middleware/auth.js";
import { MASTER_ADMIN_EMAIL } from "../config/secret.js";
import { FalaTuService } from "../FalaTuService.js";
import { FalaTuCaptureTokenService } from "../FalaTuCaptureTokenService.js";
import { FalaTuPurchaseService } from "../FalaTuPurchaseService.js";
import { FalaTuBriefingTaskService } from "../FalaTuBriefingTaskService.js";
import { FalaTuBriefingDigestService } from "../FalaTuBriefingDigestService.js";
import { MessageProviderService } from "../MessageProviderService.js";

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
  const { text, audio, image, source, commandId } = req.body || {};
  if (text !== undefined && typeof text !== "string") return res.status(400).json({ error: "text deve ser string." });
  if (commandId !== undefined && typeof commandId !== "string") return res.status(400).json({ error: "commandId deve ser string." });
  for (const [name, media] of [["audio", audio], ["image", image]] as const) {
    if (media === undefined) continue;
    if (typeof media?.mimeType !== "string" || typeof media?.data !== "string") {
      return res.status(400).json({ error: `${name} deve ter mimeType e data (base64).` });
    }
    if (media.data.length > MAX_MEDIA_B64) return res.status(400).json({ error: `${name} muito grande (máx ~1.4MB).` });
  }
  if (audio && image) return res.status(400).json({ error: "Envie áudio OU imagem, não ambos." });
  try {
    res.json(await FalaTuService.capture(req.organizationId!, actorId(req), { text, audio, image, source, commandId }));
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.get("/inbox", (req: AuthRequest, res): any => {
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  try { res.json(FalaTuService.listInbox(req.organizationId!, actorId(req), status)); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.post("/inbox/:id/confirm", (req: AuthRequest, res): any => {
  const { intent, title, eventDate, eventTime, listItems, listType, mentionResolutions } = req.body || {};
  if (listItems !== undefined && !Array.isArray(listItems)) return res.status(400).json({ error: "listItems deve ser array." });
  if (mentionResolutions !== undefined && (typeof mentionResolutions !== "object" || Array.isArray(mentionResolutions))) {
    return res.status(400).json({ error: "mentionResolutions deve ser objeto {menção: entityId|'new'}." });
  }
  try { res.json(FalaTuService.confirm(req.organizationId!, actorId(req), req.params.id, { intent, title, eventDate, eventTime, listItems, listType, mentionResolutions })); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

// Fatia 5 — desambiguação ativa: o humano responde "qual Carlos?". A escolha
// é validada no service contra os candidatos sugeridos (nunca vínculo livre).
router.post("/inbox/:id/resolve-mention", (req: AuthRequest, res): any => {
  const { mention, entityId } = req.body || {};
  if (typeof mention !== "string" || !mention.trim()) return res.status(400).json({ error: "mention é obrigatória." });
  if (entityId !== undefined && entityId !== null && typeof entityId !== "string") return res.status(400).json({ error: "entityId deve ser string, null ou 'new'." });
  try {
    const chosen = !entityId || entityId === "new" ? null : entityId;
    res.json(FalaTuService.resolveMention(req.organizationId!, actorId(req), req.params.id, mention, chosen));
  } catch (e: any) { res.status(400).json({ error: e.message }); }
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

// ── Briefing proativo (Fatia 5): sinais no business_signals (ADR-136) ──

// Só os sinais do PRÓPRIO usuário — briefing é pessoal (ver service).
router.get("/signals", (req: AuthRequest, res): any => {
  res.json(FalaTuBriefingTaskService.list(req.organizationId!, actorId(req)));
});

// Disparo manual do sweep da org (o Scheduler roda sozinho; isto é pro botão
// "atualizar agora" e pra depuração — idempotente por dedupe_key).
router.post("/signals/sweep", (req: AuthRequest, res): any => {
  try { res.json(FalaTuBriefingTaskService.run(req.organizationId!)); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

// ── Entrega do briefing por WhatsApp (Fatia 6): consome os sinais acima ──

// Estado da porta de canal (opt-in de envio proativo, separado da flag do módulo).
router.get("/briefing/whatsapp", (req: AuthRequest, res): any => {
  res.json({ enabled: FalaTuBriefingDigestService.waEnabled(req.organizationId!) });
});

router.post("/briefing/whatsapp", (req: AuthRequest, res): any => {
  if (typeof req.body?.enabled !== "boolean") return res.status(400).json({ error: "enabled deve ser boolean." });
  res.json(FalaTuBriefingDigestService.setWaEnabled(req.organizationId!, req.body.enabled));
});

// ── F8.4: tokens pessoais de captura. A GESTÃO exige sessão (estas rotas);
// a INGESTÃO autenticada por token vive em /api/falatu-ingest (fora do
// protectedApi). O claro do token só aparece na resposta do create. ──

router.get("/capture-tokens", (req: AuthRequest, res): any => {
  res.json(FalaTuCaptureTokenService.list(req.organizationId!, actorId(req)));
});

router.post("/capture-tokens", (req: AuthRequest, res): any => {
  try { res.json(FalaTuCaptureTokenService.create(req.organizationId!, actorId(req), req.body?.label)); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.post("/capture-tokens/:id/revoke", (req: AuthRequest, res): any => {
  try { res.json(FalaTuCaptureTokenService.revoke(req.organizationId!, actorId(req), req.params.id)); }
  catch (e: any) { res.status(404).json({ error: e.message }); }
});

// "Enviar meu resumo agora" — ignora janela/dedupe, respeita a porta; só pro
// próprio usuário. O envio real é resolvido pelo canal da org (mesmo do Scheduler).
router.post("/briefing/whatsapp/send-now", async (req: AuthRequest, res): Promise<any> => {
  try {
    const orgId = req.organizationId!;
    const channel = db.prepare(`SELECT id FROM channels WHERE organization_id = ? AND status != 'disabled' ORDER BY (provider LIKE 'evolution%') DESC, created_at ASC LIMIT 1`).get(orgId) as any;
    if (!channel) return res.status(400).json({ error: "Nenhum canal de WhatsApp ativo nesta conta." });
    const send = (target: string, message: string) => MessageProviderService.sendMessage(channel.id, target, message);
    res.json(await FalaTuBriefingDigestService.sendNow(orgId, actorId(req), { send }));
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

export default router;
