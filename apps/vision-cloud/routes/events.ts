// Event Inbox (PRD §9.2/§12.3) — lista e revisão humana de eventos técnicos.
// Ver docs/PRD-VISION-VMS.md §13.3: todo evento relevante deve poder ser
// confirmado, descartado (falso positivo) ou marcado como resolvido.
import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import db from "../db.js";
import { VisionRequest, requireAuth, hasVisionRole } from "../auth.js";
import { enqueueWebhookDeliveries } from "../webhooks.js";

const router = Router();
router.use(requireAuth);

router.get("/", (req: VisionRequest, res) => {
  const { status, severity, gateway_id } = req.query;
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
  if (gateway_id) {
    clauses.push("gateway_id = ?");
    args.push(gateway_id);
  }
  const rows = db
    .prepare(`SELECT * FROM vision_events WHERE ${clauses.join(" AND ")} ORDER BY detected_at DESC`)
    .all(...args);
  res.json({ events: rows });
});

router.get("/:id", (req: VisionRequest, res) => {
  const row = db.prepare(`SELECT * FROM vision_events WHERE organization_id = ? AND id = ?`).get(req.organizationId, req.params.id);
  if (!row) return res.status(404).json({ error: "event_not_found" });
  res.json({ event: row });
});

const REVIEW_ACTIONS: Record<string, string> = {
  acknowledge: "acknowledged",
  resolve: "resolved",
  false_positive: "false_positive",
  escalate: "escalated",
};

// PRD §20.1: revisão de evento é permitida a vários papéis operacionais, não
// só vision_admin — quem opera o dia a dia (portaria, segurança, operações)
// precisa poder agir sobre um evento sem depender do admin. "escalate" é
// tratado à parte porque cria uma OCORRÊNCIA (routes/incidents.ts) — só quem
// já gerencia ocorrências pode abrir uma, então essa ação específica exige
// um conjunto de papéis mais restrito que as demais.
const REVIEW_ROLES = ["vision_admin", "security_operator", "operations_manager", "portaria_operator"] as const;
const ESCALATE_ROLES = ["vision_admin", "security_operator", "operations_manager"] as const;

router.post("/:id/review", (req: VisionRequest, res) => {
  const { action } = req.body || {};
  const newStatus = REVIEW_ACTIONS[action];
  if (!newStatus) return res.status(400).json({ error: "invalid_action", allowed: Object.keys(REVIEW_ACTIONS) });

  const allowedRoles = action === "escalate" ? ESCALATE_ROLES : REVIEW_ROLES;
  if (!hasVisionRole(req, allowedRoles)) return res.status(403).json({ error: "vision_role_required", allowed: allowedRoles });

  const existing = db.prepare(`SELECT * FROM vision_events WHERE organization_id = ? AND id = ?`).get(req.organizationId, req.params.id) as any;
  if (!existing) return res.status(404).json({ error: "event_not_found" });

  const resolvedAtClause = newStatus === "resolved" || newStatus === "false_positive" ? "CURRENT_TIMESTAMP" : "resolved_at";
  db.prepare(
    `UPDATE vision_events SET status = ?, resolved_at = ${resolvedAtClause}, updated_at = CURRENT_TIMESTAMP
     WHERE organization_id = ? AND id = ?`
  ).run(newStatus, req.organizationId, req.params.id);

  let incident: any = null;
  if (action === "escalate") {
    const incidentId = uuidv4();
    db.prepare(
      `INSERT INTO vision_incidents (id, organization_id, site_id, gateway_id, source_event_id, title, description, severity, opened_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      incidentId,
      req.organizationId,
      existing.site_id,
      existing.gateway_id,
      existing.id,
      `Escalado do evento ${existing.event_type}`,
      null,
      existing.severity,
      req.userId || null
    );
    incident = db.prepare(`SELECT * FROM vision_incidents WHERE id = ?`).get(incidentId);
    enqueueWebhookDeliveries(req.organizationId!, "vision.incident.created", incident as any);
  }

  const row = db.prepare(`SELECT * FROM vision_events WHERE id = ?`).get(req.params.id);
  res.json({ event: row, incident });
});

export default router;
