/**
 * TESTE — Handlers de comando do Edge: TOGGLE_AI e UPDATE_TICKET_STAGE (ADR-082)
 * ----------------------------------------------------------------------------
 * Prova, offline, que novos comandos concretos entram pelo registry (sem tocar
 * no dispatcher) e são executados na nuvem a partir de um push do nó Edge:
 *
 *   - TOGGLE_AI pausa/retoma a IA do ticket (por ticketId e por contactId);
 *   - UPDATE_TICKET_STAGE move o estágio + grava log + evento; mesmo estágio = no-op;
 *   - comando com ticket inexistente fica 'received' para retentar (não perde).
 *
 * Uso:  npm run test:edge-commands
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-edge-cmds-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-edge-cmds-1234567890";
process.env.CONTINUITY_EVENTS_ENABLED = "true";
process.env.CONTINUITY_EDGE_SYNC_ENABLED = "true";
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
  const { registerBuiltinEdgeCommandHandlers } = await import("../src/server/edgeCommandHandlers.js");

  registerBuiltinEdgeCommandHandlers();

  const org = `org_${randomUUID().slice(0, 6)}`;
  const channelId = randomUUID();
  const contactPk = randomUUID();
  const ticketId = randomUUID();
  const contactIdent = "5511900001111";
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'S', 'active')`).run(randomUUID(), org);
  db.prepare(`INSERT INTO channels (id, organization_id, provider, name, identifier, status) VALUES (?, ?, 'evolution_go', 'C', 'i', 'connected')`).run(channelId, org);
  db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, identifier, name) VALUES (?, ?, ?, ?, 'Cliente')`).run(contactPk, org, channelId, contactIdent);
  db.prepare(`INSERT INTO tickets (id, organization_id, contact_id, stage, ai_paused) VALUES (?, ?, ?, 'novo', 0)`).run(ticketId, org, contactPk);

  const reg = await EdgeSyncService.register(org, "Nó");
  const device = (await EdgeSyncService.authenticate(reg.id, reg.key))!;
  const push = (cmd: any) => EdgeSyncService.push(device, [cmd]);

  // ---- TOGGLE_AI por ticketId ----
  push({ commandId: randomUUID(), operationType: "TOGGLE_AI", payload: { ticketId, aiPaused: true } });
  await EdgeInboxProcessor.processDue();
  check("TOGGLE_AI pausa a IA (ai_paused=1)", (db.prepare(`SELECT ai_paused FROM tickets WHERE id = ?`).get(ticketId) as any).ai_paused === 1);
  check("Evento ticket.ai_toggled anexado", (db.prepare(`SELECT COUNT(*) AS c FROM domain_events WHERE organization_id = ? AND event_type = 'ticket.ai_toggled'`).get(org) as any).c === 1);

  // ---- TOGGLE_AI por contactId (resolve o último ticket) ----
  push({ commandId: randomUUID(), operationType: "TOGGLE_AI", payload: { contactId: contactIdent, aiPaused: false } });
  await EdgeInboxProcessor.processDue();
  check("TOGGLE_AI por contactId retoma a IA (ai_paused=0)", (db.prepare(`SELECT ai_paused FROM tickets WHERE id = ?`).get(ticketId) as any).ai_paused === 0);

  // ---- UPDATE_TICKET_STAGE ----
  push({ commandId: randomUUID(), operationType: "UPDATE_TICKET_STAGE", payload: { ticketId, stage: "ganho" } });
  await EdgeInboxProcessor.processDue();
  check("UPDATE_TICKET_STAGE move o estágio", (db.prepare(`SELECT stage FROM tickets WHERE id = ?`).get(ticketId) as any).stage === "ganho");
  check("Log de mudança de estágio gravado", (db.prepare(`SELECT COUNT(*) AS c FROM ticket_stage_logs WHERE ticket_id = ? AND to_stage = 'ganho'`).get(ticketId) as any).c === 1);
  check("Evento ticket.stage_changed anexado", (db.prepare(`SELECT COUNT(*) AS c FROM domain_events WHERE organization_id = ? AND event_type = 'ticket.stage_changed'`).get(org) as any).c === 1);

  // ---- Mesmo estágio = no-op (sem novo log) ----
  push({ commandId: randomUUID(), operationType: "UPDATE_TICKET_STAGE", payload: { ticketId, stage: "ganho" } });
  await EdgeInboxProcessor.processDue();
  check("Mesmo estágio é no-op (não duplica log)", (db.prepare(`SELECT COUNT(*) AS c FROM ticket_stage_logs WHERE ticket_id = ? AND to_stage = 'ganho'`).get(ticketId) as any).c === 1);

  // ---- Ticket inexistente → fica 'received' para retentar ----
  const bad = randomUUID();
  push({ commandId: bad, operationType: "UPDATE_TICKET_STAGE", payload: { ticketId: "nao-existe", stage: "x" } });
  await EdgeInboxProcessor.processDue();
  check("Comando com ticket inexistente fica 'received' (retenta)", (db.prepare(`SELECT status FROM client_commands WHERE command_id = ?`).get(bad) as any).status === "received");

  console.log("\n=== Handlers de comando do Edge: TOGGLE_AI + UPDATE_TICKET_STAGE (ADR-082) ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
