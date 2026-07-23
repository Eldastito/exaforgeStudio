import { Router } from "express";
import { AuthRequest, requireRole } from "../middleware/auth.js";
import { GestorCommandService } from "../GestorCommandService.js";
import { BriefingService } from "../BriefingService.js";
import db from "../db.js";

// WhatsApp como interface de gestão (Epic 3, ADR-139). Rotas de configuração +
// preview (simula um comando; SÓ LEITURA, não envia mensagem).
const router = Router();

// GET /api/gestor/flag — estado do opt-in da interface de gestão por WhatsApp.
router.get("/flag", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json({ enabled: GestorCommandService.isEnabled(orgId) });
});

// PUT /api/gestor/flag { enabled } — liga/desliga (gestor).
router.put("/flag", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  db.prepare("UPDATE organization_settings SET wa_gestor_enabled = ? WHERE organization_id = ?").run(req.body?.enabled ? 1 : 0, orgId);
  res.json({ ok: true, enabled: !!req.body?.enabled });
});

// POST /api/gestor/preview { phone, text } — simula a resposta a um comando do
// gestor (autenticação do número + RBAC), sem enviar nada. Só gestores.
router.post("/preview", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const phone = String(req.body?.phone || "").trim();
  const text = String(req.body?.text || "");
  if (!phone) return res.status(400).json({ error: "Informe o número (phone)." });
  res.json(GestorCommandService.handle(orgId, phone, text));
});

// GET /api/gestor/briefing-prefs — preferências de briefing do usuário atual.
router.get("/briefing-prefs", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  const userId = req.user?.userId;
  if (!orgId || !userId) return res.status(401).json({ error: "Unauthorized" });
  res.json(BriefingService.getPrefs(orgId, userId));
});

// PUT /api/gestor/briefing-prefs — atualiza as preferências do usuário atual.
router.put("/briefing-prefs", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  const userId = req.user?.userId;
  if (!orgId || !userId) return res.status(401).json({ error: "Unauthorized" });
  const b = req.body || {};
  const patch: any = {};
  if (b.enabled !== undefined) patch.enabled = !!b.enabled;
  if (typeof b.channel === "string") patch.channel = b.channel;
  if (typeof b.morningTime === "string") patch.morningTime = b.morningTime;
  if (b.days === null || Array.isArray(b.days)) patch.days = b.days;
  if (b.domains === null || Array.isArray(b.domains)) patch.domains = b.domains;
  if (typeof b.mode === "string") patch.mode = b.mode;
  res.json(BriefingService.setPrefs(orgId, userId, patch));
});

// GET /api/gestor/briefing-preview — prévia do briefing matinal (respeita RBAC).
router.get("/briefing-preview", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId || !req.user) return res.status(401).json({ error: "Unauthorized" });
  res.json(BriefingService.buildMorning(orgId, req.user));
});

export default router;
