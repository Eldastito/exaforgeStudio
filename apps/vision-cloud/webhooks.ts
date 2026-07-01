// Vision Integration Gateway — webhooks de SAÍDA (PRD §16.1/§16.3).
// `enqueueWebhookDeliveries` é o único ponto de entrada: quem cria um evento/
// ocorrência chama isto, e a entrega de verdade (HTTP + assinatura + retry)
// fica em webhookDispatcher.ts — mesma separação "quem decide o QUE aconteceu"
// vs. "quem entrega de fato" que o resto do domínio Vision já usa (ver
// events.ts vs. healthMonitor.ts).
import { v4 as uuidv4 } from "uuid";
import db from "./db.js";

/**
 * Validação best-effort contra SSRF: como o vision-cloud roda no MESMO host
 * que o core (127.0.0.1:PORT, ver server.ts), uma URL de webhook apontando
 * para loopback/rede privada faria este processo chamar serviços internos
 * que não deveriam ser alcançáveis por essa via. Bloqueia os alvos óbvios
 * (IP literal ou "localhost"); NÃO resolve DNS para checar o IP de um
 * hostname público (proteção completa contra DNS rebinding fica para uma
 * fase futura, se/quando isso for exposto a integrações de terceiros de
 * verdade — hoje quem configura a URL é o próprio admin da organização).
 */
export function isSafeWebhookUrl(rawUrl: string): boolean {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;

  // Only for scripts/test-vision-webhooks.ts, which necessarily runs its
  // fake "external system" receiver on loopback — never set in production
  // (mesmo padrão de SUPERVISOR_CORE_SCRIPT/SUPERVISOR_VISION_SCRIPT em
  // scripts/supervisor.ts, aceito só para fins de teste).
  if (process.env.VISION_WEBHOOK_ALLOW_LOOPBACK === "true") return true;

  const host = u.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return false;
  if (host === "0.0.0.0" || host === "::1" || host === "[::1]") return false;

  // IPv4 literal em faixa privada/loopback/link-local.
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    if (a === 127) return false; // loopback
    if (a === 10) return false; // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return false; // 172.16.0.0/12
    if (a === 192 && b === 168) return false; // 192.168.0.0/16
    if (a === 169 && b === 254) return false; // link-local
  }
  return true;
}

const EVENT_TOPICS = [
  "vision.event.detected",
  "vision.incident.created",
  "vision.incident.resolved",
  "vision.panic.activated",
] as const;
export type WebhookEventTopic = (typeof EVENT_TOPICS)[number];
export function isValidWebhookTopic(topic: string): topic is WebhookEventTopic {
  return (EVENT_TOPICS as readonly string[]).includes(topic);
}
export { EVENT_TOPICS };

/**
 * Enfileira uma entrega (linha `pending` em vision_webhook_deliveries) para
 * cada webhook ATIVO da organização inscrito no tópico — o disparo de
 * verdade acontece no próximo tick de webhookDispatcher.ts, então esta
 * função nunca bloqueia quem a chama (não faz nenhuma chamada HTTP).
 */
export function enqueueWebhookDeliveries(organizationId: string, eventType: WebhookEventTopic, payload: Record<string, unknown>): void {
  try {
    const webhooks = db
      .prepare(`SELECT id, event_types FROM vision_webhooks WHERE organization_id = ? AND is_active = 1`)
      .all(organizationId) as { id: string; event_types: string | null }[];
    if (webhooks.length === 0) return;

    const payloadJson = JSON.stringify({ event: eventType, organization_id: organizationId, data: payload });
    const insert = db.prepare(
      `INSERT INTO vision_webhook_deliveries (id, webhook_id, organization_id, event_type, payload_json)
       VALUES (?, ?, ?, ?, ?)`
    );

    for (const w of webhooks) {
      let subscribedTopics: string[] | null = null;
      if (w.event_types) {
        try { subscribedTopics = JSON.parse(w.event_types); } catch { subscribedTopics = null; }
      }
      const subscribed = !subscribedTopics || subscribedTopics.length === 0 || subscribedTopics.includes(eventType);
      if (!subscribed) continue;
      insert.run(uuidv4(), w.id, organizationId, eventType, payloadJson);
    }
  } catch (e) {
    console.error("[Webhooks] Falha ao enfileirar entrega:", e);
  }
}
