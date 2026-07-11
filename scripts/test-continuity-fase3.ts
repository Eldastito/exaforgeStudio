/**
 * TESTE — Continuity Layer Fase 3: fila de entrega ao provedor (ADR-082, D6)
 * -------------------------------------------------------------------------
 * Prova, offline e em banco temporário (sem provedor real — sender injetado):
 *   - enqueue grava a entrega 'queued' e a mensagem nasce 'queued';
 *   - dispatch com sucesso → 'sent' (na entrega E na mensagem);
 *   - falha transitória (rede) → continua 'queued', conta a tentativa e AGENDA o
 *     próximo attempt no futuro (backoff) — não reprocessa antes da hora;
 *   - quando a hora chega e o provedor volta → entrega ('sent');
 *   - esgotar o teto de tentativas → 'failed' (entrega E mensagem);
 *   - markDelivered promove 'sent' → 'delivered';
 *   - flag desligada = enabled() falso (rollout seguro).
 *
 * Uso:  npm run test:continuity-fase3
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-continuity-f3-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-continuity-f3-1234567890";
// Configura ANTES de importar o serviço (lê no topo do módulo): teto baixo e
// backoff de 60s para provar que a entrega falha fica AGENDADA (não reprocessa).
process.env.CONTINUITY_DELIVERY_MAX_ATTEMPTS = "3";
process.env.CONTINUITY_DELIVERY_BACKOFF_SECONDS = "60,60,60";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { MessageDeliveryService } = await import("../src/server/MessageDeliveryService.js");

  const ORG = `org_${randomUUID().slice(0, 6)}`;

  // Sender injetável: um interruptor de comportamento por cenário.
  let mode: "ok" | "network" = "ok";
  let calls = 0;
  MessageDeliveryService.__setSenderForTests(async () => {
    calls++;
    if (mode === "network") throw new Error("ECONNREFUSED (provedor fora)");
  });

  // Helper: cria uma mensagem 'queued' + enfileira a entrega, como faz a rota.
  const seed = (text: string) => {
    const messageId = randomUUID();
    db.prepare(`INSERT INTO messages (id, organization_id, ticket_id, sender_type, content, delivery_status, command_id)
                VALUES (?, ?, 't1', 'agent', ?, 'queued', ?)`).run(messageId, ORG, text, `cmd_${messageId.slice(0, 6)}`);
    MessageDeliveryService.enqueue(ORG, { messageId, channelId: "ch1", recipient: "5511999", content: text, ticketId: "t1", commandId: `cmd_${messageId.slice(0, 6)}` });
    return messageId;
  };
  const deliv = (messageId: string) => db.prepare(`SELECT * FROM message_deliveries WHERE message_id = ?`).get(messageId) as any;
  const msg = (messageId: string) => db.prepare(`SELECT delivery_status FROM messages WHERE id = ?`).get(messageId) as any;
  const forceDue = (messageId: string) => db.prepare(`UPDATE message_deliveries SET next_attempt_at = CURRENT_TIMESTAMP WHERE message_id = ?`).run(messageId);

  // ---- 0. Flag ----
  delete process.env.CONTINUITY_DELIVERY_QUEUE_ENABLED;
  check("Flag off → enabled() falso", MessageDeliveryService.enabled() === false);
  process.env.CONTINUITY_DELIVERY_QUEUE_ENABLED = "true";
  check("Flag on → enabled() verdadeiro", MessageDeliveryService.enabled() === true);

  // ---- 1. enqueue nasce 'queued' ----
  mode = "ok";
  const m1 = seed("olá");
  check("Entrega nasce 'queued'", deliv(m1)?.status === "queued");
  check("Mensagem nasce 'queued'", msg(m1)?.delivery_status === "queued");

  // ---- 2. dispatch com sucesso → 'sent' ----
  await MessageDeliveryService.dispatchDue();
  check("Sucesso → entrega 'sent'", deliv(m1)?.status === "sent");
  check("Sucesso → mensagem 'sent'", msg(m1)?.delivery_status === "sent");
  check("Sucesso → sent_at preenchido", !!deliv(m1)?.sent_at);

  // ---- 3. falha transitória → continua 'queued' e AGENDA o próximo attempt ----
  mode = "network";
  const m2 = seed("mensagem com provedor fora");
  const sum = await MessageDeliveryService.dispatchDue();
  check("Falha de rede → contabiliza como retentativa", sum.retried === 1 && sum.sent === 0);
  check("Falha transitória → segue 'queued'", deliv(m2)?.status === "queued");
  check("Tentativa foi contada", deliv(m2)?.attempt_count === 1);
  check("Erro registrado", String(deliv(m2)?.last_error || "").includes("ECONNREFUSED"));
  // next_attempt_at está no FUTURO (backoff de 60s) → não é reprocessada agora.
  const sum2 = await MessageDeliveryService.dispatchDue();
  check("Backoff adia: não reprocessa antes da hora", sum2.retried === 0 && deliv(m2)?.attempt_count === 1);

  // ---- 4. quando a hora chega e o provedor volta → entrega ----
  mode = "ok";
  forceDue(m2);
  await MessageDeliveryService.dispatchDue();
  check("Hora chegou + provedor de volta → 'sent'", deliv(m2)?.status === "sent");
  check("Mensagem vira 'sent'", msg(m2)?.delivery_status === "sent");

  // ---- 5. esgotar o teto → 'failed' ----
  mode = "network";
  const m3 = seed("nunca entrega");
  for (let i = 0; i < 3; i++) { forceDue(m3); await MessageDeliveryService.dispatchDue(); } // 3 tentativas = teto
  check("Esgotou o teto → entrega 'failed'", deliv(m3)?.status === "failed");
  check("Esgotou o teto → mensagem 'failed'", msg(m3)?.delivery_status === "failed");
  check("Contou até o teto de tentativas", deliv(m3)?.attempt_count === 3);

  // ---- 6. markDelivered promove 'sent' → 'delivered' ----
  const promoted = MessageDeliveryService.markDelivered(ORG, m1);
  check("markDelivered retorna true", promoted === true);
  check("Entrega vira 'delivered'", deliv(m1)?.status === "delivered");
  check("Mensagem vira 'delivered'", msg(m1)?.delivery_status === "delivered");
  check("delivered_at preenchido", !!deliv(m1)?.delivered_at);

  // ---- 7. isolamento: dispatch não vaza entre mensagens já terminais ----
  check("Provedor foi chamado o esperado (1+1+1+3=6)", calls === 6, `calls=${calls}`);

  console.log("\n=== Continuity Layer — Fase 3: fila de entrega ao provedor (ADR-082) ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
