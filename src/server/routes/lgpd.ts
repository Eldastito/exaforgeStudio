import { Router } from "express";
import db from "../db.js";
import { AuthRequest } from "../middleware/auth.js";
import { LgpdService } from "../LgpdService.js";

const router = Router();

// GET /api/lgpd/settings — política de retenção da org.
router.get("/settings", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const o = db.prepare(`SELECT retention_enabled, retention_days FROM organization_settings WHERE organization_id = ?`).get(orgId) as any || {};
  res.json({ enabled: !!o.retention_enabled, days: o.retention_days || 365 });
});

// PUT /api/lgpd/settings — liga/desliga + janela de retenção (mínimo 30 dias).
router.put("/settings", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const { enabled, days } = req.body || {};
  const d = Math.min(3650, Math.max(30, parseInt(String(days), 10) || 365));
  db.prepare(`UPDATE organization_settings SET retention_enabled = ?, retention_days = ? WHERE organization_id = ?`)
    .run(enabled ? 1 : 0, d, orgId);
  res.json({ success: true });
});

// GET /api/lgpd/contact/:id/export — portabilidade (JSON com os dados do titular).
router.get("/contact/:id/export", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const data = LgpdService.exportContact(orgId, req.params.id);
  if (!data) return res.status(404).json({ error: "Contato não encontrado" });
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Content-Disposition", `attachment; filename=dados-${req.params.id}.json`);
  res.send(JSON.stringify(data, null, 2));
});

// POST /api/lgpd/contact/:id/forget — direito ao esquecimento (anonimiza).
router.post("/contact/:id/forget", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const ok = LgpdService.forgetContact(orgId, req.params.id);
  res.json({ success: ok });
});

// ---- Granular consent management ----

// GET /api/lgpd/consent-config — categorias de consentimento + banner da org.
router.get("/consent-config", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(LgpdService.getConsentConfig(orgId)); }
  catch (e: any) { res.status(500).json({ error: e.message }); }
});

// PUT /api/lgpd/consent-config — atualiza categorias + banner + versão.
router.put("/consent-config", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const { categories, bannerText, policyVersion } = req.body || {};
    LgpdService.updateConsentConfig(orgId, { categories, bannerText, policyVersion });
    res.json({ success: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// GET /api/lgpd/consent-summary — resumo de consentimentos por tipo.
router.get("/consent-summary", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json({ summary: LgpdService.getConsentSummary(orgId) }); }
  catch (e: any) { res.status(500).json({ error: e.message }); }
});

// GET /api/lgpd/contact/:id/consents — todos os consentimentos de um contato.
router.get("/contact/:id/consents", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json({ consents: LgpdService.getConsentsForContact(orgId, req.params.id) }); }
  catch (e: any) { res.status(500).json({ error: e.message }); }
});

// POST /api/lgpd/contact/:id/consents — concede ou revoga consentimento.
router.post("/contact/:id/consents", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  const userId = req.user?.userId;
  if (!orgId || !userId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const { consentType, action, legalBasis, channel } = req.body || {};
    if (!consentType) return res.status(400).json({ error: "consentType obrigatório" });
    const config = LgpdService.getConsentConfig(orgId);
    if (action === 'revoke') {
      const ok = LgpdService.revokeConsent(orgId, req.params.id, consentType, userId);
      return res.json({ success: ok });
    }
    const id = LgpdService.grantConsent(orgId, req.params.id, consentType, {
      legalBasis, policyVersion: config.policyVersion, channel, actorId: userId,
    });
    res.json({ success: true, id });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;
