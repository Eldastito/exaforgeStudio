import { Router } from "express";
import db from "../db.js";
import { v4 as uuidv4 } from "uuid";
import { logAuthEvent } from "../auditLog.js";
import { MessageProviderService } from "../MessageProviderService.js";
import { AuthRequest } from "../middleware/auth.js";

const router = Router();

// GET /api/messages/:ticketId — histórico de mensagens de um ticket
router.get("/:ticketId", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const rows = db.prepare(`
      SELECT id, ticket_id, sender_type, content, media_url, created_at
      FROM messages
      WHERE ticket_id = ? AND organization_id = ?
      ORDER BY created_at ASC
    `).all(req.params.ticketId, orgId);
    res.json(rows);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/send", async (req: AuthRequest, res) => {
  const orgId = req.organizationId;
  const userId = req.user?.userId;
  const { contactId, text } = req.body;
  
  if (!orgId || !userId) return res.status(401).json({ error: "Unauthorized" });
  if (!contactId || !text) return res.status(400).json({ error: "Missing contactId or text" });

  try {
    const contact = db.prepare('SELECT * FROM contacts WHERE identifier = ? AND organization_id = ?').get(contactId, orgId) as any;
    if (!contact) return res.status(404).json({ error: "Contact not found" });

    const ticket = db.prepare('SELECT * FROM tickets WHERE contact_id = ? AND organization_id = ? ORDER BY created_at DESC LIMIT 1').get(contact.id, orgId) as any;
    if (!ticket) return res.status(404).json({ error: "Ticket not found" });

    const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(contact.channel_id) as any;
    if (!channel) return res.status(404).json({ error: "Channel not found" });

    await MessageProviderService.sendMessage(channel.id, contact.identifier, text);

    const msgId = uuidv4();
    db.prepare(`
      INSERT INTO messages (id, organization_id, ticket_id, sender_type, content)
      VALUES (?, ?, ?, 'agent', ?)
    `).run(msgId, orgId, ticket.id, text);

    logAuthEvent(orgId, userId, contactId, 'MESSAGE_SENT', { ticketId: ticket.id });

    res.json({ id: msgId, status: 'sent' });
  } catch (e: any) {
    console.error("Failed to send message:", e);
    res.status(500).json({ error: e.message });
  }
});

router.post("/toggle-ai", async (req: AuthRequest, res) => {
  const orgId = req.organizationId;
  const userId = req.user?.userId;
  const { contactId, ai_paused } = req.body;
  if (!orgId || !userId) return res.status(401).json({ error: "Unauthorized" });
  if (!contactId) return res.status(400).json({ error: "Missing contactId" });
  try {
    const contact = db.prepare('SELECT * FROM contacts WHERE identifier = ? AND organization_id = ?').get(contactId, orgId) as any;
    if (!contact) return res.status(404).json({ error: "Contact not found" });
    const ticket = db.prepare('SELECT * FROM tickets WHERE contact_id = ? AND organization_id = ? ORDER BY created_at DESC LIMIT 1').get(contact.id, orgId) as any;
    if (!ticket) return res.status(404).json({ error: "Ticket not found" });

    db.prepare('UPDATE tickets SET ai_paused = ? WHERE id = ?').run(ai_paused ? 1 : 0, ticket.id);
    
    logAuthEvent(orgId, userId, ticket.id, 'TICKET_AI_TOGGLED', { ai_paused });

    res.json({ message: "AI updated" });
  } catch(e) {
    res.status(500).json({ error: "Error updating ticket" });
  }
});

export default router;

