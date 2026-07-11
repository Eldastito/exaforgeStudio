/**
 * ZappFlow Continuity Layer — Fila de entrega ao provedor (ADR-082, Fase 3 / D6).
 *
 * Separa "salvo no ZappFlow" de "entregue ao WhatsApp/Instagram". Em vez de
 * chamar o provedor INLINE no request (onde uma queda de 2s do provedor virava
 * `failed` para sempre — uma tentativa só), a mensagem é gravada na hora e a
 * entrega vira um registro durável em `message_deliveries` que um dispatcher
 * tenta com RETRY + BACKOFF exponencial — exatamente o padrão do
 * `webhookDispatcher` do Vision (apps/vision-cloud), só que no processo core.
 *
 * Ciclo de vida (D9): queued → sent → delivered | failed.
 *   - queued:    persistido, aguardando (ou entre tentativas de) entrega.
 *   - sent:      o provedor aceitou (HTTP 2xx). É o que temos hoje como "enviado".
 *   - delivered: confirmação REAL de entrega ao destinatário — só via webhook de
 *                status do provedor (WhatsApp Cloud `statuses[]`); `markDelivered`
 *                é o gancho pronto para quando esse webhook for ligado.
 *   - failed:    esgotou as tentativas ou erro permanente.
 *
 * Tudo atrás da flag `CONTINUITY_DELIVERY_QUEUE_ENABLED` (default OFF): com a
 * flag desligada a rota `/send` mantém o caminho inline de sempre, intacto.
 *
 * Entrega: um `setInterval` próprio (como o dispatcher do Vision) + um disparo
 * `setImmediate` no enqueue (caminho rápido). Reinício do processo recupera
 * sozinho (o timer volta e pega as linhas `queued` vencidas). Processo único,
 * guarda de reentrância evita ticks sobrepostos.
 */
import { randomUUID } from "node:crypto";
import db from "./db.js";
import { MessageProviderService } from "./MessageProviderService.js";
import { ContinuityService } from "./ContinuityService.js";
import { NotificationService } from "./NotificationService.js";
import { logAuthEvent } from "./auditLog.js";

const DISPATCH_INTERVAL_MS = Number(process.env.CONTINUITY_DELIVERY_DISPATCH_INTERVAL_MS || 15_000);
const MAX_ATTEMPTS = Math.max(1, Number(process.env.CONTINUITY_DELIVERY_MAX_ATTEMPTS || 6));
// Backoff em segundos (configurável só para os testes não esperarem horas).
// Default: 30s, 2min, 10min, 30min, 2h, 6h — igual ao dispatcher do Vision.
const BACKOFF_SECONDS = (process.env.CONTINUITY_DELIVERY_BACKOFF_SECONDS || "30,120,600,1800,7200,21600")
  .split(",")
  .map((s) => Math.max(1, parseInt(s.trim(), 10) || 1));

/** Sender injetável — produção usa o provedor real; testes injetam um fake. */
export type DeliverySender = (channelId: string, recipient: string, content: string) => Promise<void>;
let sender: DeliverySender = async (channelId, recipient, content) => {
  await MessageProviderService.sendMessage(channelId, recipient, content);
};

type DeliveryRow = {
  id: string;
  organization_id: string;
  message_id: string;
  ticket_id: string | null;
  channel_id: string;
  command_id: string | null;
  recipient: string;
  content: string;
  attempt_count: number;
  max_attempts: number;
};

let timer: NodeJS.Timeout | null = null;
let dispatching = false;

export class MessageDeliveryService {
  /** Flag global: com a fila desligada a rota `/send` fica no caminho inline. */
  static enabled(): boolean {
    const v = String(process.env.CONTINUITY_DELIVERY_QUEUE_ENABLED || "").toLowerCase();
    return v === "1" || v === "true" || v === "on";
  }

  /**
   * Enfileira a entrega de uma mensagem já persistida (delivery_status='queued').
   * NUNCA bloqueia o caller — dispara uma tentativa imediata em background.
   */
  static enqueue(orgId: string, input: {
    messageId: string; channelId: string; recipient: string; content: string;
    ticketId?: string | null; commandId?: string | null;
  }): string {
    const id = randomUUID();
    db.prepare(
      `INSERT INTO message_deliveries
         (id, organization_id, message_id, ticket_id, channel_id, command_id, recipient, content, status, max_attempts, next_attempt_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, CURRENT_TIMESTAMP)`
    ).run(id, orgId, input.messageId, input.ticketId || null, input.channelId, input.commandId || null, input.recipient, input.content, MAX_ATTEMPTS);
    // Caminho rápido: tenta já, sem esperar o tick do timer. Só quando o
    // dispatcher está ativo (boot chamou start()); nos testes o timer fica
    // desligado e o dispatch é dirigido manualmente (determinístico).
    if (timer) setImmediate(() => { this.dispatchDue().catch((e) => console.error("[MsgDelivery] dispatch imediato falhou", e)); });
    return id;
  }

  /**
   * Processa todas as entregas vencidas (status='queued' e next_attempt_at <= agora).
   * Reentrância protegida: um dispatch por vez. Retorna um resumo.
   */
  static async dispatchDue(limit = 50): Promise<{ sent: number; retried: number; failed: number }> {
    const summary = { sent: 0, retried: 0, failed: 0 };
    if (dispatching) return summary;
    dispatching = true;
    try {
      const due = db.prepare(
        `SELECT id, organization_id, message_id, ticket_id, channel_id, command_id, recipient, content, attempt_count, max_attempts
           FROM message_deliveries
          WHERE status = 'queued' AND next_attempt_at <= CURRENT_TIMESTAMP
          ORDER BY next_attempt_at ASC
          LIMIT ?`
      ).all(limit) as DeliveryRow[];

      for (const d of due) {
        try {
          const r = await this.attemptOne(d);
          summary[r]++;
        } catch (e) {
          console.error("[MsgDelivery] Falha ao entregar", d.id, e);
        }
      }
    } finally { dispatching = false; }
    return summary;
  }

  /** Uma tentativa de entrega. Retorna o efeito ('sent' | 'retried' | 'failed'). */
  private static async attemptOne(d: DeliveryRow): Promise<"sent" | "retried" | "failed"> {
    const attempt = d.attempt_count + 1;
    const maxAttempts = d.max_attempts || MAX_ATTEMPTS;
    const delaySec = BACKOFF_SECONDS[Math.min(attempt - 1, BACKOFF_SECONDS.length - 1)];

    // PRÉ-CLAIM (lease): já conta a tentativa e empurra next_attempt_at para
    // frente ANTES de chamar o provedor. Se o processo cair no meio do envio, a
    // linha continua 'queued' mas só é reprocessada após o backoff (não entra em
    // loop quente, e um tick concorrente não pega a mesma linha). Semântica
    // at-least-once, como o dispatcher do Vision.
    db.prepare(
      `UPDATE message_deliveries
          SET attempt_count = ?, next_attempt_at = datetime('now', ?), updated_at = CURRENT_TIMESTAMP
        WHERE id = ?`
    ).run(attempt, `+${delaySec} seconds`, d.id);

    try {
      await sender(d.channel_id, d.recipient, d.content);
      this.markSent(d, attempt);
      return "sent";
    } catch (e: any) {
      const errMsg = String(e?.message || e).slice(0, 500);
      if (attempt >= maxAttempts) {
        this.markFailed(d, attempt, errMsg);
        return "failed";
      }
      // Continua 'queued'; next_attempt_at já foi agendado pelo pré-claim.
      db.prepare(`UPDATE message_deliveries SET last_error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(errMsg, d.id);
      return "retried";
    }
  }

  private static markSent(d: DeliveryRow, attempt: number) {
    db.prepare(
      `UPDATE message_deliveries
          SET status = 'sent', attempt_count = ?, sent_at = CURRENT_TIMESTAMP, last_error = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?`
    ).run(attempt, d.id);
    try { db.prepare(`UPDATE messages SET delivery_status = 'sent' WHERE id = ?`).run(d.message_id); } catch { /* noop */ }
    try { logAuthEvent(d.organization_id, "system", d.recipient, "MESSAGE_SENT", { ticketId: d.ticket_id, deliveryId: d.id, attempts: attempt }); } catch { /* noop */ }
    ContinuityService.append(d.organization_id, { aggregateType: "message", aggregateId: d.message_id, eventType: "message.sent", payload: { ticketId: d.ticket_id, deliveryId: d.id } });
    this.emit(d, "sent");
  }

  private static markFailed(d: DeliveryRow, attempt: number, errMsg: string) {
    db.prepare(
      `UPDATE message_deliveries
          SET status = 'failed', attempt_count = ?, last_error = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?`
    ).run(attempt, errMsg, d.id);
    try { db.prepare(`UPDATE messages SET delivery_status = 'failed', delivery_error = ? WHERE id = ?`).run(errMsg, d.message_id); } catch { /* noop */ }
    try { logAuthEvent(d.organization_id, "system", d.recipient, "MESSAGE_SEND_FAILED", { ticketId: d.ticket_id, deliveryId: d.id, attempts: attempt, error: errMsg }); } catch { /* noop */ }
    ContinuityService.append(d.organization_id, { aggregateType: "message", aggregateId: d.message_id, eventType: "message.failed", payload: { ticketId: d.ticket_id, deliveryId: d.id, error: errMsg } });
    this.emit(d, "failed", errMsg);
    // Alerta ao operador: a mensagem não chegou depois de todas as tentativas.
    try {
      NotificationService.push({
        organizationId: d.organization_id,
        title: "Uma mensagem não pôde ser entregue",
        message: `Após ${attempt} tentativas o provedor seguiu recusando. Verifique a conexão do canal. Detalhe: ${errMsg.slice(0, 180)}`,
        type: "alert",
        dedupeKey: `msg_delivery_failed:${d.channel_id}`,
        dedupeWindowMin: 60,
      });
    } catch { /* noop */ }
  }

  /**
   * Marca uma mensagem como ENTREGUE de fato (confirmação do destinatário).
   * Gancho para o webhook de status do provedor (WhatsApp Cloud `statuses[]`),
   * ainda não ligado — quando o for, chama isto para promover sent → delivered.
   */
  static markDelivered(orgId: string, messageId: string): boolean {
    const d = db.prepare(
      `SELECT id, organization_id, message_id, ticket_id, channel_id, command_id, recipient, content, attempt_count, max_attempts
         FROM message_deliveries WHERE organization_id = ? AND message_id = ?`
    ).get(orgId, messageId) as DeliveryRow | undefined;
    if (!d) return false;
    db.prepare(`UPDATE message_deliveries SET status = 'delivered', delivered_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(d.id);
    try { db.prepare(`UPDATE messages SET delivery_status = 'delivered' WHERE id = ?`).run(messageId); } catch { /* noop */ }
    ContinuityService.append(orgId, { aggregateType: "message", aggregateId: messageId, eventType: "message.delivered", payload: { ticketId: d.ticket_id, deliveryId: d.id } });
    this.emit(d, "delivered");
    return true;
  }

  /** Notifica o painel ao vivo. Casa pelo commandId (id do balão otimista) ou pelo id do servidor. */
  private static emit(d: DeliveryRow, status: "queued" | "sent" | "delivered" | "failed", error?: string) {
    try {
      const io = (global as any).io;
      if (io) io.to(`org:${d.organization_id}`).emit("message_delivery_status", {
        id: d.message_id, commandId: d.command_id, ticketId: d.ticket_id, status, ...(error ? { error } : {}),
      });
    } catch { /* nunca deve quebrar a entrega */ }
  }

  /** Inicia o dispatcher (idempotente). Self-gate: não liga com a flag desligada. */
  static start(): void {
    if (timer || !this.enabled()) return;
    timer = setInterval(() => { this.dispatchDue().catch((e) => console.error("[MsgDelivery] tick falhou", e)); }, DISPATCH_INTERVAL_MS);
    console.log("[MsgDelivery] fila de entrega ao provedor iniciada (Continuity Fase 3).");
  }

  static stop(): void {
    if (timer) clearInterval(timer);
    timer = null;
  }

  /** Injeção de sender para testes (offline, sem provedor real). */
  static __setSenderForTests(fn: DeliverySender): void { sender = fn; }
}
