import { Router } from "express";
import db from "../db.js";
import { randomBytes } from "crypto";
import { AuthRequest } from "../middleware/auth.js";
import { ReservationService } from "../ReservationService.js";

const router = Router();

function getOrCreateToken(orgId: string): string {
  const o = db.prepare(`SELECT integration_token FROM organization_settings WHERE organization_id = ?`).get(orgId) as any;
  if (o?.integration_token) return o.integration_token;
  const token = `zf_${randomBytes(24).toString("hex")}`;
  db.prepare(`UPDATE organization_settings SET integration_token = ? WHERE organization_id = ?`).run(token, orgId);
  return token;
}

// GET /api/connector/token — token de integração + URLs de entrada.
router.get("/token", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    res.json({ token: getOrCreateToken(orgId), inboundPath: "/api/connector-in" });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// POST /api/connector/token/rotate — gera um token novo (invalida o anterior).
router.post("/token/rotate", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const token = `zf_${randomBytes(24).toString("hex")}`;
    db.prepare(`UPDATE organization_settings SET integration_token = ? WHERE organization_id = ?`).run(token, orgId);
    res.json({ token });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// POST /api/connector/resources/import — importa recursos em lote (planilha).
// body: { rows: [{ name, price, capacity, unit }] }
router.post("/resources/import", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    if (!rows.length) return res.status(400).json({ error: "Envie ao menos uma linha em 'rows'." });
    res.json({ success: true, report: ReservationService.importResources(orgId, rows) });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// POST /api/connector/availability — define disponibilidade/preço por data (UI).
// body: { rows: [{ resource, date, available, price }] }
router.post("/availability", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    res.json({ success: true, ...ReservationService.setAvailability(orgId, rows, "manual") });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;
