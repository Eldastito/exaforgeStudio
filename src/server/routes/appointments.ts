import { Router } from "express";
import db from "../db.js";
import { v4 as uuidv4 } from "uuid";
import { AuthRequest } from "../middleware/auth.js";
import { GoogleOAuthService } from "../GoogleOAuthService.js";
import { GoogleAutomationService } from "../GoogleAutomationService.js";
import { AppointmentService } from "../AppointmentService.js";
import { logAuthEvent } from "../auditLog.js";

const router = Router();

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

// GET /api/appointments/agenda-settings — configuração de funcionamento da agenda
router.get("/agenda-settings", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    res.json(AppointmentService.config(orgId));
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// PUT /api/appointments/agenda-settings — edita horário/dias/duração/capacidade
router.put("/agenda-settings", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  const userId = req.user?.userId;
  if (!orgId || !userId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const { openHour, closeHour, slotMin, days, capacity } = req.body || {};
    const saved = AppointmentService.saveConfig(orgId, { openHour, closeHour, slotMin, days, capacity });
    logAuthEvent(orgId, userId, undefined, 'AGENDA_SETTINGS_CHANGED', saved);
    res.json(saved);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/", (req: AuthRequest, res) => {
  const orgId = req.organizationId;
  const userId = req.user?.userId;
  if (!orgId || !userId) return res.status(401).json({ error: "Unauthorized" });

    const { ticket_id, contact_id, product_service_id, title, description, scheduled_start, scheduled_end, customer_email } = req.body;
  const id = uuidv4();

  try {
    // Se o fim não veio, calcula a partir da duração configurada da agenda.
    let endIso = scheduled_end;
    if (!endIso && scheduled_start) {
      const startMs = AppointmentService.ms(scheduled_start);
      if (startMs != null) {
        const slotMin = AppointmentService.config(orgId).slotMin;
        endIso = new Date(startMs + slotMin * 60000).toISOString();
      }
    }
    db.prepare(`
      INSERT INTO appointments (id, organization_id, ticket_id, contact_id, product_service_id, title, description, scheduled_start, scheduled_end)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, orgId, ticket_id, contact_id, product_service_id, title, description || '', scheduled_start, endIso);
    // Guarda o e-mail informado no contato (para a confirmação por e-mail).
    if (customer_email && contact_id) {
      try { db.prepare("UPDATE contacts SET email = ? WHERE id = ? AND organization_id = ?").run(String(customer_email).trim(), contact_id, orgId); } catch (e) { /* noop */ }
    }

    logAuthEvent(orgId, userId, id, 'APPOINTMENT_CREATED', { ticket_id });

    // Sincroniza com o Google Calendar + confirmação por e-mail (best-effort).
    GoogleOAuthService.syncAppointment(orgId, id).catch(() => {});
    GoogleAutomationService.confirmAppointment(orgId, id).catch(() => {});

    res.json({ success: true, id });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/appointments/:id — remarcar/editar (sincroniza com o Calendar).
router.patch("/:id", async (req: AuthRequest, res): Promise<any> => {
  const orgId = req.organizationId;
  const userId = req.user?.userId;
  if (!orgId || !userId) return res.status(401).json({ error: "Unauthorized" });
  const a = db.prepare("SELECT * FROM appointments WHERE id = ? AND organization_id = ?").get(req.params.id, orgId) as any;
  if (!a) return res.status(404).json({ error: "Agendamento não encontrado." });
  const b = req.body || {};
  const sets: string[] = []; const vals: any[] = [];
  for (const k of ["title", "description", "scheduled_start", "scheduled_end", "status"]) {
    if (b[k] !== undefined) { sets.push(`${k} = ?`); vals.push(b[k]); }
  }
  if (sets.length) db.prepare(`UPDATE appointments SET ${sets.join(", ")} WHERE id = ? AND organization_id = ?`).run(...vals, req.params.id, orgId);
  logAuthEvent(orgId, userId, req.params.id, 'APPOINTMENT_UPDATED', {});
  // Sincroniza o Google Calendar: cancelou -> remove o evento; senão -> atualiza.
  if (b.status === 'cancelled') {
    GoogleOAuthService.removeAppointmentEvent(orgId, req.params.id).catch(() => {});
  } else {
    GoogleOAuthService.syncAppointmentUpdate(orgId, req.params.id).catch(() => {});
  }
  res.json({ success: true });
});

// DELETE /api/appointments/:id — exclui o agendamento e remove o evento do Google.
router.delete("/:id", async (req: AuthRequest, res): Promise<any> => {
  const orgId = req.organizationId;
  const userId = req.user?.userId;
  if (!orgId || !userId) return res.status(401).json({ error: "Unauthorized" });
  const a = db.prepare("SELECT id FROM appointments WHERE id = ? AND organization_id = ?").get(req.params.id, orgId);
  if (!a) return res.status(404).json({ error: "Agendamento não encontrado." });
  await GoogleOAuthService.removeAppointmentEvent(orgId, req.params.id).catch(() => {});
  db.prepare("DELETE FROM appointments WHERE id = ? AND organization_id = ?").run(req.params.id, orgId);
  logAuthEvent(orgId, userId, req.params.id, 'APPOINTMENT_DELETED', {});
  res.json({ success: true });
});

export default router;
