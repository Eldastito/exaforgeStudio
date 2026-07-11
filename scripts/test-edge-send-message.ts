/**
 * TESTE — Handler real SEND_MESSAGE do Edge (ADR-082, Fase 4c+)
 * ------------------------------------------------------------
 * Prova, offline, o caminho de negócio ponta a ponta: um comando SEND_MESSAGE
 * empurrado por um nó Edge (Fase 4a) é EXECUTADO na nuvem (EdgeInboxProcessor +
 * handler embutido), virando uma mensagem persistida + entrega via a fila do
 * provedor (Fase 3), com idempotência pelo command_id.
 *
 *   - o comando 'received' vira mensagem 'queued' + entrega enfileirada;
 *   - a fila de entrega (sender fake) marca a mensagem 'sent';
 *   - domain_events registram message.queued e message.sent (fecha o loop);
 *   - reprocessar o mesmo command_id NÃO duplica a mensagem (idempotência);
 *   - comando com contato inexistente fica 'received' para retentar (não perde).
 *
 * Uso:  npm run test:edge-send-message
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-edge-sendmsg-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-edge-sendmsg-1234567890";
process.env.CONTINUITY_EVENTS_ENABLED = "true";
process.env.CONTINUITY_EDGE_SYNC_ENABLED = "true";
process.env.CONTINUITY_DELIVERY_QUEUE_ENABLED = "true";
process.env.EDGE_BCRYPT_ROUNDS = "4";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { EdgeSyncService } = await import("../src/server/EdgeSyncService.js");
  const { EdgeInboxProcessor } = await import("../src/server/EdgeInboxProcessor.js");
  const { MessageDeliveryService } = await import("../src/server/MessageDeliveryService.js");
  const { registerBuiltinEdgeCommandHandlers } = await import("../src/server/edgeCommandHandlers.js");

  registerBuiltinEdgeCommandHandlers();

  // Sender fake da fila de entrega (não chama provedor real).
  const sent: { channelId: string; recipient: string; content: string }[] = [];
  MessageDeliveryService.__setSenderForTests(async (channelId, recipient, content) => { sent.push({ channelId, recipient, content }); });

  // Fixtures: org, canal, contato, ticket.
  const org = `org_${randomUUID().slice(0, 6)}`;
  const channelId = randomUUID();
  const contactPk = randomUUID();
  const ticketId = randomUUID();
  const recipient = "5511988887777";
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'S', 'active')`).run(randomUUID(), org);
  db.prepare(`INSERT INTO channels (id, organization_id, provider, name, identifier, status) VALUES (?, ?, 'evolution_go', 'Canal', 'inst-1', 'active')`).run(channelId, org);
  db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, identifier, name) VALUES (?, ?, ?, ?, 'Cliente')`).run(contactPk, org, channelId, recipient);
  db.prepare(`INSERT INTO tickets (id, organization_id, contact_id, stage) VALUES (?, ?, ?, 'novo')`).run(ticketId, org, contactPk);

  // Nó Edge provisionado empurra o comando (== rota /api/edge/push).
  const reg = await EdgeSyncService.register(org, "Nó");
  const device = (await EdgeSyncService.authenticate(reg.id, reg.key))!;
  const cmd = randomUUID();
  EdgeSyncService.push(device, [{ commandId: cmd, operationType: "SEND_MESSAGE", payload: { contactId: recipient, text: "Olá do Edge!" } }]);
  check("Comando SEND_MESSAGE chega como 'received'", (db.prepare(`SELECT status FROM client_commands WHERE command_id = ?`).get(cmd) as any).status === "received");

  // ---- Execução na nuvem ----
  const proc = await EdgeInboxProcessor.processDue();
  check("Processador executa o comando", proc.processed === 1);
  const msg = db.prepare(`SELECT id, delivery_status, content FROM messages WHERE organization_id = ? AND command_id = ?`).get(org, cmd) as any;
  check("Mensagem persistida 'queued' com o command_id", !!msg && msg.delivery_status === "queued" && msg.content === "Olá do Edge!");
  const del = db.prepare(`SELECT status, recipient FROM message_deliveries WHERE organization_id = ? AND message_id = ?`).get(org, msg.id) as any;
  check("Entrega enfileirada na fila da Fase 3", !!del && del.status === "queued" && del.recipient === recipient);
  check("Evento message.queued anexado", (db.prepare(`SELECT COUNT(*) AS c FROM domain_events WHERE organization_id = ? AND event_type = 'message.queued'`).get(org) as any).c === 1);

  // ---- Entrega ----
  await MessageDeliveryService.dispatchDue();
  check("Fila entrega ao provedor (sender fake chamado)", sent.length === 1 && sent[0].recipient === recipient && sent[0].content === "Olá do Edge!");
  check("Mensagem vira 'sent'", (db.prepare(`SELECT delivery_status FROM messages WHERE id = ?`).get(msg.id) as any).delivery_status === "sent");
  check("Evento message.sent anexado (loop fechado)", (db.prepare(`SELECT COUNT(*) AS c FROM domain_events WHERE organization_id = ? AND event_type = 'message.sent'`).get(org) as any).c === 1);

  // ---- Idempotência: reprocessar não duplica ----
  db.prepare(`UPDATE client_commands SET status = 'received' WHERE command_id = ?`).run(cmd); // força reprocessamento
  await EdgeInboxProcessor.processDue();
  check("Reprocessar o mesmo command_id NÃO duplica a mensagem", (db.prepare(`SELECT COUNT(*) AS c FROM messages WHERE organization_id = ? AND command_id = ?`).get(org, cmd) as any).c === 1);

  // ---- Contato inexistente: fica 'received' para retentar ----
  const bad = randomUUID();
  EdgeSyncService.push(device, [{ commandId: bad, operationType: "SEND_MESSAGE", payload: { contactId: "0000000000", text: "x" } }]);
  await EdgeInboxProcessor.processDue();
  check("Comando com contato inexistente fica 'received' (retenta, não perde)", (db.prepare(`SELECT status FROM client_commands WHERE command_id = ?`).get(bad) as any).status === "received");
  check("Nenhuma mensagem criada para o comando inválido", (db.prepare(`SELECT COUNT(*) AS c FROM messages WHERE organization_id = ? AND command_id = ?`).get(org, bad) as any).c === 0);

  console.log("\n=== Handler real SEND_MESSAGE do Edge (ADR-082, Fase 4c+) ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
