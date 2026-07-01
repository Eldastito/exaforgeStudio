// Ocorrências (PRD §12/§15) — abertas manualmente, escaladas a partir de um
// evento (ver routes/events.ts, ação "escalate"), ou pelo botão de pânico
// (routes/panic.ts).
import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import db from "../db.js";
import { VisionRequest, requireAuth, requireVisionRole } from "../auth.js";

const router = Router();
router.use(requireAuth);

const MANAGE_ROLES = ["vision_admin", "security_operator", "operations_manager"] as const;

router.get("/", (req: VisionRequest, res) => {
  const { status, severity } = req.query;
  const clauses = ["organization_id = ?"];
  const args: any[] = [req.organizationId];
  if (status) {
    clauses.push("status = ?");
    args.push(status);
  }
  if (severity) {
    clauses.push("severity = ?");
    args.push(severity);
  }
  const rows = db.prepare(`SELECT * FROM vision_incidents WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC`).all(...args);
  res.json({ incidents: rows });
});

router.get("/:id", (req: VisionRequest, res) => {
  const row = db.prepare(`SELECT * FROM vision_incidents WHERE organization_id = ? AND id = ?`).get(req.organizationId, req.params.id);
  if (!row) return res.status(404).json({ error: "incident_not_found" });
  res.json({ incident: row });
});

router.post("/", requireVisionRole(MANAGE_ROLES), (req: VisionRequest, res) => {
  const { title, description, severity, site_id, gateway_id } = req.body || {};
  if (!title) return res.status(400).json({ error: "title_required" });

  const id = uuidv4();
  db.prepare(
    `INSERT INTO vision_incidents (id, organization_id, site_id, gateway_id, title, description, severity, opened_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, req.organizationId, site_id || null, gateway_id || null, title, description || null, severity || "media", req.userId || null);

  const row = db.prepare(`SELECT * FROM vision_incidents WHERE id = ?`).get(id);
  res.status(201).json({ incident: row });
});

router.post("/:id/resolve", requireVisionRole(MANAGE_ROLES), (req: VisionRequest, res) => {
  const existing = db.prepare(`SELECT * FROM vision_incidents WHERE organization_id = ? AND id = ?`).get(req.organizationId, req.params.id) as any;
  if (!existing) return res.status(404).json({ error: "incident_not_found" });
  if (existing.status === "resolved") return res.status(400).json({ error: "already_resolved" });

  db.prepare(
    `UPDATE vision_incidents SET status = 'resolved', resolved_by = ?, resolved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
     WHERE organization_id = ? AND id = ?`
  ).run(req.userId || null, req.organizationId, req.params.id);

  const row = db.prepare(`SELECT * FROM vision_incidents WHERE id = ?`).get(req.params.id);
  res.json({ incident: row });
});

export default router;
