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
import { FalatuRefundService, FalatuRefundError } from "../FalatuRefundService.js";
import { FalatuSaveOfferService, CANCELLATION_REASONS } from "../FalatuSaveOfferService.js";
import { ContextEngineService as FalaTuContextEngine } from "../ContextEngineService.js";
import { FalaTuReportService } from "../FalaTuReportService.js";
import { ArtifactService } from "../ArtifactService.js";
import { FalaTuFileIntakeService } from "../FalaTuFileIntakeService.js";
import { SmartInboxService } from "../SmartInboxService.js";
import { FalaTuApprovalService } from "../FalaTuApprovalService.js";
import { MAX_BYTES as FALATU_FILE_MAX } from "../ClinicAttachmentService.js";
import multer from "multer";

// Intake de documentos (Fase 2.4): buffer em memória (o service escreve no disco
// privado via ArtifactService); limite de tamanho é a validação primária.
const falatuFileUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: FALATU_FILE_MAX } });

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
// (parser dedicado /api/falatu em server.ts = 12mb), então ~6.7MB de mídia
// real — foto de celular já reduzida pelo downscale do cliente com qualidade
// pra IA de visão ler detalhe fino. Validamos aqui pra falhar com mensagem
// clara em vez do 413 genérico do body-parser.
const MAX_MEDIA_B64 = 9_000_000;

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

// PRD 1 (segurança, P1) — contexto empresarial FILTRADO POR PAPEL. Devolve o
// contexto canônico já projetado pro que ESTE usuário pode ver (§30/§31, CA13):
// domínios sem permissão caem, campos sensíveis são redigidos, e a narrativa
// org-wide só vai pra visão ampla. O `_manifest` (dropped/redacted) alimenta a
// explicabilidade (§49). É a fundação de qualquer business-query do Fala Tu.
router.get("/context", (req: AuthRequest, res): any => {
  res.json(FalaTuContextEngine.buildForUser(req.organizationId!, req.user));
});

// PRD 1 Fase 3 (§20-23, §60) — Smart Inbox: "O que precisa da minha atenção?".
// Composição ranqueada de signals + decision_actions + runtime, por categoria de
// AÇÃO e filtrada pro papel do usuário. Não é fonte de alertas nova (CA15).
router.get("/smart-inbox", (req: AuthRequest, res): any => {
  res.json(SmartInboxService.build(req.organizationId!, req.user));
});

// PRD 1 Fase 4 (§24-25, §54, §66) — Approval Center: aprovar/rejeitar DENTRO do
// Fala Tu. Motor canônico (decision_actions/ApprovalPolicy); esta rota só
// apresenta + delega. A decisão exige actionId EXPLÍCITO + enum (nunca texto livre).
router.get("/approvals", (req: AuthRequest, res): any => {
  res.json(FalaTuApprovalService.pending(req.organizationId!, req.user));
});

router.post("/approvals/:actionId", (req: AuthRequest, res): any => {
  const decision = req.body?.decision;
  if (decision !== "approve" && decision !== "reject") return res.status(400).json({ error: "decision deve ser 'approve' ou 'reject'." });
  const reason = typeof req.body?.reason === "string" ? req.body.reason : null;
  try { res.json(FalaTuApprovalService.decide(req.organizationId!, req.user, req.params.actionId, decision, reason)); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

// PRD 1 Fase 2.2 (CA6) — "me manda o resumo": gera o Resumo Executivo como
// ARTEFATO (PDF), já filtrado pro papel do usuário, e devolve o LINK assinado
// (nunca o binário inline nem o path interno). Determinístico.
router.post("/reports/summary", async (req: AuthRequest, res): Promise<any> => {
  const correlationId = typeof req.body?.correlationId === "string" ? req.body.correlationId : null;
  const format = req.body?.format === "xlsx" ? "xlsx" : "pdf"; // §65: "me manda em Excel"
  try { res.json(await FalaTuReportService.executiveSummary(req.organizationId!, req.user, { correlationId, format })); }
  catch (e: any) { res.status(500).json({ error: e.message }); }
});

// PRD 1 Fase 2.4 (CA7, §17-18) — INTAKE: o Fala Tu recebe um documento
// (multipart), valida por magic-byte, persiste como artefato e classifica.
router.post("/files", falatuFileUpload.single("file"), (req: AuthRequest, res): any => {
  const f = (req as any).file;
  if (!f?.buffer) return res.status(400).json({ error: "Envie um arquivo no campo 'file'." });
  const correlationId = typeof req.body?.correlationId === "string" ? req.body.correlationId : null;
  try { res.json(FalaTuFileIntakeService.intake(req.organizationId!, actorId(req), { filename: f.originalname, buffer: f.buffer, correlationId })); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

// Aba "Arquivos" do Fala Tu (§60): lista os artefatos que o usuário PODE ver
// (sensíveis de outros ficam ocultos — gated por classificação).
router.get("/artifacts", (req: AuthRequest, res): any => {
  const createdBy = req.query.mine === "1" || req.query.mine === "true" ? actorId(req) : undefined;
  const kind = typeof req.query.kind === "string" ? req.query.kind : undefined;
  res.json(ArtifactService.listForUser(req.organizationId!, req.user, { createdBy, kind, limit: Number(req.query.limit) || 50 }));
});

// Emite a URL assinada de um artefato (pra reentregar no chat) — gated.
router.get("/artifacts/:id/link", (req: AuthRequest, res): any => {
  const url = ArtifactService.signedUrlForUser(req.organizationId!, req.user, req.params.id);
  if (!url) return res.status(404).json({ error: "Artefato não encontrado." });
  res.json({ url });
});

// ADR-160 F5/F6/F7 — porta I/O: estado/controle dos bridges (opt-in que faz o
// Fala Tu escrever no domínio CANÔNICO ao confirmar — tasks→TaskService,
// events→agenda, lists('shopping')→requisição de compra — além dos silos).
// Ligar/desligar é do gestor; leitura p/ qualquer papel.
router.get("/bridge", (req: AuthRequest, res): any => {
  res.json(FalaTuService.bridgeState(req.organizationId!));
});

router.put("/bridge", (req: AuthRequest, res): any => {
  if (!["owner", "admin"].includes(req.user?.role)) return res.status(403).json({ error: "Apenas gestores podem alterar." });
  const hasTasks = typeof req.body?.tasks === "boolean";
  const hasEvents = typeof req.body?.events === "boolean";
  const hasLists = typeof req.body?.lists === "boolean";
  if (!hasTasks && !hasEvents && !hasLists) return res.status(400).json({ error: "Informe tasks, events e/ou lists (boolean)." });
  if (hasTasks) FalaTuService.setTaskBridge(req.organizationId!, req.body.tasks);
  if (hasEvents) FalaTuService.setEventBridge(req.organizationId!, req.body.events);
  if (hasLists) FalaTuService.setListBridge(req.organizationId!, req.body.lists);
  res.json(FalaTuService.bridgeState(req.organizationId!));
});

// Estado da porta de canal (opt-in de envio proativo, separado da flag do módulo).
router.get("/briefing/whatsapp", (req: AuthRequest, res): any => {
  res.json({ enabled: FalaTuBriefingDigestService.waEnabled(req.organizationId!) });
});

router.post("/briefing/whatsapp", (req: AuthRequest, res): any => {
  if (typeof req.body?.enabled !== "boolean") return res.status(400).json({ error: "enabled deve ser boolean." });
  res.json(FalaTuBriefingDigestService.setWaEnabled(req.organizationId!, req.body.enabled));
});

// ── F8.3: briefing por Web Push. A "porta" é a subscription do próprio
// usuário (assinar já é o opt-in — exige permissão do browser + clique);
// desligar revoga. O digest/janela/sinal são os MESMOS do canal WA. ──

router.get("/briefing/push", async (req: AuthRequest, res): Promise<any> => {
  const { FalaTuPushService } = await import("../FalaTuPushService.js");
  res.json(await FalaTuPushService.status(req.organizationId!, actorId(req)));
});

router.post("/briefing/push", async (req: AuthRequest, res): Promise<any> => {
  const { FalaTuPushService } = await import("../FalaTuPushService.js");
  try { res.json(FalaTuPushService.subscribe(req.organizationId!, actorId(req), req.body?.subscription)); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.post("/briefing/push/disable", async (req: AuthRequest, res): Promise<any> => {
  const { FalaTuPushService } = await import("../FalaTuPushService.js");
  res.json(FalaTuPushService.disable(req.organizationId!, actorId(req)));
});

router.post("/briefing/push/send-now", async (req: AuthRequest, res): Promise<any> => {
  const { FalaTuPushService } = await import("../FalaTuPushService.js");
  try { res.json(await FalaTuPushService.sendNow(req.organizationId!, actorId(req))); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

// ── F8.6: porta E-MAIL do briefing — opt-in por usuário, destino é o e-mail
// de login dele (nunca há destinatário arbitrário). Digest/janela/sinal são
// os MESMOS das portas WA/push. ──

router.get("/briefing/email", async (req: AuthRequest, res): Promise<any> => {
  const { FalaTuEmailService } = await import("../FalaTuEmailService.js");
  res.json(await FalaTuEmailService.status(req.organizationId!, actorId(req)));
});

router.post("/briefing/email", async (req: AuthRequest, res): Promise<any> => {
  const { FalaTuEmailService } = await import("../FalaTuEmailService.js");
  try { res.json(FalaTuEmailService.setEnabled(req.organizationId!, actorId(req), !!req.body?.enabled)); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.post("/briefing/email/send-now", async (req: AuthRequest, res): Promise<any> => {
  const { FalaTuEmailService } = await import("../FalaTuEmailService.js");
  try { res.json(await FalaTuEmailService.sendNow(req.organizationId!, actorId(req))); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
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

// ── F8.7: Protocolos (chamada de resgate). CRUD é HUMANO — só existe nestas
// rotas de sessão; o caminho de captura apenas lê/ativa/cancela. Nenhuma rota
// aceita número de destino além do phoneE164 do PRÓPRIO protocolo do usuário
// (guardrail anti-abuso: ligar pra terceiros é impossível por construção). ──

router.get("/protocols/settings", async (req: AuthRequest, res): Promise<any> => {
  const { FalaTuProtocolService } = await import("../FalaTuProtocolService.js");
  const { TelephonyService } = await import("../TelephonyService.js");
  res.json({ orgEnabled: FalaTuProtocolService.orgEnabled(req.organizationId!), telephonyConfigured: TelephonyService.configured() });
});

router.post("/protocols/settings", async (req: AuthRequest, res): Promise<any> => {
  const { FalaTuProtocolService } = await import("../FalaTuProtocolService.js");
  try { res.json(FalaTuProtocolService.setOrgEnabled(req.organizationId!, actorId(req), !!req.body?.enabled)); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.get("/protocols", async (req: AuthRequest, res): Promise<any> => {
  const { FalaTuProtocolService } = await import("../FalaTuProtocolService.js");
  res.json(FalaTuProtocolService.list(req.organizationId!, actorId(req)));
});

router.post("/protocols", async (req: AuthRequest, res): Promise<any> => {
  const { FalaTuProtocolService } = await import("../FalaTuProtocolService.js");
  try { res.json(FalaTuProtocolService.create(req.organizationId!, actorId(req), req.body || {})); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

// Cancela TODAS as agendadas do usuário — mesmo comportamento da frase de
// voz ("cancela o protocolo"): dentro da janela, cancelar tudo é o seguro.
router.post("/protocols/activations/cancel-scheduled", async (req: AuthRequest, res): Promise<any> => {
  const { FalaTuProtocolService } = await import("../FalaTuProtocolService.js");
  res.json({ cancelled: FalaTuProtocolService.cancelScheduled(req.organizationId!, actorId(req), "ui") });
});

router.get("/protocols/activations", async (req: AuthRequest, res): Promise<any> => {
  const { FalaTuProtocolService } = await import("../FalaTuProtocolService.js");
  res.json(FalaTuProtocolService.listActivations(req.organizationId!, actorId(req)));
});

router.post("/protocols/:id", async (req: AuthRequest, res): Promise<any> => {
  const { FalaTuProtocolService } = await import("../FalaTuProtocolService.js");
  try { res.json(FalaTuProtocolService.update(req.organizationId!, actorId(req), req.params.id, req.body || {})); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.post("/protocols/:id/remove", async (req: AuthRequest, res): Promise<any> => {
  const { FalaTuProtocolService } = await import("../FalaTuProtocolService.js");
  try { res.json(FalaTuProtocolService.remove(req.organizationId!, actorId(req), req.params.id)); }
  catch (e: any) { res.status(404).json({ error: e.message }); }
});

router.post("/protocols/:id/verify/request", async (req: AuthRequest, res): Promise<any> => {
  const { FalaTuProtocolService } = await import("../FalaTuProtocolService.js");
  try { res.json(await FalaTuProtocolService.requestPhoneVerification(req.organizationId!, actorId(req), req.params.id)); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.post("/protocols/:id/verify/confirm", async (req: AuthRequest, res): Promise<any> => {
  const { FalaTuProtocolService } = await import("../FalaTuProtocolService.js");
  try { res.json(FalaTuProtocolService.confirmPhoneVerification(req.organizationId!, actorId(req), req.params.id, req.body?.code)); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.post("/protocols/:id/activate", async (req: AuthRequest, res): Promise<any> => {
  const { FalaTuProtocolService } = await import("../FalaTuProtocolService.js");
  try { res.json(FalaTuProtocolService.activate(req.organizationId!, actorId(req), req.params.id, "webapp")); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
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

// ADR-154 F2.2 Fatia E — garantia de 7 dias com reembolso AUTOMÁTICO via ASAAS.
// GET expõe se ainda dá tempo (a UI mostra/esconde o botão + dias restantes);
// POST aciona o estorno + cancelamento. Self-serve: age SEMPRE sobre a própria
// org do JWT (req.organizationId), nunca sobre outra.
router.get("/refund/eligibility", (req: AuthRequest, res): any => {
  try { res.json(FalatuRefundService.checkEligibility(req.organizationId!)); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.post("/refund", async (req: AuthRequest, res): Promise<any> => {
  try {
    res.json(await FalatuRefundService.requestRefund(req.organizationId!, actorId(req)));
  } catch (e: any) {
    if (e instanceof FalatuRefundError) return res.status(e.httpStatus).json({ error: e.code, message: e.message });
    res.status(500).json({ error: "internal_error", message: e.message });
  }
});

// ADR-155 F5.1 — save offer antes do cancelamento. A UI abre o fluxo de saída,
// o usuário escolhe o MOTIVO, e devolvemos o degrau certo do ladder (grimoire
// save-offer-ladder) + SEMPRE a elegibilidade do reembolso: a garantia de 7 dias
// segue acessível (RN-E), a oferta é opt-out. A rota valida só a FORMA do motivo;
// o mapa e o dedupe da intenção ficam no service.
router.post("/save-offer/intent", (req: AuthRequest, res): any => {
  const reason = String(req.body?.reason || "");
  if (!FalatuSaveOfferService.isReason(reason)) {
    return res.status(400).json({ error: "reason inválido", allowed: FalatuSaveOfferService as any && ["preco", "pouco_uso", "faltou_feature", "problema_tecnico", "outro"] });
  }
  const freeText = req.body?.freeText != null ? String(req.body.freeText) : null;
  try {
    res.json(FalatuSaveOfferService.captureIntent(req.organizationId!, actorId(req), { reason, freeText }));
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

// ADR-155 F5.2 — o cliente ACEITOU a save offer. Governado pelo G-153-3 (ADR-153):
// aceitar não muda a cobrança sozinho — o service registra a retenção, calcula o
// alvo do downgrade e publica o handoff pro operador finalizar em Cobrança. A
// garantia de 7 dias segue intocada. Sem pending/oferta → 400 (nada a aceitar).
router.post("/save-offer/accept", (req: AuthRequest, res): any => {
  try {
    const result = FalatuSaveOfferService.acceptOffer(req.organizationId!, actorId(req));
    if (!result.ok) return res.status(400).json({ error: result.reason });
    res.json(result);
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

export default router;
