/**
 * WhatsAppHealthService — PRD WhatsApp Unificado F6.4 (RF-08 §18.6 / CA-10):
 * superfície de SAÚDE do envio pelo operador. Read model DERIVADO (RN-004),
 * isolado por org, TOKEN-SAFE.
 *
 * CA-10: o operador precisa saber QUAL CANAL e QUAL ETAPA falhou "sem consultar
 * token ou conteúdo confidencial", e o usuário ver "ação de recuperação". Aqui a
 * etapa vem do estado da entrega (`message_deliveries`) cruzado com o estado da
 * conexão (`channels.status`) e a taxonomia de falha (F6.2 `failure_class`):
 *   connection → canal desconectado/desabilitado (reconectar);
 *   send_permanent → recusa definitiva (número inválido/opt-out ou finalidade
 *     desligada) — revisar destino/finalidade, NÃO retenta;
 *   send_unknown → resultado indeterminado (reconciliando, não repete às cegas);
 *   queue → mensagens presas na fila (canal lento/indisponível — reconectar);
 *   ok → sem sinal de problema.
 *
 * Nunca expõe token: só conta/estado + um trecho do último erro do PROVEDOR
 * truncado (o `token_encrypted` do canal nunca entra neste caminho).
 */
import db from "./db.js";

const STUCK_ATTEMPTS = Math.max(1, Number(process.env.CONTINUITY_DELIVERY_STUCK_ATTEMPTS || 3));

export type HealthStage = "ok" | "connection" | "queue" | "send_permanent" | "send_unknown";

export interface ChannelHealth {
  channelId: string;
  name: string | null;
  connectionState: string;      // channels.status (connected/disabled/disconnected...)
  stage: HealthStage;
  recoveryHint: string;         // ação prática pro operador/usuário (CA-10)
  counts: { queued: number; stuck: number; sent: number; delivered: number; failedPermanent: number; failedTransient: number; unknown: number };
  oldestQueuedAgeSec: number | null;
  lastError: string | null;     // trecho do erro do provedor, truncado (token-safe)
}

const HINTS: Record<HealthStage, string> = {
  ok: "Canal operando normalmente.",
  connection: "O canal está desconectado. Reconecte o WhatsApp nas configurações do canal para retomar os envios.",
  queue: "Mensagens estão presas na fila deste canal (provedor lento/indisponível). Verifique a conexão e reconecte se necessário.",
  send_permanent: "O provedor recusou de forma definitiva (ex.: número inválido, opt-out ou finalidade desligada). Revise o destino ou libere a finalidade — não vamos repetir automaticamente.",
  send_unknown: "Um envio ficou com resultado indeterminado (o provedor não respondeu). Estamos reconciliando antes de repetir para não duplicar. Confirme com o destinatário se necessário.",
};

export class WhatsAppHealthService {
  /** Saúde por canal da org (etapa + contadores + dica de recuperação). */
  static channelHealth(orgId: string, nowMs = Date.now()): ChannelHealth[] {
    const channels = db.prepare(`SELECT id, name, status FROM channels WHERE organization_id = ? ORDER BY created_at ASC`).all(orgId) as any[];
    return channels.map((ch) => {
      const agg = db.prepare(
        `SELECT
           SUM(CASE WHEN status='queued' THEN 1 ELSE 0 END) AS queued,
           SUM(CASE WHEN status='queued' AND attempt_count >= ? THEN 1 ELSE 0 END) AS stuck,
           SUM(CASE WHEN status='sent' THEN 1 ELSE 0 END) AS sent,
           SUM(CASE WHEN status='delivered' THEN 1 ELSE 0 END) AS delivered,
           SUM(CASE WHEN status='failed' AND failure_class='permanent' THEN 1 ELSE 0 END) AS failed_permanent,
           SUM(CASE WHEN status='failed' AND (failure_class IS NULL OR failure_class='transient') THEN 1 ELSE 0 END) AS failed_transient,
           SUM(CASE WHEN status='unknown' THEN 1 ELSE 0 END) AS unknown,
           MIN(CASE WHEN status='queued' THEN next_attempt_at END) AS oldest_queued
         FROM message_deliveries WHERE organization_id = ? AND channel_id = ?`
      ).get(STUCK_ATTEMPTS, orgId, ch.id) as any;

      const counts = {
        queued: Number(agg?.queued || 0), stuck: Number(agg?.stuck || 0),
        sent: Number(agg?.sent || 0), delivered: Number(agg?.delivered || 0),
        failedPermanent: Number(agg?.failed_permanent || 0),
        failedTransient: Number(agg?.failed_transient || 0),
        unknown: Number(agg?.unknown || 0),
      };

      // Etapa por PRIORIDADE de severidade (a conexão vem primeiro: se o canal
      // está fora, nada mais importa).
      let stage: HealthStage = "ok";
      if (ch.status === "disabled" || ch.status === "disconnected") stage = "connection";
      else if (counts.unknown > 0) stage = "send_unknown";
      else if (counts.failedPermanent > 0) stage = "send_permanent";
      else if (counts.stuck > 0) stage = "queue";

      // Último erro do provedor (token-safe: só texto do provedor, truncado).
      let lastError: string | null = null;
      if (stage === "send_permanent" || stage === "send_unknown" || stage === "queue") {
        const row = db.prepare(
          `SELECT last_error FROM message_deliveries
            WHERE organization_id = ? AND channel_id = ? AND last_error IS NOT NULL
            ORDER BY updated_at DESC LIMIT 1`
        ).get(orgId, ch.id) as any;
        lastError = row?.last_error ? String(row.last_error).slice(0, 180) : null;
      }

      const oldestQueuedAgeSec = agg?.oldest_queued
        ? Math.max(0, Math.round((nowMs - Date.parse(String(agg.oldest_queued).replace(" ", "T") + "Z")) / 1000))
        : null;

      return { channelId: ch.id, name: ch.name ?? null, connectionState: ch.status, stage, recoveryHint: HINTS[stage], counts, oldestQueuedAgeSec, lastError };
    });
  }

  /**
   * Métricas mínimas (§18.6) derivadas por query: falha por classe (etapa),
   * idade máxima de fila, e volumes. Números honestos (0 quando não há dado; a
   * ausência é 0 real, não invenção).
   */
  static metrics(orgId: string, nowMs = Date.now()): {
    failuresByClass: { permanent: number; transient: number; unknown: number };
    queued: number; sent: number; delivered: number;
    queueAgeMaxSec: number | null;
  } {
    const m = db.prepare(
      `SELECT
         SUM(CASE WHEN status='failed' AND failure_class='permanent' THEN 1 ELSE 0 END) AS permanent,
         SUM(CASE WHEN status='failed' AND (failure_class IS NULL OR failure_class='transient') THEN 1 ELSE 0 END) AS transient,
         SUM(CASE WHEN status='unknown' THEN 1 ELSE 0 END) AS unknown,
         SUM(CASE WHEN status='queued' THEN 1 ELSE 0 END) AS queued,
         SUM(CASE WHEN status='sent' THEN 1 ELSE 0 END) AS sent,
         SUM(CASE WHEN status='delivered' THEN 1 ELSE 0 END) AS delivered,
         MIN(CASE WHEN status='queued' THEN next_attempt_at END) AS oldest_queued
       FROM message_deliveries WHERE organization_id = ?`
    ).get(orgId) as any;
    const queueAgeMaxSec = m?.oldest_queued
      ? Math.max(0, Math.round((nowMs - Date.parse(String(m.oldest_queued).replace(" ", "T") + "Z")) / 1000))
      : null;
    return {
      failuresByClass: { permanent: Number(m?.permanent || 0), transient: Number(m?.transient || 0), unknown: Number(m?.unknown || 0) },
      queued: Number(m?.queued || 0), sent: Number(m?.sent || 0), delivered: Number(m?.delivered || 0),
      queueAgeMaxSec,
    };
  }
}
