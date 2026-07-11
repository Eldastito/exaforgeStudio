/**
 * TESTE — Recibos de entrega do WhatsApp ("entregue ✓✓") (ADR-082)
 * ----------------------------------------------------------------
 * Prova, offline, a correlação dos recibos de status do provedor com a fila de
 * entrega (Fase 3), fechando o ciclo queued→sent→delivered/failed:
 *
 *   - o envio guarda o id do provedor (wamid) na entrega (provider_message_id);
 *   - markProviderStatus('delivered'|'read') promove sent→delivered + evento
 *     message.delivered; recibos repetidos NÃO duplicam o evento (idempotente);
 *   - markProviderStatus('failed') marca a entrega/mensagem como failed;
 *   - a correlação do webhook (metadata.phone_number_id → channels.identifier →
 *     org → markProviderStatus pelo wamid) resolve a organização certa;
 *   - wamid desconhecido → no-op seguro.
 *
 * Uso:  npm run test:delivery-receipts
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-receipts-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-receipts-1234567890";
process.env.CONTINUITY_EVENTS_ENABLED = "true";
process.env.CONTINUITY_DELIVERY_QUEUE_ENABLED = "true";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { MessageDeliveryService } = await import("../src/server/MessageDeliveryService.js");

  const org = `org_${randomUUID().slice(0, 6)}`;
  const phoneNumberId = "PHONE_NUMBER_ID_123"; // = channels.identifier no whatsapp_cloud
  const channelId = randomUUID();
  const recipient = "5511966665555";
  const ticketId = randomUUID();
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'S', 'active')`).run(randomUUID(), org);
  db.prepare(`INSERT INTO channels (id, organization_id, provider, name, identifier, status) VALUES (?, ?, 'whatsapp_cloud', 'WA', ?, 'connected')`).run(channelId, org, phoneNumberId);
  db.prepare(`INSERT INTO tickets (id, organization_id, contact_id, stage) VALUES (?, ?, ?, 'novo')`).run(ticketId, org, randomUUID());

  // Sender fake devolve o wamid (como o provedor real faria).
  const WAMID = "wamid.TEST_ABC123";
  MessageDeliveryService.__setSenderForTests(async () => WAMID);

  // Grava a mensagem + enfileira a entrega e despacha (== fluxo real).
  const msgId = randomUUID();
  db.prepare(`INSERT INTO messages (id, organization_id, ticket_id, sender_type, content, delivery_status) VALUES (?, ?, ?, 'agent', 'oi', 'queued')`).run(msgId, org, ticketId);
  MessageDeliveryService.enqueue(org, { messageId: msgId, channelId, recipient, content: "oi", ticketId });
  await MessageDeliveryService.dispatchDue();

  // ---- 1. Envio guarda o wamid ----
  const del = db.prepare(`SELECT status, provider_message_id FROM message_deliveries WHERE message_id = ?`).get(msgId) as any;
  check("Envio marca 'sent' e guarda o wamid", del.status === "sent" && del.provider_message_id === WAMID);

  // ---- 2. Correlação do webhook: phone_number_id → canal → org ----
  const ch = db.prepare(`SELECT organization_id FROM channels WHERE identifier = ? AND provider = 'whatsapp_cloud'`).get(phoneNumberId) as any;
  check("Webhook resolve a org pelo phone_number_id", ch?.organization_id === org);

  // ---- 3. delivered → promove sent→delivered ----
  const okDeliv = MessageDeliveryService.markProviderStatus(ch.organization_id, WAMID, "delivered");
  check("markProviderStatus('delivered') encontra a entrega", okDeliv === true);
  check("Entrega vira 'delivered'", (db.prepare(`SELECT status FROM message_deliveries WHERE message_id = ?`).get(msgId) as any).status === "delivered");
  check("Mensagem vira 'delivered' (✓✓)", (db.prepare(`SELECT delivery_status FROM messages WHERE id = ?`).get(msgId) as any).delivery_status === "delivered");
  check("Evento message.delivered anexado", (db.prepare(`SELECT COUNT(*) AS c FROM domain_events WHERE organization_id = ? AND event_type = 'message.delivered'`).get(org) as any).c === 1);

  // ---- 4. Idempotência: 'read' depois de 'delivered' não duplica ----
  MessageDeliveryService.markProviderStatus(ch.organization_id, WAMID, "read");
  check("Recibo repetido (read) NÃO duplica o evento", (db.prepare(`SELECT COUNT(*) AS c FROM domain_events WHERE organization_id = ? AND event_type = 'message.delivered'`).get(org) as any).c === 1);

  // ---- 5. wamid desconhecido → no-op seguro ----
  check("wamid desconhecido → false (no-op)", MessageDeliveryService.markProviderStatus(org, "wamid.NAO_EXISTE", "delivered") === false);

  // ---- 6. failed → marca falha ----
  const msg2 = randomUUID();
  const WAMID2 = "wamid.FAIL_XYZ";
  MessageDeliveryService.__setSenderForTests(async () => WAMID2);
  db.prepare(`INSERT INTO messages (id, organization_id, ticket_id, sender_type, content, delivery_status) VALUES (?, ?, ?, 'agent', 'x', 'queued')`).run(msg2, org, ticketId);
  MessageDeliveryService.enqueue(org, { messageId: msg2, channelId, recipient, content: "x", ticketId });
  await MessageDeliveryService.dispatchDue();
  MessageDeliveryService.markProviderStatus(org, WAMID2, "failed");
  check("markProviderStatus('failed') marca a entrega failed", (db.prepare(`SELECT status FROM message_deliveries WHERE message_id = ?`).get(msg2) as any).status === "failed");
  check("Mensagem vira 'failed'", (db.prepare(`SELECT delivery_status FROM messages WHERE id = ?`).get(msg2) as any).delivery_status === "failed");

  console.log("\n=== Recibos de entrega do WhatsApp ('entregue ✓✓') (ADR-082) ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
