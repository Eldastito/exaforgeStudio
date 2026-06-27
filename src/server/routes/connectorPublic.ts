import { Router } from "express";
import db from "../db.js";
import { ReservationService } from "../ReservationService.js";

/**
 * Entrada AGNÓSTICA do conector (PMS/OTA/ERP/middleware). Autenticada por TOKEN
 * de integração da organização (não por JWT) — qualquer sistema externo pode
 * empurrar disponibilidade/preço por data, ou sincronizar recursos.
 *
 * Token via header `x-connector-token` ou query `?token=`.
 */
const router = Router();

function orgByToken(req: any): string | null {
  const token = String(req.headers["x-connector-token"] || req.query.token || "").trim();
  if (!token || !token.startsWith("zf_")) return null;
  const o = db.prepare(`SELECT organization_id FROM organization_settings WHERE integration_token = ?`).get(token) as any;
  return o?.organization_id || null;
}

// POST /api/connector-in/availability — { rows: [{ resource, date, available, price }] }
router.post("/availability", (req, res): any => {
  const orgId = orgByToken(req);
  if (!orgId) return res.status(401).json({ error: "Token de integração inválido." });
  try {
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : (Array.isArray(req.body) ? req.body : []);
    const result = ReservationService.setAvailability(orgId, rows, "webhook");
    res.json({ success: true, ...result });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// POST /api/connector-in/resources — { rows: [{ name, price, capacity, unit }] }
router.post("/resources", (req, res): any => {
  const orgId = orgByToken(req);
  if (!orgId) return res.status(401).json({ error: "Token de integração inválido." });
  try {
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : (Array.isArray(req.body) ? req.body : []);
    res.json({ success: true, report: ReservationService.importResources(orgId, rows) });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;
