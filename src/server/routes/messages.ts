import { Router } from "express";
import db from "../db.js";
import { v4 as uuidv4 } from "uuid";
import { logAuthEvent } from "../auditLog.js";
import { MessageProviderService } from "../MessageProviderService.js";
import { MessageDeliveryService } from "../MessageDeliveryService.js";
import { ContinuityService } from "../ContinuityService.js";
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

    // ADR-082 (Fase 0) — corrige a "mensagem fantasma": GRAVA PRIMEIRO (pending),
    // depois envia, e marca sent/failed na própria mensagem. Espelha o fluxo do
    // bot (webhookProcessor). Assim a mensagem NUNCA some do histórico por falha
    // no provedor, e o painel sabe o estado REAL de entrega. O commandId (idem-
    // potência, D3) é aceito quando enviado pelo outbox — se repetido, não
    // duplica: devolve a mensagem já existente.
    const commandId = String(req.body?.commandId || "").trim() || null;
    if (commandId) {
      const dup = db.prepare("SELECT id, delivery_status FROM messages WHERE organization_id = ? AND command_id = ?").get(orgId, commandId) as any;
      if (dup) return res.json({ id: dup.id, status: dup.delivery_status || 'pending', deduped: true });
    }

    const msgId = uuidv4();

    // Continuity Layer (ADR-082, Fase 3 / D6): com a FILA DE ENTREGA ligada, a
    // mensagem é gravada como 'queued' e a entrega ao provedor vira um registro
    // durável que o dispatcher tenta com retry/backoff — o request NÃO bloqueia
    // no provedor e uma queda momentânea não vira falha permanente. O painel é
    // atualizado ao vivo pelo socket `message_delivery_status`. Com a flag
    // desligada, mantém-se o caminho inline de sempre (abaixo).
    if (MessageDeliveryService.enabled()) {
      db.prepare(`
        INSERT INTO messages (id, organization_id, ticket_id, sender_type, content, delivery_status, command_id)
        VALUES (?, ?, ?, 'agent', ?, 'queued', ?)
      `).run(msgId, orgId, ticket.id, text, commandId);
      MessageDeliveryService.enqueue(orgId, {
        messageId: msgId, channelId: channel.id, recipient: contact.identifier, content: text,
        ticketId: ticket.id, commandId,
      });
      if (commandId) ContinuityService.recordCommand(orgId, commandId, { userId, operationType: 'SEND_MESSAGE', result: { id: msgId, status: 'queued' } });
      ContinuityService.append(orgId, { aggregateType: 'message', aggregateId: msgId, eventType: 'message.queued', payload: { ticketId: ticket.id, contactId } });
      logAuthEvent(orgId, userId, contactId, 'MESSAGE_QUEUED', { ticketId: ticket.id });
      return res.json({ id: msgId, status: 'queued' });
    }

    db.prepare(`
      INSERT INTO messages (id, organization_id, ticket_id, sender_type, content, delivery_status, command_id)
      VALUES (?, ?, ?, 'agent', ?, 'pending', ?)
    `).run(msgId, orgId, ticket.id, text, commandId);

    try {
      await MessageProviderService.sendMessage(channel.id, contact.identifier, text);
      db.prepare("UPDATE messages SET delivery_status = 'sent' WHERE id = ?").run(msgId);
      logAuthEvent(orgId, userId, contactId, 'MESSAGE_SENT', { ticketId: ticket.id });
      // Continuity (ADR-082, Fase 1): registra o comando (idempotência durável,
      // além do índice em messages) e anexa o evento de domínio para o delta
      // sync. Ambos best-effort / atrás de flag — não afetam a resposta.
      if (commandId) ContinuityService.recordCommand(orgId, commandId, { userId, operationType: 'SEND_MESSAGE', result: { id: msgId, status: 'sent' } });
      ContinuityService.append(orgId, { aggregateType: 'message', aggregateId: msgId, eventType: 'message.sent', payload: { ticketId: ticket.id, contactId } });
      res.json({ id: msgId, status: 'sent' });
    } catch (sendErr: any) {
      // A mensagem FICA no banco como 'failed' (não some) — o painel mostra o
      // estado real e permite reenviar. Devolve 502 (falha do provedor, não do
      // request) com o id, para o front atualizar o balão para "não enviado".
      const errMsg = String(sendErr?.message || sendErr).slice(0, 500);
      db.prepare("UPDATE messages SET delivery_status = 'failed', delivery_error = ? WHERE id = ?").run(errMsg, msgId);
      logAuthEvent(orgId, userId, contactId, 'MESSAGE_SEND_FAILED', { ticketId: ticket.id, error: errMsg });
      res.status(502).json({ id: msgId, status: 'failed', error: errMsg });
    }
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

