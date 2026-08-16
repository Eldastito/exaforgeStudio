/**
 * Rotas AUTENTICADAS da vertical Beleza & Salões (ADR-169 F7 / BEAUTY-007).
 *
 * Montadas em `/api/beauty` DENTRO do `protectedApi` (server.ts) — auth +
 * enforce module (MODULE_BY_ROUTE mapeia `beauty → estudio`, o mesmo módulo
 * que já protege o Estúdio de Criação, e que já está no preset da vertical
 * `beleza` desde a F1). Consumidores: recepção do salão, dona, gerente.
 *
 * NÃO expõe endpoints públicos (rota pública `/api/public/beauty/media/:key`
 * fica em `beautyPublic.ts` — só serve o arquivo assinado, sem PII).
 *
 * Gates em CADA rota (belt-and-suspenders — o enforce global já barra
 * fora do plano/módulo, mas defendemos aqui de novo por clareza):
 *  - `assertBeautyOn(orgId)`: vertical=`beleza` na `organization_settings`.
 *    Sem beleza, retorna 404 (não vaza existência da fatia).
 *  - Endpoints do Simulador exigem também `beauty_hair_simulator_enabled=1`
 *    (opt-in explícito por org — F5 flag).
 *
 * Guardrails RN-BS:
 *  - RN-BS-04: consent tipado é sempre chamado ANTES de aceitar upload.
 *  - RN-BS-05: NUNCA logamos foto/base64/prompt.
 *  - RN-BS-07: `orgId = req.organizationId` (sempre do JWT verificado).
 *  - RN-BS-08: rotas de "dinheiro" ficariam gated por `requireRole(...)`.
 *    F7 não expõe valor — só consent/consulta/upload/simulação.
 *  - RN-BS-11: rota nunca aceita simulationType/params fora do vocab
 *    fechado (o service já sanitiza — a rota confia).
 */
import { Router, Response } from "express";
import multer from "multer";
import db from "../db.js";
import { AuthRequest, requireRole } from "../middleware/auth.js";
import { logAuthEvent } from "../auditLog.js";
import { BeautyVisualConsultationService, BEAUTY_CONSENT_SCOPES } from "../BeautyVisualConsultationService.js";
import { BeautyHairSimulationService, SIMULATION_TYPES } from "../BeautyHairSimulationService.js";
import { BeautyHarmonyAnalysisService } from "../BeautyHarmonyAnalysisService.js";
import { LookServiceRecommendationService } from "../LookServiceRecommendationService.js";
import { BeautyLookToAppointmentService } from "../BeautyLookToAppointmentService.js";
import { BeautyClientService } from "../BeautyClientService.js";
import { BeautyVisagismService } from "../BeautyVisagismService.js";
// Registra `beauty_review_invite` no MESMO registry canônico do CommandExecutor
// (§37 do PRD — sem runtime paralelo). Side-effect import: garante que quando
// as rotas beauty forem montadas, o handler está disponível pro executor.
import "../BeautyReviewInviteCommandHandler.js";

const router = Router();

// Upload de foto — 15 MB, whitelist mimetype (mesmo do FashionAvatar).
const AVATAR_UPLOAD_MAX_BYTES = 15 * 1024 * 1024;
const AVATAR_ACCEPTED_MIMES = new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"]);
const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: AVATAR_UPLOAD_MAX_BYTES },
  fileFilter(_req, file, cb) {
    if (!AVATAR_ACCEPTED_MIMES.has(file.mimetype)) return cb(new Error("Formato não aceito. Use JPG, PNG ou WEBP."));
    cb(null, true);
  },
});

// Wrapper do multer que TRADUZ erro de upload em JSON 400 — sem ele, um erro
// do middleware (campo inesperado, arquivo grande demais, mimetype recusado)
// acontece ANTES do try/catch do handler e cai no error handler default do
// Express, que responde HTML `<pre>Internal Server Error</pre>` (500). O
// frontend então mostra HTML cru no lugar de uma mensagem útil. Com isto,
// qualquer falha de upload vira `{ error }` legível e o status certo (400).
function uploadSingleFile(req: AuthRequest, res: Response, next: () => void): void {
  avatarUpload.single("file")(req as any, res as any, (err: any) => {
    if (!err) return next();
    const code = err?.code;
    const msg =
      code === "LIMIT_FILE_SIZE" ? "Foto muito grande. O limite é 15 MB." :
      code === "LIMIT_UNEXPECTED_FILE" ? "Campo de upload inesperado. Envie a foto no campo 'file'." :
      String(err?.message || "Falha no upload da foto.");
    res.status(400).json({ error: msg, code: code || "upload_error" });
  });
}

// ─────────────── Gates ───────────────

function orgVertical(orgId: string): string | null {
  const r = db.prepare(`SELECT vertical FROM organization_settings WHERE organization_id = ? AND deleted_at IS NULL`).get(orgId) as any;
  return r?.vertical || null;
}
function isBeautyOn(orgId: string): boolean {
  return orgVertical(orgId) === "beleza";
}
function isSimulatorOn(orgId: string): boolean {
  if (!isBeautyOn(orgId)) return false;
  const r = db.prepare(`SELECT beauty_hair_simulator_enabled FROM organization_settings WHERE organization_id = ?`).get(orgId) as any;
  return !!Number(r?.beauty_hair_simulator_enabled);
}

function requireBeauty(req: AuthRequest, res: Response): string | null {
  const orgId = req.organizationId;
  if (!orgId) { res.status(401).json({ error: "Unauthorized" }); return null; }
  if (!isBeautyOn(orgId)) { res.status(404).json({ error: "Not found" }); return null; }
  return orgId;
}
function requireSimulator(req: AuthRequest, res: Response): string | null {
  const orgId = requireBeauty(req, res);
  if (!orgId) return null;
  if (!isSimulatorOn(orgId)) { res.status(403).json({ error: "beauty_hair_simulator_enabled=0", state: "disabled" }); return null; }
  return orgId;
}

// ─────────────── Vocabulary (metadados p/ UI) ───────────────

router.get("/vocabulary", (req: AuthRequest, res): any => {
  const orgId = requireBeauty(req, res);
  if (!orgId) return;
  res.json({
    consentScopes: [...BEAUTY_CONSENT_SCOPES],
    simulationTypes: [...SIMULATION_TYPES],
    ...BeautyHairSimulationService.vocabulary(),
  });
});

// ─────────────── Beauty AI settings (F20 / BEAUTY-021) ───────────────
//
// Toggle da flag `beauty_hair_simulator_enabled` (F5, aditiva em
// `organization_settings`) que hoje só existia por DB. Fecha o gap operacional
// descoberto na F19: sem esta rota, o dono não tinha como ligar o Simulador
// pela UI (Master Admin conseguia via manipulação direta de DB; dono não).
// Convenções:
//  - Gate `requireBeauty` (404 sem vertical=beleza — belt-and-suspenders com
//    o enforce global; não vaza existência do toggle pra outras verticais).
//  - `requireRole('owner','admin')`: quem contrata é o dono; recepção/
//    estilista NÃO ligam/desligam recurso IA (política operacional §31 do
//    PRD — atendente é operacional, não administrativo). Master Admin
//    passa como owner por ter platform_role.
//  - `logAuthEvent` grava `ADMIN_BEAUTY_HAIR_SIMULATOR_TOGGLE` em
//    auth_audit_logs (rastreabilidade LGPD — quem ligou/desligou e quando).
router.get("/settings", (req: AuthRequest, res): any => {
  const orgId = requireBeauty(req, res);
  if (!orgId) return;
  const r = db.prepare(
    `SELECT beauty_hair_simulator_enabled FROM organization_settings WHERE organization_id = ?`
  ).get(orgId) as any;
  res.json({
    hairSimulatorEnabled: !!Number(r?.beauty_hair_simulator_enabled),
  });
});

router.patch("/settings/hair-simulator", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = requireBeauty(req, res);
  if (!orgId) return;
  const enabled = !!req.body?.enabled;
  const info = db.prepare(
    `UPDATE organization_settings SET beauty_hair_simulator_enabled = ?, updated_at = CURRENT_TIMESTAMP WHERE organization_id = ? AND deleted_at IS NULL`
  ).run(enabled ? 1 : 0, orgId);
  if (info.changes === 0) return res.status(404).json({ error: "Not found" });
  logAuthEvent(orgId, req.user?.userId, orgId, 'ADMIN_BEAUTY_HAIR_SIMULATOR_TOGGLE', { enabled });
  res.json({ ok: true, hairSimulatorEnabled: enabled });
});

// ─────────────── Clientes walk-in (F22 / BEAUTY-023) ───────────────
//
// Cadastro manual de cliente pra recepção do salão: a cliente CHEGA no balcão
// sem ter mandado mensagem antes, então não existe contato ainda. Sem isto o
// seletor de cliente da Beauty AI fica vazio e o fluxo inteiro trava. Reusa a
// tabela `contacts` (§37 — sem CRM paralelo). `GET` lê a tabela direto (não
// `/api/tickets`, que só enxerga contatos com conversa). Só `requireBeauty`
// (sem requireRole — a recepção precisa cadastrar; o RBAC do módulo já roda no
// enforce global).
router.get("/clients", (req: AuthRequest, res): any => {
  const orgId = requireBeauty(req, res);
  if (!orgId) return;
  res.json({ clients: BeautyClientService.list(orgId) });
});

router.post("/clients", (req: AuthRequest, res): any => {
  const orgId = requireBeauty(req, res);
  if (!orgId) return;
  const name = String(req.body?.name || "").trim();
  if (!name) return res.status(400).json({ error: "Informe o nome da cliente." });
  try {
    const client = BeautyClientService.create(orgId, {
      name,
      phone: req.body?.phone,
      email: req.body?.email,
      profile: req.body?.profile && typeof req.body.profile === "object" ? req.body.profile : undefined,
    });
    logAuthEvent(orgId, req.user?.userId || null, client.id, "BEAUTY_CLIENT_CREATED", { hasPhone: !!String(req.body?.phone || "").trim(), hasProfile: !!req.body?.profile });
    res.json({ ok: true, client });
  } catch (e: any) {
    res.status(400).json({ error: String(e?.message || "Erro ao cadastrar cliente.").slice(0, 200) });
  }
});

// Ficha técnica capilar (F25) — vocab fechado; ajuda a recomendação e avisa
// a profissional sobre histórico químico (viabilidade de nova química).
router.get("/clients/profile-vocabulary", (req: AuthRequest, res): any => {
  const orgId = requireBeauty(req, res);
  if (!orgId) return;
  res.json(BeautyClientService.profileVocabulary());
});

router.get("/clients/:contactId/profile", (req: AuthRequest, res): any => {
  const orgId = requireBeauty(req, res);
  if (!orgId) return;
  res.json({ profile: BeautyClientService.getProfile(orgId, req.params.contactId) });
});

router.put("/clients/:contactId/profile", (req: AuthRequest, res): any => {
  const orgId = requireBeauty(req, res);
  if (!orgId) return;
  try {
    const profile = BeautyClientService.saveProfile(orgId, req.params.contactId, req.body || {});
    res.json({ ok: true, profile });
  } catch (e: any) {
    res.status(400).json({ error: String(e?.message || "Erro").slice(0, 200) });
  }
});

// ─────────────── Consent ───────────────

router.post("/consents", (req: AuthRequest, res): any => {
  const orgId = requireBeauty(req, res);
  if (!orgId) return;
  const { contactId, consentType, policyVersion } = req.body || {};
  if (!contactId || !consentType) return res.status(400).json({ error: "contactId e consentType obrigatórios." });
  if (!(BEAUTY_CONSENT_SCOPES as readonly string[]).includes(consentType)) {
    return res.status(400).json({ error: "consentType inválido." });
  }
  try {
    const id = BeautyVisualConsultationService.grantConsent(orgId, String(contactId), consentType, policyVersion);
    res.json({ ok: true, id });
  } catch (e: any) {
    res.status(400).json({ error: String(e?.message || "Erro").slice(0, 200) });
  }
});

router.delete("/consents", (req: AuthRequest, res): any => {
  const orgId = requireBeauty(req, res);
  if (!orgId) return;
  const { contactId, consentType } = req.body || {};
  if (!contactId || !consentType) return res.status(400).json({ error: "contactId e consentType obrigatórios." });
  const r = BeautyVisualConsultationService.revokeConsent(orgId, String(contactId), consentType);
  res.json(r);
});

// ─────────────── Consultations ───────────────

router.post("/consultations", (req: AuthRequest, res): any => {
  const orgId = requireBeauty(req, res);
  if (!orgId) return;
  const { contactId, goal, intensity, expiresInDays } = req.body || {};
  if (!contactId) return res.status(400).json({ error: "contactId obrigatório." });
  try {
    const cons = BeautyVisualConsultationService.startConsultation(orgId, {
      contactId: String(contactId), goal: goal || null, intensity: intensity || null,
      expiresInDays: Number.isFinite(expiresInDays) ? Number(expiresInDays) : undefined,
    });
    res.json(cons);
  } catch (e: any) {
    res.status(400).json({ error: String(e?.message || "Erro").slice(0, 200) });
  }
});

router.get("/consultations/:id", (req: AuthRequest, res): any => {
  const orgId = requireBeauty(req, res);
  if (!orgId) return;
  const cons = BeautyVisualConsultationService.getConsultation(orgId, req.params.id);
  if (!cons) return res.status(404).json({ error: "Consulta não encontrada." });
  const assets = cons.contactId
    ? BeautyVisualConsultationService.listAssetsForContact(orgId, cons.contactId).filter((a) => a.consultationId === cons.id)
    : [];
  const simulations = BeautyHairSimulationService.listForConsultation(orgId, cons.id);
  res.json({ consultation: cons, assets, simulations });
});

router.post("/consultations/:id/upload", uploadSingleFile, async (req: AuthRequest, res): Promise<any> => {
  const orgId = requireBeauty(req, res);
  if (!orgId) return;
  if (!req.file) return res.status(400).json({ error: "Envie uma foto no campo 'file' (multipart/form-data)." });
  try {
    const r = await BeautyVisualConsultationService.uploadReferencePhoto(orgId, req.params.id, req.file.buffer);
    if (!r.ok) return res.status(400).json(r);
    res.json(r);
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message || "Erro").slice(0, 200) });
  }
});

// Aprovação/rejeição manual de asset em quarentena (recepção/dona).
// Em F5+ com validateGuidedPhoto, isso pode virar automático — hoje é manual.
router.post("/assets/:id/approve", (req: AuthRequest, res): any => {
  const orgId = requireBeauty(req, res);
  if (!orgId) return;
  const { safetyReport } = req.body || {};
  const ok = BeautyVisualConsultationService.approveAsset(orgId, req.params.id, safetyReport && typeof safetyReport === "object" ? safetyReport : undefined);
  if (!ok) return res.status(404).json({ error: "Asset não encontrado ou não está em quarentena." });
  try { logAuthEvent(orgId, req.user?.userId || null, req.params.id, "BEAUTY_ASSET_APPROVED_MANUAL", {}); } catch { /* noop */ }
  res.json({ ok: true });
});

router.post("/assets/:id/reject", (req: AuthRequest, res): any => {
  const orgId = requireBeauty(req, res);
  if (!orgId) return;
  const { reason, safetyReport } = req.body || {};
  const ok = BeautyVisualConsultationService.rejectAsset(orgId, req.params.id, String(reason || "sem_motivo").slice(0, 200),
    safetyReport && typeof safetyReport === "object" ? safetyReport : undefined);
  if (!ok) return res.status(404).json({ error: "Asset não encontrado ou não está em quarentena." });
  res.json({ ok: true });
});

// ─────────────── Simulator ───────────────

router.post("/consultations/:id/simulate", (req: AuthRequest, res): any => {
  const orgId = requireSimulator(req, res);
  if (!orgId) return;
  const { simulationType, parameters } = req.body || {};
  const r = BeautyHairSimulationService.requestSimulation(orgId, req.params.id, {
    simulationType: simulationType as any,
    parameters: parameters && typeof parameters === "object" ? parameters : {},
  });
  if (!r.ok) return res.status(400).json(r);
  res.json(r);
});

router.get("/simulations/:id", (req: AuthRequest, res): any => {
  const orgId = requireBeauty(req, res);
  if (!orgId) return;
  const sim = BeautyHairSimulationService.getSimulation(orgId, req.params.id);
  if (!sim) return res.status(404).json({ error: "Simulação não encontrada." });
  res.json(sim);
});

router.post("/simulations/:id/cancel", (req: AuthRequest, res): any => {
  const orgId = requireBeauty(req, res);
  if (!orgId) return;
  const ok = BeautyHairSimulationService.cancelSimulation(orgId, req.params.id);
  res.json({ ok });
});

// ─────────────── Harmony Analysis (F8) ───────────────

// GET /vocabulary/harmony — dimensões + disclaimer pra UI
router.get("/vocabulary/harmony", (req: AuthRequest, res): any => {
  const orgId = requireBeauty(req, res);
  if (!orgId) return;
  res.json(BeautyHarmonyAnalysisService.vocabulary());
});

// POST /consultations/:id/analysis — gera análise (exige actor+reason via
// AiGovernanceService.guardApplied — RN-BS-03)
router.post("/consultations/:id/analysis", (req: AuthRequest, res): any => {
  const orgId = requireBeauty(req, res);
  if (!orgId) return;
  const { simulationId, reason } = req.body || {};
  const actorId = req.user?.userId || null;
  try {
    const analysis = BeautyHarmonyAnalysisService.analyze(orgId, req.params.id, {
      simulationId: simulationId || null,
      actorId,
      reason: String(reason || "").trim() || null,
    });
    res.json(analysis);
  } catch (e: any) {
    if (e?.code === "human_decision_required") {
      return res.status(400).json({ error: "human_decision_required", detail: "Análise exige actor + reason (RN-BS-03)." });
    }
    res.status(400).json({ error: String(e?.message || "Erro").slice(0, 200) });
  }
});

// GET /consultations/:id/analyses — histórico de análises da consulta
router.get("/consultations/:id/analyses", (req: AuthRequest, res): any => {
  const orgId = requireBeauty(req, res);
  if (!orgId) return;
  res.json(BeautyHarmonyAnalysisService.listForConsultation(orgId, req.params.id));
});

// GET /analyses/:id — 1 análise específica
router.get("/analyses/:id", (req: AuthRequest, res): any => {
  const orgId = requireBeauty(req, res);
  if (!orgId) return;
  const a = BeautyHarmonyAnalysisService.getById(orgId, req.params.id);
  if (!a) return res.status(404).json({ error: "Análise não encontrada." });
  res.json(a);
});

// ─────────────── Visagismo (F24) — subtom→cor + formato rosto→corte ───────────────
//
// Análise FACIAL técnica (formato do rosto, subtom de pele) → recomendação de
// corte + cor. RN-BS-03: NUNCA pontua atratividade nem julga a pessoa — só
// recomenda tecnicamente. Requer actor+reason (guardApplied).
router.get("/vocabulary/visagism", (req: AuthRequest, res): any => {
  const orgId = requireBeauty(req, res);
  if (!orgId) return;
  res.json(BeautyVisagismService.vocabulary());
});

router.post("/consultations/:id/visagism", async (req: AuthRequest, res): Promise<any> => {
  const orgId = requireBeauty(req, res);
  if (!orgId) return;
  const { profile, undertone, faceShape, reason } = req.body || {};
  try {
    const analysis = await BeautyVisagismService.analyze(orgId, req.params.id, {
      actorId: req.user?.userId || null,
      reason: String(reason || "").trim() || null,
      profile, undertone, faceShape,
    });
    res.json(analysis);
  } catch (e: any) {
    if (e?.code === "human_decision_required") {
      return res.status(400).json({ error: "human_decision_required", detail: "Visagismo exige actor + reason (RN-BS-03)." });
    }
    res.status(400).json({ error: String(e?.message || "Erro").slice(0, 200) });
  }
});

router.get("/consultations/:id/visagism-analyses", (req: AuthRequest, res): any => {
  const orgId = requireBeauty(req, res);
  if (!orgId) return;
  res.json(BeautyVisagismService.listForConsultation(orgId, req.params.id));
});

// ─────────────── Look → Serviços do catálogo REAL (F9) ───────────────

// GET /vocabulary/recommendations — keywords + níveis de relevância
router.get("/vocabulary/recommendations", (req: AuthRequest, res): any => {
  const orgId = requireBeauty(req, res);
  if (!orgId) return;
  res.json(LookServiceRecommendationService.vocabulary());
});

// GET /simulations/:id/recommendations — recomenda serviços baseado em UMA sim
router.get("/simulations/:id/recommendations", (req: AuthRequest, res): any => {
  const orgId = requireBeauty(req, res);
  if (!orgId) return;
  const r = LookServiceRecommendationService.recommendForSimulation(orgId, req.params.id);
  res.json(r);
});

// GET /consultations/:id/recommendations — recomenda serviços baseado no goal
router.get("/consultations/:id/recommendations", (req: AuthRequest, res): any => {
  const orgId = requireBeauty(req, res);
  if (!orgId) return;
  const r = LookServiceRecommendationService.recommendForConsultation(orgId, req.params.id);
  res.json(r);
});

// Availability composta: "quem pode fazer este serviço e quando?" (F10).
router.get("/consultations/:id/availability", (req: AuthRequest, res): any => {
  const orgId = requireBeauty(req, res);
  if (!orgId) return;
  const serviceId = String(req.query?.serviceId || "");
  const days = req.query?.days ? Number(req.query.days) : undefined;
  const fromMs = req.query?.fromMs ? Number(req.query.fromMs) : undefined;
  const roomId = req.query?.roomId ? String(req.query.roomId) : null;
  const r = BeautyLookToAppointmentService.availability(orgId, req.params.id, {
    serviceId,
    days,
    fromMs,
    roomId,
  });
  res.json(r);
});

// Reserva: consulta 'selected' + serviço + profissional + horário → appointment (F10).
router.post("/consultations/:id/book", (req: AuthRequest, res): any => {
  const orgId = requireBeauty(req, res);
  if (!orgId) return;
  const { serviceId, professionalId, startISO } = req.body || {};
  if (!serviceId || !professionalId || !startISO) {
    return res.status(400).json({ error: "serviceId, professionalId e startISO obrigatórios." });
  }
  const r = BeautyLookToAppointmentService.book(
    orgId,
    req.params.id,
    { serviceId: String(serviceId), professionalId: String(professionalId), startISO: String(startISO) },
    req.user?.userId || null,
  );
  if (r.ok === false) {
    const code = r.reason === "slot_conflict" ? 409 : r.reason === "consultation_not_found" ? 404 : 400;
    return res.status(code).json(r);
  }
  res.json(r);
});

// Cliente escolhe um visual (avança consulta pra 'selected').
router.post("/consultations/:id/select", (req: AuthRequest, res): any => {
  const orgId = requireBeauty(req, res);
  if (!orgId) return;
  const { simulationId } = req.body || {};
  if (!simulationId) return res.status(400).json({ error: "simulationId obrigatório." });
  const cons = BeautyVisualConsultationService.getConsultation(orgId, req.params.id);
  if (!cons) return res.status(404).json({ error: "Consulta não encontrada." });
  if (cons.status !== "ready") return res.status(400).json({ error: `Consulta em '${cons.status}' — só 'ready' pode selecionar.` });
  const sim = BeautyHairSimulationService.getSimulation(orgId, String(simulationId));
  if (!sim || sim.consultationId !== cons.id) return res.status(404).json({ error: "Simulação não pertence à consulta." });
  if (sim.status !== "SUCCEEDED") return res.status(400).json({ error: `Simulação em '${sim.status}' — só 'SUCCEEDED' pode ser selecionada.` });
  db.prepare(
    `UPDATE beauty_visual_consultations SET status = 'selected', selected_simulation_id = ?, selected_at = CURRENT_TIMESTAMP
      WHERE id = ? AND organization_id = ?`,
  ).run(String(simulationId), cons.id, orgId);
  try { logAuthEvent(orgId, req.user?.userId || null, cons.id, "BEAUTY_CONSULTATION_SELECTED", { simulationId }); } catch { /* noop */ }
  res.json(BeautyVisualConsultationService.getConsultation(orgId, cons.id));
});

export default router;
