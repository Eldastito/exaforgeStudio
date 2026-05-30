import db from "./db.js";
import { generateRagResponse } from "./geminiRAG.js";
import { AIOrchestratorService } from "./AIOrchestratorService.js";
import { OrdersService } from "./OrdersService.js";
import { CustomerProfileService } from "./CustomerProfileService.js";
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
    mediaUrl?: string;
  },
  io: any
) {
  // Resolve a organização do DONO (deploy single-tenant). O owner é criado pelo
  // ensureMasterAdmin em 'default_org'; se houver outro owner, usa o dele.
  // Em multi-tenant futuro, o roteamento deveria ser por instância/canal.
  const ownerRow = db.prepare(
    "SELECT organization_id FROM users WHERE role = 'owner' ORDER BY created_at ASC LIMIT 1"
  ).get() as any;
  const targetOrg = ownerRow?.organization_id || 'default_org';

  let channel;

  if (payload.channelId) {
    channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(payload.channelId) as any;
  } else {
    // Procura o canal pelo identifier dentro da organização do dono.
    channel = db.prepare('SELECT * FROM channels WHERE identifier = ? AND provider = ? AND organization_id = ?')
      .get(payload.identifier, payload.provider, targetOrg) as any;
  }

  // Se ainda não existe, cria o canal na organização do dono.
  if (!channel) {
    const chId = uuidv4();
    db.prepare(`
      INSERT INTO channels (id, organization_id, provider, name, identifier, status)
      VALUES (?, ?, ?, ?, ?, 'connected')
    `).run(chId, targetOrg, payload.provider, payload.identifier || "Default Channel", payload.identifier);

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
    INSERT INTO messages (id, organization_id, ticket_id, sender_type, content, media_url)
    VALUES (?, ?, ?, 'contact', ?, ?)
  `).run(msgId, orgId, ticket.id, payload.text, payload.mediaUrl || null);

  // CRM: registra o último contato e recalcula a temperatura do lead.
  CustomerProfileService.touchContact(contact.id);

  // 4. Emit to Organization Room (Frontend multi-tenant support)
  if (io) {
    const msgPayload = {
       id: msgId,
       ticketId: ticket.id,
       contactId: contact.id, // for backwards compat tracking
       contactName: contact.name,
       contactNumber: contact.identifier, // telefone real, para exibir na UI ao vivo
       contactAvatar: contact.profile_pic_url,
       provider: channel.provider,
       text: payload.text,
       mediaUrl: payload.mediaUrl,
       sender: "contact",
       timestamp: new Date().toISOString()
    };
    io.to(`org:${orgId}`).emit("new_message", msgPayload);
  }

  // 5. Call AI if enabled
  if (channel.ai_enabled === 1 && ticket.ai_paused === 0) {
      try {
       // Histórico da conversa (sem a mensagem atual) para a IA continuar de onde
       // parou, em vez de recomeçar a cada mensagem.
       const historyRows = db.prepare(`
         SELECT sender_type, content FROM messages
         WHERE ticket_id = ? AND id != ?
         ORDER BY created_at DESC LIMIT 20
       `).all(ticket.id, msgId) as any[];
       const history = historyRows.reverse().map(r => ({
         role: r.sender_type === 'contact' ? 'Cliente' : (r.sender_type === 'agent' ? 'Atendente' : 'Assistente'),
         text: r.content,
       }));

       const aiResult = await AIOrchestratorService.processMessage({
          message: payload.text,
          organizationId: orgId,
          senderId: payload.senderId,
          contactName: contact.name,
          channelId: channel.id,
          ticketStage: ticket.stage,
          history,
          contactId: contact.id,
       });
       
       if (aiResult.newStage && aiResult.newStage !== ticket.stage) {
          db.prepare('UPDATE tickets SET stage = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(aiResult.newStage, ticket.id);
          if (io) {
            io.to(`org:${orgId}`).emit("ticket_stage_change", { ticketId: ticket.id, contactId: contact.id, newStage: aiResult.newStage });
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

       // PEDIDO criado pela IA (canal de venda). O servidor valida o estoque de
       // novo (atômico) e reserva/baixa conforme o interruptor de autonomia.
       if (aiResult.newOrder && Array.isArray(aiResult.newOrder.items) && aiResult.newOrder.items.length) {
         try {
           // Trava anti-duplicidade: evita reservar o mesmo pedido várias vezes
           // quando o cliente responde "sim" repetidas vezes.
           if (OrdersService.hasRecentDuplicate(orgId, ticket.id, aiResult.newOrder.items)) {
             console.log(`[Vendas] Pedido duplicado ignorado para o ticket ${ticket.id}.`);
           } else {
             const order = OrdersService.createOrder(orgId, {
               contactId: contact.id,
               ticketId: ticket.id,
               items: aiResult.newOrder.items,
               createdBy: 'ai',
               autoClose: aiResult.newOrder.autoClose,
             });
             if (io) io.to(`org:${orgId}`).emit("order_created", { orderId: order.id, status: order.status, total: order.total, contactId: contact.id });
             console.log(`[Vendas] Pedido criado pela IA: ${order.id} (status ${order.status}, total ${order.total})`);
           }
         } catch (e) {
           console.error("[Vendas] Falha ao criar pedido da IA (provável estoque insuficiente):", e);
         }
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
       }

       // Send AI response back to provider
       await MessageProviderService.sendMessage(channel.id, payload.senderId, aiResult.reply);

     } catch (e) {
       console.error("[IA RAG] Falha ao processar e responder:", e);
     }
  }
}
