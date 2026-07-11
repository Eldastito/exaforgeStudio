/**
 * TESTE — Saída do bot pela fila de entrega (ADR-082, Fase 3 aplicada ao bot)
 * --------------------------------------------------------------------------
 * Prova, offline, que as respostas do bot passam a usar a MESMA fila de entrega
 * (retry/backoff) que a rota manual, quando a flag está ligada — e que o
 * caminho inline de sempre é preservado quando desligada.
 *
 *   FILA LIGADA:  deliverBotMessage grava a mensagem 'queued' + enfileira a
 *   entrega (Fase 3) + evento message.queued; a fila entrega e marca 'sent'.
 *
 *   FILA DESLIGADA: caminho inline — tenta o provedor na hora; se falhar, a
 *   mensagem fica 'failed' (com delivery_error) e NÃO cria registro na fila.
 *
 * Uso:  npm run test:bot-outbound
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-bot-out-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-bot-outbound-1234567890";
process.env.CONTINUITY_EVENTS_ENABLED = "true";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { MessageDeliveryService } = await import("../src/server/MessageDeliveryService.js");
  const { deliverBotMessage } = await import("../src/server/botOutbound.js");

  const org = `org_${randomUUID().slice(0, 6)}`;
  const chQueue = randomUUID();     // canal p/ o caminho FILA (sender fake)
  const chInline = randomUUID();    // canal p/ o caminho INLINE (provedor não suportado → falha rápida, sem rede)
  const contactPk = randomUUID();
  const ticketId = randomUUID();
  const recipient = "5511977776666";
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'S', 'active')`).run(randomUUID(), org);
  db.prepare(`INSERT INTO channels (id, organization_id, provider, name, identifier, status) VALUES (?, ?, 'evolution_go', 'Fila', 'inst', 'active')`).run(chQueue, org);
  db.prepare(`INSERT INTO channels (id, organization_id, provider, name, identifier, status) VALUES (?, ?, '__nao_suportado__', 'Inline', 'inst2', 'active')`).run(chInline, org);
  db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, identifier, name) VALUES (?, ?, ?, ?, 'Cliente')`).run(contactPk, org, chQueue, recipient);
  db.prepare(`INSERT INTO tickets (id, organization_id, contact_id, stage) VALUES (?, ?, ?, 'novo')`).run(ticketId, org, contactPk);

  const channelQueue = db.prepare(`SELECT * FROM channels WHERE id = ?`).get(chQueue) as any;
  const channelInline = db.prepare(`SELECT * FROM channels WHERE id = ?`).get(chInline) as any;

  // ---- A. FILA LIGADA ----
  process.env.CONTINUITY_DELIVERY_QUEUE_ENABLED = "true";
  const sent: any[] = [];
  MessageDeliveryService.__setSenderForTests(async (channelId, to, content) => { sent.push({ channelId, to, content }); });

  const a = await deliverBotMessage({ orgId: org, ticketId, contactId: contactPk, channel: channelQueue, recipient, text: "Resposta da IA" });
  check("Fila ligada → mensagem 'queued'", a.status === "queued");
  const amsg = db.prepare(`SELECT delivery_status, sender_type FROM messages WHERE id = ?`).get(a.id) as any;
  check("Mensagem persistida como bot/queued", amsg.sender_type === "bot" && amsg.delivery_status === "queued");
  const adel = db.prepare(`SELECT status, recipient FROM message_deliveries WHERE message_id = ?`).get(a.id) as any;
  check("Entrega enfileirada na fila da Fase 3", !!adel && adel.status === "queued" && adel.recipient === recipient);
  check("Provedor NÃO foi chamado inline (só a fila entrega)", sent.length === 0);
  check("Evento message.queued anexado", (db.prepare(`SELECT COUNT(*) AS c FROM domain_events WHERE organization_id = ? AND event_type = 'message.queued'`).get(org) as any).c === 1);

  await MessageDeliveryService.dispatchDue();
  check("A fila entrega ao provedor (sender fake)", sent.length === 1 && sent[0].to === recipient && sent[0].content === "Resposta da IA");
  check("Mensagem vira 'sent'", (db.prepare(`SELECT delivery_status FROM messages WHERE id = ?`).get(a.id) as any).delivery_status === "sent");

  // ---- B. FILA DESLIGADA (inline, comportamento histórico) ----
  delete process.env.CONTINUITY_DELIVERY_QUEUE_ENABLED;
  const b = await deliverBotMessage({ orgId: org, ticketId, contactId: contactPk, channel: channelInline, recipient, text: "Inline" });
  check("Fila desligada → caminho inline (provedor não suportado falha) → 'failed'", b.status === "failed");
  const bmsg = db.prepare(`SELECT delivery_status, delivery_error FROM messages WHERE id = ?`).get(b.id) as any;
  check("Mensagem inline marcada 'failed' com erro", bmsg.delivery_status === "failed" && !!bmsg.delivery_error);
  check("Inline NÃO cria registro na fila de entrega", (db.prepare(`SELECT COUNT(*) AS c FROM message_deliveries WHERE message_id = ?`).get(b.id) as any).c === 0);

  console.log("\n=== Saída do bot pela fila de entrega (ADR-082) ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
