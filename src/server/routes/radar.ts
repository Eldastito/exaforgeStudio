import { Router } from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { AuthRequest } from "../middleware/auth.js";
import db from "../db.js";
import { RadarService } from "../RadarService.js";
import { RadarPublicService } from "../RadarPublicService.js";
import { ConversionVelocityService } from "../ConversionVelocityService.js";
import { StorageService } from "../StorageService.js";

const router = Router();

// Upload de evidência (mesmo padrão de src/server/routes/uploads.ts): disco
// local sob MEDIA_DIR é sempre a fonte de verdade; S3 é espelho best-effort.
// Aceita imagem OU PDF (evidência costuma ser print de tela ou relatório
// exportado) — mais amplo que uploads.ts, que só aceita imagem.
const EVIDENCE_DIR = path.join(process.env.DATA_DIR || process.cwd(), "media", "radar-evidence");
try { fs.mkdirSync(EVIDENCE_DIR, { recursive: true }); } catch (e) { /* noop */ }
const EVIDENCE_EXT: Record<string, string> = {
  "image/png": ".png", "image/jpeg": ".jpg", "image/jpg": ".jpg", "image/webp": ".webp", "application/pdf": ".pdf",
};
const evidenceUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (EVIDENCE_EXT[file.mimetype]) cb(null, true);
    else cb(new Error("Formato não suportado (use PNG, JPG, WEBP ou PDF)."));
  },
});

// Kill-switch global (defesa em profundidade, além do gate por tenant em
// ModuleService/verticals.ts). PRD §3 regra 4: `ai_execution_radar_enabled`.
// Default ligado — quem controla o rollout por organização é o módulo opcional
// 'radar' (Configurações › Módulos); esta env só serve para desligar o módulo
// em TODAS as organizações de uma vez (ex.: incidente em produção), sem exigir
// deploy de código.
router.use((_req, res, next) => {
  if (process.env.AI_EXECUTION_RADAR_ENABLED === "false") {
    return res.status(404).json({ error: "not_found" });
  }
  next();
});

const actorId = (req: any) => req.user?.userId || req.user?.id;
// RBAC simplificado da Fase 1 (ver ADR do módulo): só owner/admin administram
// sessões (criar, editar, recalcular). Qualquer usuário autenticado da
// organização pode responder perguntas (equivalente a "líder de área"/
// "colaborador" do PRD) — os perfis granulares completos (consultor, analista,
// gestor de conta) chegam quando houver uso real desses papéis.
const isManager = (req: any) => req.user?.role === "owner" || req.user?.role === "admin";

router.get("/templates", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json(RadarService.listTemplates(orgId));
});

router.get("/templates/:id", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const template = RadarService.getTemplateWithQuestions(orgId, req.params.id);
  if (!template) return res.status(404).json({ error: "Template não encontrado." });
  res.json(template);
});

router.get("/catalog/use-cases", (req: AuthRequest, res): any => {
  if (!req.organizationId) return res.status(401).json({ error: "Unauthorized" });
  res.json(RadarService.listUseCaseCatalog());
});

router.get("/sessions", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json(RadarService.listSessions(orgId, req.query.status as string | undefined));
});

router.post("/sessions", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  if (!isManager(req)) return res.status(403).json({ error: "Apenas donos/administradores criam diagnósticos." });
  try { res.status(201).json(RadarService.createSession(orgId, actorId(req), req.body || {})); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.get("/sessions/:id", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const session = RadarService.getSession(orgId, req.params.id);
  if (!session) return res.status(404).json({ error: "Sessão não encontrada." });
  res.json(session);
});

router.patch("/sessions/:id", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  if (!isManager(req)) return res.status(403).json({ error: "Apenas donos/administradores editam o diagnóstico." });
  try { res.json(RadarService.updateSession(orgId, req.params.id, req.body || {}, actorId(req))); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.post("/sessions/:id/consent", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(RadarService.recordConsent(orgId, req.params.id, actorId(req), req.body || {})); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.post("/sessions/:id/answers", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(RadarService.saveAnswer(orgId, req.params.id, actorId(req), req.body || {})); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.post("/sessions/:id/recalculate", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  if (!isManager(req)) return res.status(403).json({ error: "Apenas donos/administradores recalculam o score." });
  try { res.json(RadarService.recalculate(orgId, req.params.id, actorId(req))); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.post("/sessions/:id/autofill", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(RadarService.autoFillFromMeasuredData(orgId, req.params.id, actorId(req))); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.post("/sessions/:id/complete", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  if (!isManager(req)) return res.status(403).json({ error: "Apenas donos/administradores concluem o diagnóstico." });
  try { res.json(RadarService.completeSession(orgId, req.params.id, actorId(req))); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.get("/sessions/:id/respondents", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(RadarService.listRespondents(orgId, req.params.id)); }
  catch (e: any) { res.status(404).json({ error: e.message }); }
});

router.post("/sessions/:id/respondents", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  if (!isManager(req)) return res.status(403).json({ error: "Apenas donos/administradores adicionam respondentes." });
  try { res.status(201).json(RadarService.addRespondent(orgId, req.params.id, actorId(req), req.body || {})); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.post("/sessions/:id/respondents/:respondentId/revoke", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  if (!isManager(req)) return res.status(403).json({ error: "Apenas donos/administradores revogam convites." });
  try { res.json(RadarService.revokeRespondent(orgId, req.params.id, actorId(req), req.params.respondentId)); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

// Reenvio do convite (ADR-025): rotaciona o token (o hash antigo morre) e,
// opcionalmente, já envia o link novo por WhatsApp/e-mail reaproveitando a
// mesma infraestrutura do envio de relatório (ADR-017). channel 'link' (ou
// ausente) só devolve o link novo para copiar.
router.post("/sessions/:id/respondents/:respondentId/resend", async (req: AuthRequest, res): Promise<any> => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  if (!isManager(req)) return res.status(403).json({ error: "Apenas donos/administradores reenviam convites." });
  const channel = req.body?.channel || "link";
  if (!["link", "whatsapp", "email"].includes(channel)) return res.status(400).json({ error: "Canal inválido (use link, whatsapp ou email)." });
  try { res.json(await RadarService.resendInvite(orgId, req.params.id, actorId(req), req.params.respondentId, channel, req.body?.phone)); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.get("/sessions/:id/evidence", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(RadarService.listEvidence(orgId, req.params.id)); }
  catch (e: any) { res.status(404).json({ error: e.message }); }
});

// multipart (campo "file") + questionId/respondentId no corpo. Mesma
// permissão de responder pergunta (não é ação de manager) — quem respondeu
// deve poder anexar a própria evidência.
router.post("/sessions/:id/evidence", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  evidenceUpload.single("file")(req, res, async (err: any) => {
    if (err) return res.status(400).json({ error: err.message || "Falha no upload." });
    const file = (req as any).file;
    if (!file) return res.status(400).json({ error: "Nenhum arquivo enviado." });
    if (!req.body?.questionId) return res.status(400).json({ error: "questionId é obrigatório." });
    try {
      const ext = EVIDENCE_EXT[file.mimetype] || ".bin";
      const name = `${uuidv4()}${ext}`;
      const filePath = path.join(EVIDENCE_DIR, name);
      fs.writeFileSync(filePath, file.buffer);
      let fileUrl = `/media/radar-evidence/${name}`;
      if (StorageService.isS3Enabled()) {
        const mirror = await StorageService.mirrorToS3(filePath, `radar-evidence/${name}`);
        if (mirror.stored && mirror.url) fileUrl = mirror.url;
      }
      const result = RadarService.addEvidence(orgId, req.params.id, actorId(req), {
        questionId: req.body.questionId, respondentId: req.body.respondentId || null,
        fileUrl, fileName: file.originalname, mimeType: file.mimetype,
      });
      res.status(201).json(result);
    } catch (e: any) {
      res.status(400).json({ error: e.message || "Falha ao anexar evidência." });
    }
  });
});

// Exclusão de evidência (ADR-025) — manager-only, diferente do upload: excluir
// mexe no score (desfaz o boost de confiança), então é ação de curadoria de
// quem revisa o diagnóstico, não de quem respondeu. O arquivo físico local é
// apagado best-effort (a linha do banco é a fonte de verdade da exclusão).
router.delete("/sessions/:id/evidence/:evidenceId", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  if (!isManager(req)) return res.status(403).json({ error: "Apenas donos/administradores excluem evidências." });
  try {
    const { removedFileUrl, session } = RadarService.deleteEvidence(orgId, req.params.id, actorId(req), req.params.evidenceId);
    if (removedFileUrl && removedFileUrl.startsWith("/media/radar-evidence/")) {
      const name = path.basename(removedFileUrl);
      try { fs.unlinkSync(path.join(EVIDENCE_DIR, name)); } catch { /* best-effort */ }
    }
    res.json(session);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// Score mais recente para o card do painel executivo (ADR-025). Sem sessão
// pontuada devolve { score: null } — o painel simplesmente não mostra o card.
router.get("/latest-score", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(RadarService.latestScore(orgId)); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

// Índice de Velocidade de Conversão (IVC) — medido a partir de dados reais da
// própria organização, não do questionário. Não depende de radar_sessions:
// pode ser calculado avulso a qualquer momento (produto de entrada leve) ou
// anexado a uma sessão existente via { sessionId } no corpo.
router.post("/velocity/calculate", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  if (!isManager(req)) return res.status(403).json({ error: "Apenas donos/administradores calculam o índice de velocidade." });
  try { res.status(201).json(ConversionVelocityService.calculate(orgId, actorId(req), req.body || {})); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.get("/velocity", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json(ConversionVelocityService.list(orgId, req.query.sessionId as string | undefined));
});

router.get("/velocity/latest", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const snapshot = ConversionVelocityService.latest(orgId);
  if (!snapshot) return res.status(404).json({ error: "Nenhum cálculo de velocidade ainda para esta organização." });
  res.json(snapshot);
});

// Fase 4 — relatório em PDF (SOB DEMANDA, ver RadarService.generateReport).
router.post("/sessions/:id/report", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  if (!isManager(req)) return res.status(403).json({ error: "Apenas donos/administradores geram o relatório." });
  RadarService.generateReport(orgId, req.params.id, actorId(req))
    .then((result) => res.status(201).json(result))
    .catch((e: any) => res.status(400).json({ error: e.message }));
});

// Fase 5 — ponte com Tarefas (SOB DEMANDA, ver RadarService.createTasksFromRecommendations).
router.post("/sessions/:id/create-tasks", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  if (!isManager(req)) return res.status(403).json({ error: "Apenas donos/administradores criam tarefas a partir do diagnóstico." });
  try { res.status(201).json(RadarService.createTasksFromRecommendations(orgId, req.params.id, actorId(req))); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

// Envio do relatório pelo canal já conectado da PRÓPRIA organização (ver RadarService.sendReport).
router.post("/sessions/:id/send", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  if (!isManager(req)) return res.status(403).json({ error: "Apenas donos/administradores enviam o relatório." });
  const channel = req.body?.channel === "email" ? "email" : req.body?.channel === "whatsapp" ? "whatsapp" : null;
  if (!channel) return res.status(400).json({ error: "Informe channel: 'whatsapp' ou 'email'." });
  RadarService.sendReport(orgId, req.params.id, actorId(req), channel)
    .then((result) => res.status(201).json(result))
    .catch((e: any) => res.status(400).json({ error: e.message }));
});

// GET /api/radar/settings — config de auto-envio do relatório Radar
router.get("/settings", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const o = db.prepare(
      `SELECT radar_auto_send_enabled, radar_auto_send_channel FROM organization_settings WHERE organization_id = ?`
    ).get(orgId) as any;
    res.json({
      autoSendEnabled: !!(o && o.radar_auto_send_enabled),
      autoSendChannel: o?.radar_auto_send_channel || "whatsapp",
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// PUT /api/radar/settings — liga/desliga auto-envio do relatório Radar
router.put("/settings", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  if (!isManager(req)) return res.status(403).json({ error: "Apenas donos/administradores alteram configurações do Radar." });
  try {
    const { autoSendEnabled, autoSendChannel } = req.body || {};
    const channel = autoSendChannel === "email" ? "email" : "whatsapp";
    db.prepare(
      `UPDATE organization_settings SET radar_auto_send_enabled = ?, radar_auto_send_channel = ? WHERE organization_id = ?`
    ).run(autoSendEnabled ? 1 : 0, channel, orgId);
    res.json({ success: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// GET /api/radar/consultation-requests — solicitações de consultoria vindas do
// diagnóstico público (só a organização de destino do funil enxerga as suas).
router.get("/consultation-requests", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(RadarPublicService.listConsultationRequests(orgId, req.query.status as string | undefined)); }
  catch (e: any) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/radar/consultation-requests/:id — transição de status pelo consultor.
router.patch("/consultation-requests/:id", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  if (!isManager(req)) return res.status(403).json({ error: "Apenas donos/administradores tratam solicitações de consultoria." });
  try { res.json(RadarPublicService.updateConsultationRequest(orgId, req.params.id, String(req.body?.status || ""), actorId(req))); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

export default router;
