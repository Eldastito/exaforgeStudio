/**
 * TESTE — Continuity Layer Fase 4c: reconciliação bidirecional (ADR-082)
 * ---------------------------------------------------------------------
 * Fecha o loop Edge↔Cloud, offline e com dois SQLite separados:
 *
 *   Edge→Cloud: comandos empurrados (Fase 4a, status 'received') são EXECUTADOS
 *   pelo EdgeInboxProcessor — handler por tipo (registry + padrão) marca
 *   'processed' e ANEXA um domain_event.
 *
 *   Cloud→Edge: o nó puxa esses eventos e o EdgeInboxApplicator os aplica na
 *   projeção local (edge_aggregates), em ordem de seq, idempotente (LWW).
 *
 *   Loop completo: comando do nó → nuvem processa → evento → nó puxa → projeta.
 *
 * Uso:  npm run test:edge-reconcile
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const cloudDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-recon-cloud-"));
const edgeDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-recon-node-"));
process.env.DATA_DIR = cloudDir;
process.env.EDGE_DATA_DIR = edgeDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-edge-recon-1234567890";
process.env.CONTINUITY_EVENTS_ENABLED = "true";
process.env.CONTINUITY_EDGE_SYNC_ENABLED = "true";
process.env.EDGE_BCRYPT_ROUNDS = "4";
process.env.CONTINUITY_EDGE_INBOX_MAX_ATTEMPTS = "2"; // p/ testar o teto de falha rápido

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

async function main() {
  const { default: cloudDb } = await import("../src/server/db.js");
  const { ContinuityService } = await import("../src/server/ContinuityService.js");
  const { EdgeSyncService } = await import("../src/server/EdgeSyncService.js");
  const { EdgeInboxProcessor } = await import("../src/server/EdgeInboxProcessor.js");
  const { initEdgeDb } = await import("../apps/edge/db.js");
  const { EdgeOutbox } = await import("../apps/edge/EdgeOutbox.js");
  const { EdgeSyncClient } = await import("../apps/edge/EdgeSyncClient.js");
  const { EdgeInboxApplicator } = await import("../apps/edge/EdgeInboxApplicator.js");

  initEdgeDb();

  const org = `org_${randomUUID().slice(0, 6)}`;
  cloudDb.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'S', 'active')`).run(randomUUID(), org);

  const reg = await EdgeSyncService.register(org, "Nó recon");
  const cloudDevice = (await EdgeSyncService.authenticate(reg.id, reg.key))!;
  const transport = {
    pull: async (after: number, limit: number) => EdgeSyncService.pull(cloudDevice, after, limit),
    push: async (commands: any[]) => EdgeSyncService.push(cloudDevice, commands),
    heartbeat: async (v?: string) => EdgeSyncService.heartbeat(cloudDevice, v),
  };

  // Handler CONCRETO registrado (prova o roteamento por tipo).
  const noteId = "note-" + randomUUID().slice(0, 6);
  EdgeInboxProcessor.registerHandler("CREATE_NOTE", async (ctx) => ({
    resultEvent: { aggregateType: "note", aggregateId: ctx.payload?.noteId, eventType: "note.created", payload: { text: ctx.payload?.text } },
    result: { ok: true },
  }));

  // ---- 1. Edge→Cloud: empurra comandos e a nuvem os EXECUTA ----
  const cNote = randomUUID(), cGeneric = randomUUID();
  EdgeOutbox.enqueue({ commandId: cNote, operationType: "CREATE_NOTE", payload: { noteId, text: "comprar café" } });
  EdgeOutbox.enqueue({ commandId: cGeneric, operationType: "PING", payload: { n: 1 } });
  await EdgeSyncClient.syncOnce(transport as any); // push → nuvem grava 'received'
  const received = cloudDb.prepare(`SELECT COUNT(*) AS c FROM client_commands WHERE organization_id = ? AND status = 'received'`).get(org) as any;
  check("Comandos chegam à nuvem como 'received'", received.c === 2);

  const proc = await EdgeInboxProcessor.processDue();
  check("Processador executa os 2 comandos", proc.processed === 2);
  const noteCmd = cloudDb.prepare(`SELECT status FROM client_commands WHERE organization_id = ? AND command_id = ?`).get(org, cNote) as any;
  check("Comando vira 'processed'", noteCmd.status === "processed");
  const evNote = cloudDb.prepare(`SELECT COUNT(*) AS c FROM domain_events WHERE organization_id = ? AND event_type = 'note.created'`).get(org) as any;
  const evGeneric = cloudDb.prepare(`SELECT COUNT(*) AS c FROM domain_events WHERE organization_id = ? AND event_type = 'edge.command.applied'`).get(org) as any;
  check("Handler concreto anexou note.created", evNote.c === 1);
  check("Handler padrão anexou edge.command.applied", evGeneric.c === 1);
  check("Reprocessar não repete (nada mais 'received')", (await EdgeInboxProcessor.processDue()).processed === 0);

  // ---- 2. Cloud→Edge: o nó puxa esses eventos e PROJETA ----
  const s = await EdgeSyncClient.syncOnce(transport as any);
  check("Nó puxa e aplica os eventos gerados", s.pulled === 2 && s.applied === 2);
  const noteProj = EdgeInboxApplicator.get("note", noteId);
  check("Projeção local do agregado tem o estado", noteProj?.state?.text === "comprar café");
  check("Loop completo: comando do nó reconciliou na projeção local", noteProj?.last_event_type === "note.created" && noteProj.last_seq > 0);

  // ---- 3. Idempotência / ordenação da projeção (LWW por seq) ----
  const applyAgain = EdgeInboxApplicator.applyPending();
  check("Reaplicar o inbox já aplicado é no-op", applyAgain.applied === 0 && applyAgain.projected === 0);

  // Mesmo agregado evoluindo (stage a → b) via delta puxado.
  ContinuityService.append(org, { aggregateType: "ticket", aggregateId: "tk1", eventType: "ticket.created", payload: { stage: "novo" } });
  ContinuityService.append(org, { aggregateType: "ticket", aggregateId: "tk1", eventType: "ticket.stage_changed", payload: { stage: "fechado" } });
  await EdgeSyncClient.syncOnce(transport as any);
  const tk = EdgeInboxApplicator.get("ticket", "tk1");
  check("Projeção reflete o ÚLTIMO estado (LWW por seq)", tk?.state?.stage === "fechado" && tk.last_event_type === "ticket.stage_changed");

  // ---- 4. Falha de handler respeita o teto de tentativas ----
  EdgeInboxProcessor.registerHandler("BOOM", async () => { throw new Error("handler explodiu"); });
  const cBoom = randomUUID();
  EdgeOutbox.enqueue({ commandId: cBoom, operationType: "BOOM", payload: {} });
  await EdgeSyncClient.syncOnce(transport as any); // vira 'received' na nuvem
  const r1 = await EdgeInboxProcessor.processDue();
  check("1ª falha mantém 'received' para retentar", r1.retried === 1 && (cloudDb.prepare(`SELECT status FROM client_commands WHERE command_id = ?`).get(cBoom) as any).status === "received");
  const r2 = await EdgeInboxProcessor.processDue();
  check("Atingido o teto → 'failed'", r2.failed === 1 && (cloudDb.prepare(`SELECT status FROM client_commands WHERE command_id = ?`).get(cBoom) as any).status === "failed");

  console.log("\n=== Continuity Layer — Fase 4c: reconciliação bidirecional (ADR-082) ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
