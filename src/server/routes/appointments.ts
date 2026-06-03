import { Router } from "express";
import db from "../db.js";
import { v4 as uuidv4 } from "uuid";
import { AuthRequest } from "../middleware/auth.js";
import { GoogleOAuthService } from "../GoogleOAuthService.js";

const router = Router();

const logAuthEvent = (orgId: string | undefined, actorId: string | undefined, targetId: string | undefined, eventType: string, meta: any = {}) => {
  try {
    db.prepare(`
      INSERT INTO auth_audit_logs (id, organization_id, actor_user_id, target_user_id, event_type, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(uuidv4(), orgId || null, actorId || null, targetId || null, eventType, JSON.stringify(meta));
  } catch(e) {
    console.error("Failed to log auth event", e);
  }
};

router.get("/", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  const userId = req.user?.userId;
  if (!orgId || !userId) return res.status(401).json({ error: "Unauthorized" });

  try {
    const appointments = db.prepare('SELECT * FROM appointments WHERE organization_id = ?').all(orgId);
    res.json(appointments);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/appointments/reminder-settings — config dos lembretes automáticos
router.get("/reminder-settings", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const o = db.prepare(`SELECT appointment_reminders_enabled, appointment_reminder_hours, appointment_reminder_message FROM organization_settings WHERE organization_id = ?`).get(orgId) as any;
    res.json({
      enabled: !!(o && o.appointment_reminders_enabled),
      hours: o?.appointment_reminder_hours || 24,
      message: o?.appointment_reminder_message || "",
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// PUT /api/appointments/reminder-settings — liga/desliga os lembretes
router.put("/reminder-settings", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  const userId = req.user?.userId;
  if (!orgId || !userId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const { enabled, hours, message } = req.body || {};
    db.prepare(`UPDATE organization_settings SET appointment_reminders_enabled = ?, appointment_reminder_hours = ?, appointment_reminder_message = ? WHERE organization_id = ?`)
      .run(enabled ? 1 : 0, parseInt(String(hours), 10) || 24, message || null, orgId);
    logAuthEvent(orgId, userId, undefined, 'APPOINTMENT_REMINDERS_CHANGED', { enabled, hours });
    res.json({ success: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/", (req: AuthRequest, res) => {
  const orgId = req.organizationId;
  const userId = req.user?.userId;
  if (!orgId || !userId) return res.status(401).json({ error: "Unauthorized" });

  const { ticket_id, contact_id, product_service_id, title, description, scheduled_start, scheduled_end } = req.body;
  const id = uuidv4();

  try {
    db.prepare(`
      INSERT INTO appointments (id, organization_id, ticket_id, contact_id, product_service_id, title, description, scheduled_start, scheduled_end)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, orgId, ticket_id, contact_id, product_service_id, title, description || '', scheduled_start, scheduled_end);
    
    logAuthEvent(orgId, userId, id, 'APPOINTMENT_CREATED', { ticket_id });

    // Sincroniza com o Google Calendar (best-effort, se a conta estiver ligada).
    GoogleOAuthService.syncAppointment(orgId, id).catch(() => {});

    res.json({ success: true, id });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
