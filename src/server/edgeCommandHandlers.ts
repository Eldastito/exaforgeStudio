/**
 * Handlers concretos dos comandos vindos dos nós Edge (ADR-082, Fase 4c+).
 *
 * O EdgeInboxProcessor executa comandos `received` por TIPO. Aqui registramos os
 * handlers reais (o registry foi desenhado para isto). O primeiro concreto é o
 * SEND_MESSAGE: um atendente/app no nó Edge dispara uma mensagem OFFLINE; o
 * outbox do nó (Fase 4b) a empurra à nuvem (Fase 4a); e este handler a
 * transforma em ENTREGA REAL, compondo com a fila de entrega ao provedor (Fase
 * 3) — que cuida do retry/backoff e do estado queued→sent→delivered/failed.
 *
 * Idempotência ponta a ponta: a mensagem carrega o `command_id` do Edge e o
 * índice único (organization_id, command_id) em `messages` garante que reenvio/
 * reprocessamento NUNCA duplique a mensagem.
 */
import { randomUUID } from "node:crypto";
import db from "./db.js";
import { EdgeInboxProcessor } from "./EdgeInboxProcessor.js";
import { MessageDeliveryService } from "./MessageDeliveryService.js";

let registered = false;

/** Registra os handlers embutidos (uma vez, no boot). */
export function registerBuiltinEdgeCommandHandlers(): void {
  if (registered) return;
  registered = true;

  // SEND_MESSAGE — payload: { contactId, text }. contactId = identifier do
  // contato (mesmo shape da rota /api/messages/send).
  EdgeInboxProcessor.registerHandler("SEND_MESSAGE", async (ctx) => {
    const contactId = String(ctx.payload?.contactId || "").trim();
    const text = String(ctx.payload?.text || "").trim();
    if (!contactId || !text) throw new Error("SEND_MESSAGE requer contactId e text");

    const contact = db.prepare("SELECT * FROM contacts WHERE identifier = ? AND organization_id = ?").get(contactId, ctx.orgId) as any;
    if (!contact) throw new Error("Contato não encontrado"); // retenta: o contato pode ainda não ter sido reconciliado
    const ticket = db.prepare("SELECT * FROM tickets WHERE contact_id = ? AND organization_id = ? ORDER BY created_at DESC LIMIT 1").get(contact.id, ctx.orgId) as any;
    if (!ticket) throw new Error("Ticket não encontrado");
    const channel = db.prepare("SELECT * FROM channels WHERE id = ?").get(contact.channel_id) as any;
    if (!channel) throw new Error("Canal não encontrado");

    // Idempotência: se a mensagem deste command_id já existe, não recria — só
    // devolve o evento correspondente (a entrega segue seu próprio ciclo).
    const existing = db.prepare("SELECT id, delivery_status FROM messages WHERE organization_id = ? AND command_id = ?").get(ctx.orgId, ctx.commandId) as any;
    if (existing) {
      return {
        resultEvent: { aggregateType: "message", aggregateId: existing.id, eventType: "message.queued", payload: { ticketId: ticket.id, contactId, deduped: true } },
        result: { id: existing.id, status: existing.delivery_status || "queued", deduped: true },
      };
    }

    // Grava a mensagem 'queued' com o command_id do Edge e delega a ENTREGA à
    // fila da Fase 3 (retry/backoff/delivered). Ela marca a messages.delivery_status.
    const msgId = randomUUID();
    db.prepare(
      `INSERT INTO messages (id, organization_id, ticket_id, sender_type, content, delivery_status, command_id)
       VALUES (?, ?, ?, 'agent', ?, 'queued', ?)`
    ).run(msgId, ctx.orgId, ticket.id, text, ctx.commandId);

    MessageDeliveryService.enqueue(ctx.orgId, {
      messageId: msgId, channelId: channel.id, recipient: contact.identifier, content: text,
      ticketId: ticket.id, commandId: ctx.commandId,
    });

    return {
      resultEvent: { aggregateType: "message", aggregateId: msgId, eventType: "message.queued", payload: { ticketId: ticket.id, contactId } },
      result: { id: msgId, status: "queued" },
    };
  });
}
