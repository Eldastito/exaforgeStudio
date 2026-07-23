import { Router } from "express";
import { AuthRequest, requireRole } from "../middleware/auth.js";
import { GestorCommandService } from "../GestorCommandService.js";
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

export default router;
