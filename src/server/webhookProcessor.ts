import db from "./db.js";
import { generateRagResponse } from "./geminiRAG.js";
import { AIOrchestratorService } from "./AIOrchestratorService.js";
import { MessageProviderService } from "./MessageProviderService.js";
import { v4 as uuidv4 } from "uuid";
import crypto from "crypto";

export async function processIncomingMessage(
  payload: {
    channelId: string | null;  // DB ID of the channel OR null if mapping by org/identifier
    organizationId: string | null; 
    identifier: string; // The business ID/Instance Name
    provider: 'whatsapp_cloud' | 'instagram' | 'evolution' | 'whatsapp_web';
    senderId: string;
    contactName?: string;
    contactAvatar?: string;
    text: string;
  },
  io: any
) {
  let channel;
  
  if (payload.channelId) {
    channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(payload.channelId) as any;
  } else {
    // try to find channel by identifier
    channel = db.prepare('SELECT * FROM channels WHERE identifier = ? AND provider = ?').get(payload.identifier, payload.provider) as any;
  }

  // Fallback context when channel not yet created (for backward compatibility if requested)
  // But Phase 2 instructs: "Não permitir conexão de canal sem organization_id."
  if (!channel) {
    // If no channel exists, we might reject or create a default if this is a single tenant dev environment.
    // For safety, let's create a default org/channel if it's the legacy evolution behavior
    const orgId = "default_org";
    const chId = uuidv4();
    db.prepare(`
      INSERT INTO channels (id, organization_id, provider, name, identifier, status)
      VALUES (?, ?, ?, ?, ?, 'connected')
    `).run(chId, orgId, payload.provider, payload.identifier || "Default Channel", payload.identifier);
    
    channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(chId) as any;
  }

  if (channel.status === 'disabled') {
     console.log(`[Webhook] Canal ${channel.id} pausado/desabilitado. Ignorando.`);
     return;
  }

  const orgId = channel.organization_id;

  // 1. Resolve Contact
  let contact = db.prepare('SELECT * FROM contacts WHERE organization_id = ? AND channel_id = ? AND identifier = ?')
    .get(orgId, channel.id, payload.senderId) as any;

  if (!contact) {
    const contactId = uuidv4();
    db.prepare(`
      INSERT INTO contacts (id, organization_id, channel_id, name, identifier, profile_pic_url)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(contactId, orgId, channel.id, payload.contactName || payload.senderId, payload.senderId, payload.contactAvatar || null);
    contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(contactId) as any;
  } else {
    // update avatar if provided
    if (payload.contactAvatar && payload.contactAvatar !== contact.profile_pic_url) {
      db.prepare('UPDATE contacts SET profile_pic_url = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run(payload.contactAvatar, contact.id);
    }
  }

  // 2. Resolve Ticket
  let ticket = db.prepare('SELECT * FROM tickets WHERE contact_id = ? AND status = ? ORDER BY created_at DESC LIMIT 1')
    .get(contact.id, 'open') as any;

  if (!ticket) {
    const ticketId = uuidv4();
    db.prepare(`
      INSERT INTO tickets (id, organization_id, contact_id, status, stage, ai_paused)
      VALUES (?, ?, ?, 'open', 'novo_lead', 0)
    `).run(ticketId, orgId, contact.id);
    ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId) as any;
  }

  // 3. Save incoming message
  const msgId = uuidv4();
  db.prepare(`
    INSERT INTO messages (id, organization_id, ticket_id, sender_type, content)
    VALUES (?, ?, ?, 'contact', ?)
  `).run(msgId, orgId, ticket.id, payload.text);

  // 4. Emit to Organization Room (Frontend multi-tenant support)
  if (io) {
    const msgPayload = {
       id: msgId,
       ticketId: ticket.id,
       contactId: contact.id, // for backwards compat tracking
       contactName: contact.name,
       contactAvatar: contact.profile_pic_url,
       provider: channel.provider,
       text: payload.text,
       sender: "contact",
       timestamp: new Date().toISOString()
    };
    io.to(`org:${orgId}`).emit("new_message", msgPayload);
    // Legacy global emit for backward compatibility with current frontend
    io.emit("new_message", msgPayload);
  }

  // 5. Call AI if enabled
  if (channel.ai_enabled === 1 && ticket.ai_paused === 0) {
      try {
       const aiResult = await AIOrchestratorService.processMessage({
          message: payload.text,
          organizationId: orgId,
          senderId: payload.senderId,
          contactName: contact.name,
          channelId: channel.id,
          ticketStage: ticket.stage
       });
       
       if (aiResult.newStage && aiResult.newStage !== ticket.stage) {
          db.prepare('UPDATE tickets SET stage = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(aiResult.newStage, ticket.id);
          if (io) {
            io.to(`org:${orgId}`).emit("ticket_stage_change", { ticketId: ticket.id, contactId: contact.id, newStage: aiResult.newStage });
            io.emit("ticket_stage_change", { contactId: payload.senderId, newStage: aiResult.newStage });
          }
       }

       if (aiResult.needsHuman) {
          db.prepare('UPDATE tickets SET ai_paused = 1 WHERE id = ?').run(ticket.id);
          if (io) {
            io.to(`org:${orgId}`).emit("ticket_ai_paused", { ticketId: ticket.id, contactId: contact.id });
          }
       }
       
       if (aiResult.newAppointment) {
          db.prepare(`
             INSERT INTO appointments (id, organization_id, ticket_id, contact_id, title, scheduled_start)
             VALUES (?, ?, ?, ?, ?, ?)
          `).run(uuidv4(), orgId, ticket.id, contact.id, aiResult.newAppointment.title, aiResult.newAppointment.scheduled_start);
       }
       
       if (aiResult.newDelivery) {
         db.prepare(`
             INSERT INTO deliveries (id, organization_id, ticket_id, contact_id, address)
             VALUES (?, ?, ?, ?, ?)
         `).run(uuidv4(), orgId, ticket.id, contact.id, aiResult.newDelivery.address);
       }

       // Save AI message
       const botMsgId = uuidv4();
       db.prepare(`
         INSERT INTO messages (id, organization_id, ticket_id, sender_type, content)
         VALUES (?, ?, ?, 'bot', ?)
       `).run(botMsgId, orgId, ticket.id, aiResult.reply);

       // Emit AI response to frontend
       if (io) {
          const aiMsgPayload = {
             id: botMsgId,
             ticketId: ticket.id,
             contactId: contact.id,
             provider: channel.provider,
             text: aiResult.reply,
             sender: "bot",
             timestamp: new Date().toISOString()
          };
          io.to(`org:${orgId}`).emit("new_message", aiMsgPayload);
          io.emit("new_message", aiMsgPayload);
       }

       // Send AI response back to provider
       await MessageProviderService.sendMessage(channel.id, payload.senderId, aiResult.reply);

     } catch (e) {
       console.error("[IA RAG] Falha ao processar e responder:", e);
     }
  }
}
