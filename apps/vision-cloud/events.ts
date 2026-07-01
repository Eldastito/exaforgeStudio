// Lógica de criação/resolução de eventos técnicos — compartilhada entre o
// monitor de saúde (healthMonitor.ts, detecta gateway offline por timeout de
// heartbeat) e a rota de heartbeat (routes/gateways.ts, detecta recuperação
// no exato momento em que o heartbeat volta). Centralizado aqui para as duas
// pontas nunca duplicarem/divergirem a lógica de "o que é um evento aberto".
import { v4 as uuidv4 } from "uuid";
import db from "./db.js";

export type Severity = "baixa" | "media" | "alta" | "critica";

/**
 * Cria um evento do tipo `eventType` para o gateway, MAS só se não houver
 * um já aberto (status 'detected' ou 'acknowledged') do mesmo tipo — evita
 * inundar o Event Inbox com um evento novo a cada tick do monitor enquanto
 * o gateway permanece offline.
 */
export function createEventIfNotOpen(params: {
  organizationId: string;
  siteId?: string | null;
  gatewayId?: string | null;
  eventType: string;
  severity: Severity;
  payload?: Record<string, unknown>;
}): { created: boolean; eventId?: string } {
  if (params.gatewayId) {
    const existing = db
      .prepare(
        `SELECT id FROM vision_events
         WHERE gateway_id = ? AND event_type = ? AND status IN ('detected', 'acknowledged')`
      )
      .get(params.gatewayId, params.eventType);
    if (existing) return { created: false };
  }

  const id = uuidv4();
  db.prepare(
    `INSERT INTO vision_events (id, organization_id, site_id, gateway_id, event_type, severity, payload_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    params.organizationId,
    params.siteId || null,
    params.gatewayId || null,
    params.eventType,
    params.severity,
    params.payload ? JSON.stringify(params.payload) : null
  );
  return { created: true, eventId: id };
}

/**
 * Resolve automaticamente qualquer evento ABERTO do tipo `eventType` para o
 * gateway — usado quando a condição que gerou o evento deixa de existir
 * (ex.: heartbeat volta depois de "gateway_offline"). Resolução automática
 * é aceitável aqui porque a condição é objetiva (heartbeat chegou ou não),
 * diferente de eventos de IA visual, que exigem revisão humana (PRD §13.3).
 */
export function autoResolveOpenEvents(gatewayId: string, eventType: string): number {
  const result = db
    .prepare(
      `UPDATE vision_events SET status = 'resolved', resolved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE gateway_id = ? AND event_type = ? AND status IN ('detected', 'acknowledged')`
    )
    .run(gatewayId, eventType);
  return result.changes;
}
