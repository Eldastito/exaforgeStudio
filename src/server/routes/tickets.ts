import { Router } from "express";
import db from "../db.js";
import { v4 as uuidv4 } from "uuid";
import { logAuthEvent } from "../auditLog.js";
import { AuthRequest } from "../middleware/auth.js";
import { HandoffSummaryService } from "../HandoffSummaryService.js";

const router = Router();

// GET /api/tickets — lista os tickets abertos da organização (com contato e última mensagem)
router.get("/", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const rows = db.prepare(`
      SELECT t.id, t.contact_id, t.stage, t.priority, t.ai_paused, t.status, t.assigned_to,
             t.handoff_summary, t.handoff_reason, t.created_at, t.updated_at,
             c.name AS contact_name, c.identifier AS contact_identifier, c.profile_pic_url,
             (SELECT m.content FROM messages m WHERE m.ticket_id = t.id ORDER BY m.created_at DESC LIMIT 1) AS last_message,
             (SELECT m.created_at FROM messages m WHERE m.ticket_id = t.id ORDER BY m.created_at DESC LIMIT 1) AS last_message_at
      FROM tickets t
      JOIN contacts c ON t.contact_id = c.id
      WHERE t.organization_id = ? AND t.status = 'open'
      ORDER BY COALESCE(t.updated_at, t.created_at) DESC
      LIMIT 500
    `).all(orgId);
    res.json(rows);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/:id/take-over", async (req: AuthRequest, res) => {
  const orgId = req.organizationId;
  const userId = req.user?.userId;
  const ticketId = req.params.id;

  if (!orgId || !userId) return res.status(401).json({ error: "Unauthorized" });

  try {
    const ticket = db.prepare('SELECT * FROM tickets WHERE id = ? AND organization_id = ?').get(ticketId, orgId) as any;
    if (!ticket) return res.status(404).json({ error: "Ticket not found" });

    db.prepare('UPDATE tickets SET assigned_to = ?, ai_paused = 1, stage = ? WHERE id = ?').run(userId, 'em_atendimento_humano', ticket.id);

    db.prepare('INSERT INTO ticket_stage_logs (id, organization_id, ticket_id, from_stage, to_stage, changed_by) VALUES (?, ?, ?, ?, ?, ?)')
      .run(uuidv4(), orgId, ticket.id, ticket.stage, 'em_atendimento_humano', userId);

    logAuthEvent(orgId, userId, ticketId, 'TICKET_TAKEN_OVER', { ticketId });

    // TRANSIÇÃO INVISÍVEL: se ainda não há um resumo do handoff, a IA gera agora
    // para o atendente assumir com contexto (sem reler a thread inteira).
    let summary = ticket.handoff_summary || '';
    if (!summary) {
      try {
        summary = await HandoffSummaryService.fromTicket(ticket.id);
        HandoffSummaryService.save(orgId, ticket.id, summary);
      } catch (e) { /* noop */ }
    }

    if ((global as any).io) {
       (global as any).io.to(`org:${orgId}`).emit("ticket_stage_change", { ticketId: ticket.id, newStage: 'em_atendimento_humano' });
       (global as any).io.to(`org:${orgId}`).emit("ticket_ai_paused", { ticketId: ticket.id, summary });
    }

    res.json({ success: true, stage: 'em_atendimento_humano', summary });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/:id/return-to-ai", (req: AuthRequest, res) => {
  const orgId = req.organizationId;
  const userId = req.user?.userId;
  const ticketId = req.params.id;

  if (!orgId || !userId) return res.status(401).json({ error: "Unauthorized" });

  try {
    const ticket = db.prepare('SELECT * FROM tickets WHERE id = ? AND organization_id = ?').get(ticketId, orgId) as any;
    if (!ticket) return res.status(404).json({ error: "Ticket not found" });

    db.prepare('UPDATE tickets SET assigned_to = NULL, ai_paused = 0, stage = ? WHERE id = ?').run('ia_atendendo', ticket.id);
    
    db.prepare('INSERT INTO ticket_stage_logs (id, organization_id, ticket_id, from_stage, to_stage, changed_by) VALUES (?, ?, ?, ?, ?, ?)')
      .run(uuidv4(), orgId, ticket.id, ticket.stage, 'ia_atendendo', userId);

    logAuthEvent(orgId, userId, ticketId, 'TICKET_RETURNED_TO_AI', { ticketId });

    if ((global as any).io) {
       (global as any).io.to(`org:${orgId}`).emit("ticket_stage_change", { ticketId: ticket.id, newStage: 'ia_atendendo' });
       (global as any).io.to(`org:${orgId}`).emit("ticket_ai_unpaused", { ticketId: ticket.id });
    }

    res.json({ success: true, stage: 'ia_atendendo' });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/tickets/:id/stage — move o ticket de estágio no funil (kanban
// drag-and-drop manual). Persiste e registra no histórico de estágios.
router.post("/:id/stage", (req: AuthRequest, res) => {
  const orgId = req.organizationId;
  const userId = req.user?.userId;
  const ticketId = req.params.id;
  const { stage } = req.body || {};

  if (!orgId || !userId) return res.status(401).json({ error: "Unauthorized" });
  if (!stage || typeof stage !== "string") return res.status(400).json({ error: "Missing stage" });

  try {
    const ticket = db.prepare('SELECT * FROM tickets WHERE id = ? AND organization_id = ?').get(ticketId, orgId) as any;
    if (!ticket) return res.status(404).json({ error: "Ticket not found" });
    if (ticket.stage === stage) return res.json({ success: true, stage });

    db.prepare('UPDATE tickets SET stage = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(stage, ticket.id);
    db.prepare('INSERT INTO ticket_stage_logs (id, organization_id, ticket_id, from_stage, to_stage, changed_by) VALUES (?, ?, ?, ?, ?, ?)')
      .run(uuidv4(), orgId, ticket.id, ticket.stage, stage, userId);

    if ((global as any).io) {
      (global as any).io.to(`org:${orgId}`).emit("ticket_stage_change", { ticketId: ticket.id, contactId: ticket.contact_id, newStage: stage });
    }

    res.json({ success: true, stage });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/:id/close", (req: AuthRequest, res) => {
  const orgId = req.organizationId;
  const userId = req.user?.userId;
  const ticketId = req.params.id;
  const { reason, status } = req.body; 

  if (!orgId || !userId) return res.status(401).json({ error: "Unauthorized" });
  if (!status) return res.status(400).json({ error: "Missing classification status" });

  try {
    const ticket = db.prepare('SELECT * FROM tickets WHERE id = ? AND organization_id = ?').get(ticketId, orgId) as any;
    if (!ticket) return res.status(404).json({ error: "Ticket not found" });

    db.prepare('UPDATE tickets SET status = ?, stage = ?, closed_at = CURRENT_TIMESTAMP WHERE id = ?').run('closed', status, ticket.id);
    
    db.prepare('INSERT INTO ticket_closures (id, organization_id, ticket_id, closed_by, result_status, reason) VALUES (?, ?, ?, ?, ?, ?)')
       .run(uuidv4(), orgId, ticket.id, userId, status, reason || null);

    db.prepare('INSERT INTO ticket_stage_logs (id, organization_id, ticket_id, from_stage, to_stage, changed_by) VALUES (?, ?, ?, ?, ?, ?)')
       .run(uuidv4(), orgId, ticket.id, ticket.stage, status, userId);

    logAuthEvent(orgId, userId, ticketId, 'TICKET_CLOSED', { ticketId, status });

    if ((global as any).io) {
       (global as any).io.to(`org:${orgId}`).emit("ticket_stage_change", { ticketId: ticket.id, newStage: status });
    }

    res.json({ success: true, stage: status });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
