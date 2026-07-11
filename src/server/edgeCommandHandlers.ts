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

  // TOGGLE_AI — payload: { ticketId?, contactId?, aiPaused }. Pausa/retoma a IA
  // do ticket (espelha /api/messages/toggle-ai). Idempotente (define um valor).
  EdgeInboxProcessor.registerHandler("TOGGLE_AI", async (ctx) => {
    const ticket = resolveTicket(ctx.orgId, ctx.payload);
    const aiPaused = !!ctx.payload?.aiPaused;
    db.prepare("UPDATE tickets SET ai_paused = ? WHERE id = ? AND organization_id = ?").run(aiPaused ? 1 : 0, ticket.id, ctx.orgId);
    emitOrg(ctx.orgId, aiPaused ? "ticket_ai_paused" : "ticket_ai_unpaused", { ticketId: ticket.id });
    return {
      resultEvent: { aggregateType: "ticket", aggregateId: ticket.id, eventType: "ticket.ai_toggled", payload: { aiPaused } },
      result: { ticketId: ticket.id, aiPaused },
    };
  });

  // UPDATE_TICKET_STAGE — payload: { ticketId, stage }. Move o ticket de estágio
  // (espelha PUT /api/tickets/:id/stage), com log e emit. Idempotente.
  EdgeInboxProcessor.registerHandler("UPDATE_TICKET_STAGE", async (ctx) => {
    const stage = String(ctx.payload?.stage || "").trim();
    if (!stage) throw new Error("UPDATE_TICKET_STAGE requer stage");
    const ticket = resolveTicket(ctx.orgId, ctx.payload);
    if (ticket.stage === stage) {
      return { resultEvent: { aggregateType: "ticket", aggregateId: ticket.id, eventType: "ticket.stage_changed", payload: { stage, noop: true } }, result: { ticketId: ticket.id, stage } };
    }
    db.prepare("UPDATE tickets SET stage = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(stage, ticket.id);
    try {
      db.prepare("INSERT INTO ticket_stage_logs (id, organization_id, ticket_id, from_stage, to_stage, changed_by) VALUES (?, ?, ?, ?, ?, ?)")
        .run(randomUUID(), ctx.orgId, ticket.id, ticket.stage, stage, ctx.deviceId || "edge");
    } catch { /* tabela de log é best-effort */ }
    emitOrg(ctx.orgId, "ticket_stage_change", { ticketId: ticket.id, contactId: ticket.contact_id, newStage: stage });
    return {
      resultEvent: { aggregateType: "ticket", aggregateId: ticket.id, eventType: "ticket.stage_changed", payload: { stage, from: ticket.stage } },
      result: { ticketId: ticket.id, stage },
    };
  });
}

/** Resolve o ticket pelo ticketId (org-escopado) ou pelo contactId (último ticket). */
function resolveTicket(orgId: string, payload: any): any {
  const ticketId = String(payload?.ticketId || "").trim();
  if (ticketId) {
    const t = db.prepare("SELECT * FROM tickets WHERE id = ? AND organization_id = ?").get(ticketId, orgId) as any;
    if (t) return t;
  }
  const contactId = String(payload?.contactId || "").trim();
  if (contactId) {
    const c = db.prepare("SELECT id FROM contacts WHERE identifier = ? AND organization_id = ?").get(contactId, orgId) as any;
    if (c) {
      const t = db.prepare("SELECT * FROM tickets WHERE contact_id = ? AND organization_id = ? ORDER BY created_at DESC LIMIT 1").get(c.id, orgId) as any;
      if (t) return t;
    }
  }
  throw new Error("Ticket não encontrado (informe ticketId ou contactId)"); // retenta: pode ainda não ter sido reconciliado
}

/** Emite um evento para a sala da org, se o Socket.IO estiver disponível. */
function emitOrg(orgId: string, event: string, payload: any): void {
  try { const io = (global as any).io; if (io) io.to(`org:${orgId}`).emit(event, payload); } catch { /* nunca quebra o handler */ }
}
