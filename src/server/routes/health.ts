import { Router } from "express";
import { AuthRequest } from "../middleware/auth.js";
import { BusinessHealthService } from "../BusinessHealthService.js";
import { SurvivalIndexService } from "../SurvivalIndexService.js";
import { BusinessTutorService } from "../BusinessTutorService.js";
import { DecisionSimulatorService } from "../DecisionSimulatorService.js";
import { MessageProviderService } from "../MessageProviderService.js";
import db from "../db.js";

// Central de Saúde e Decisão (ADR-126) — síntese: status + 3 prioridades do dia.
// Rota core (não é módulo opcional): disponível em todas as verticais.
const router = Router();

// GET /api/health-center — status geral + frase-síntese + top-3 prioridades.
router.get("/", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const minCash = Number(req.query?.minCash) || 0;
  res.json(BusinessHealthService.overview(orgId, minCash));
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

// POST /api/health-center/simulate/withdraw — "posso retirar mais?" (ADR-133 Fatia 3).
router.post("/simulate/withdraw", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json(DecisionSimulatorService.withdraw(orgId, { amount: Number(req.body?.amount) || 0 }));
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
router.post("/tutor/test", async (req: AuthRequest, res): Promise<any> => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const channel = db.prepare(`SELECT id FROM channels WHERE organization_id = ? AND status != 'disabled' ORDER BY (provider LIKE 'evolution%') DESC, created_at ASC LIMIT 1`).get(orgId) as any;
  if (!channel) return res.status(400).json({ error: "Conecte um canal de WhatsApp primeiro." });
  const out = await BusinessTutorService.sendNow(orgId, { send: (target, message) => MessageProviderService.sendMessage(channel.id, target, message) });
  if (!out.ok) return res.status(400).json({ error: out.error });
  res.json({ ok: true, phone: out.phone });
});

export default router;
