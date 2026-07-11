/**
 * Saída de mensagens do BOT (ADR-082, Fase 3 aplicada ao bot).
 *
 * Unifica o padrão "persistir → emitir no painel → entregar ao provedor" que
 * estava repetido em vários pontos do webhookProcessor, e — o ponto desta
 * mudança — passa a rotear as respostas do bot pela FILA DE ENTREGA (Fase 3)
 * quando ela está ligada. Antes, só a rota manual `/api/messages/send` usava a
 * fila; o bot (a maior parte do tráfego de saída) enviava inline, sem retry.
 *
 * Com a fila ligada (CONTINUITY_DELIVERY_QUEUE_ENABLED): grava a mensagem
 * 'queued' e delega a entrega ao dispatcher (retry/backoff, queued→sent→
 * delivered/failed, atualização ao vivo por `message_delivery_status`). Com a
 * flag desligada: mantém EXATAMENTE o caminho inline de sempre (persistir,
 * enviar, marcar sent/failed, alertar no painel).
 */
import db from "./db.js";
import { v4 as uuidv4 } from "uuid";
import { MessageProviderService } from "./MessageProviderService.js";
import { MessageDeliveryService } from "./MessageDeliveryService.js";
import { ContinuityService } from "./ContinuityService.js";
import { NotificationService } from "./NotificationService.js";

export async function deliverBotMessage(args: {
  orgId: string;
  ticketId: string;
  contactId: string;
  channel: any;        // linha de `channels` (precisa de id e provider)
  recipient: string;   // identifier do destinatário no provedor
  text: string;
  io?: any;            // Socket.IO (opcional)
}): Promise<{ id: string; status: "queued" | "sent" | "failed" }> {
  const { orgId, ticketId, contactId, channel, recipient, text, io } = args;
  const msgId = uuidv4();
  const useQueue = MessageDeliveryService.enabled();

  db.prepare(
    `INSERT INTO messages (id, organization_id, ticket_id, sender_type, content, delivery_status)
     VALUES (?, ?, ?, 'bot', ?, ?)`
  ).run(msgId, orgId, ticketId, text, useQueue ? "queued" : "pending");

  if (io) io.to(`org:${orgId}`).emit("new_message", {
    id: msgId, ticketId, contactId, provider: channel.provider, text, sender: "bot", timestamp: new Date().toISOString(),
  });

  // Caminho FILA (Fase 3): a entrega vira registro durável com retry/backoff.
  if (useQueue) {
    MessageDeliveryService.enqueue(orgId, { messageId: msgId, channelId: channel.id, recipient, content: text, ticketId });
    ContinuityService.append(orgId, { aggregateType: "message", aggregateId: msgId, eventType: "message.queued", payload: { ticketId } });
    return { id: msgId, status: "queued" };
  }

  // Caminho INLINE (flag desligada): comportamento histórico, preservado.
  try {
    await MessageProviderService.sendMessage(channel.id, recipient, text);
    db.prepare(`UPDATE messages SET delivery_status = 'sent' WHERE id = ?`).run(msgId);
    ContinuityService.append(orgId, { aggregateType: "message", aggregateId: msgId, eventType: "message.sent", payload: { ticketId } });
    return { id: msgId, status: "sent" };
  } catch (sendErr: any) {
    const errMsg = String(sendErr?.message || sendErr).slice(0, 500);
    db.prepare(`UPDATE messages SET delivery_status = 'failed', delivery_error = ? WHERE id = ?`).run(errMsg, msgId);
    console.error(`[MessageProvider] Envio do bot falhou (${channel.provider}) para ${recipient}:`, errMsg);
    if (io) io.to(`org:${orgId}`).emit("message_delivery_failed", { id: msgId, ticketId, provider: channel.provider, error: errMsg });
    ContinuityService.append(orgId, { aggregateType: "message", aggregateId: msgId, eventType: "message.failed", payload: { ticketId, error: errMsg } });
    try {
      NotificationService.push({
        organizationId: orgId,
        title: `Resposta da IA não chegou ao ${channel.provider === "instagram" ? "Instagram" : channel.provider}`,
        message: `Reconecte o canal ou verifique escopos/inscrição do webhook. Detalhe: ${errMsg.slice(0, 180)}`,
        type: "alert",
        dedupeKey: `provider_send_failed:${channel.id}`,
        dedupeWindowMin: 60,
      });
    } catch { /* noop */ }
    return { id: msgId, status: "failed" };
  }
}
