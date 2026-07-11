/**
 * TESTE — Continuity Layer Fase 4b: runtime do Edge (ADR-082)
 * ----------------------------------------------------------
 * Exercita o ciclo REAL do nó Edge contra o protocolo Cloud da Fase 4a, offline
 * e com DOIS bancos SQLite separados (edge.db do nó × zappflow.db da nuvem). O
 * transporte é in-process: chama o EdgeSyncService real (o mesmo que a rota HTTP
 * usa), então o teste cobre push/pull/heartbeat de verdade sem rede.
 *
 *   - enqueue no outbox local é idempotente (reenfileirar não duplica);
 *   - um ciclo de sync empurra o outbox → nuvem grava em client_commands;
 *   - reenviar deduplica ponta a ponta (mesmo command_id);
 *   - pull traz o delta de domain_events, guarda no edge_inbox e avança o cursor;
 *   - ciclo seguinte não repuxa nada;
 *   - rede caída no push mantém o comando na fila (lease/backoff) e o próximo
 *     ciclo entrega;
 *   - heartbeat registra a versão do agente na nuvem.
 *
 * Uso:  npm run test:edge-runtime
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const cloudDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-edge-cloud-"));
const edgeDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-edge-node-"));
process.env.DATA_DIR = cloudDir;       // nuvem: zappflow.db
process.env.EDGE_DATA_DIR = edgeDir;   // nó: edge.db (separado)
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-edge-runtime-1234567890";
process.env.CONTINUITY_EVENTS_ENABLED = "true";
process.env.CONTINUITY_EDGE_SYNC_ENABLED = "true";
process.env.EDGE_BCRYPT_ROUNDS = "4";
process.env.EDGE_OUTBOX_BACKOFF_SECONDS = "1"; // backoff curto p/ o teste

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

async function main() {
  // Nuvem (Fase 4a).
  const { default: cloudDb } = await import("../src/server/db.js");
  const { ContinuityService } = await import("../src/server/ContinuityService.js");
  const { EdgeSyncService } = await import("../src/server/EdgeSyncService.js");
  // Nó Edge (Fase 4b).
  const { initEdgeDb, default: edgeDb } = await import("../apps/edge/db.js");
  const { EdgeOutbox } = await import("../apps/edge/EdgeOutbox.js");
  const { EdgeSyncClient, getCursor } = await import("../apps/edge/EdgeSyncClient.js");

  initEdgeDb();

  const org = `org_${randomUUID().slice(0, 6)}`;
  cloudDb.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'S', 'active')`).run(randomUUID(), org);

  // Provisiona o nó na nuvem e monta o transporte in-process (== rota HTTP).
  const reg = await EdgeSyncService.register(org, "Nó de teste");
  const cloudDevice = (await EdgeSyncService.authenticate(reg.id, reg.key))!;
  const transport = {
    pull: async (after: number, limit: number) => EdgeSyncService.pull(cloudDevice, after, limit),
    push: async (commands: any[]) => EdgeSyncService.push(cloudDevice, commands),
    heartbeat: async (v?: string) => EdgeSyncService.heartbeat(cloudDevice, v),
  };

  // ---- 1. Outbox local: enqueue idempotente ----
  const c1 = randomUUID(), c2 = randomUUID();
  EdgeOutbox.enqueue({ commandId: c1, operationType: "SEND_MESSAGE", payload: { text: "oi" } });
  EdgeOutbox.enqueue({ commandId: c2, operationType: "SEND_MESSAGE", payload: { text: "tchau" } });
  const dedup = EdgeOutbox.enqueue({ commandId: c1, operationType: "SEND_MESSAGE", payload: { text: "duplicado" } });
  check("Reenfileirar o mesmo command_id não duplica", dedup.deduped === true && EdgeOutbox.pending() === 2);

  // ---- 2. Ciclo de sync empurra o outbox → nuvem ----
  const s1 = await EdgeSyncClient.syncOnce(transport as any, { agentVersion: "9.9.9" });
  check("Push entrega os 2 comandos", s1.pushed.sent === 2 && EdgeOutbox.pending() === 0);
  const inCloud = cloudDb.prepare(`SELECT COUNT(*) AS c FROM client_commands WHERE organization_id = ? AND device_id = ?`).get(org, reg.id) as any;
  check("Nuvem gravou os comandos em client_commands", inCloud.c === 2);
  check("Outbox local marca os comandos como 'sent'", (edgeDb.prepare(`SELECT COUNT(*) AS c FROM edge_outbox WHERE status = 'sent'`).get() as any).c === 2);

  // ---- 3. Idempotência ponta a ponta ----
  EdgeOutbox.enqueue({ commandId: c1, operationType: "SEND_MESSAGE", payload: {} }); // já 'sent' → enqueue deduplica local
  check("Re-enqueue de comando já enviado é no-op local", EdgeOutbox.pending() === 0);

  // ---- 4. Pull do delta ----
  ContinuityService.append(org, { aggregateType: "message", aggregateId: "m1", eventType: "message.sent", payload: { a: 1 } });
  ContinuityService.append(org, { aggregateType: "ticket", aggregateId: "t1", eventType: "ticket.stage_changed" });
  const s2 = await EdgeSyncClient.syncOnce(transport as any);
  check("Pull traz o delta de eventos", s2.pulled === 2);
  check("edge_inbox guardou os eventos", (edgeDb.prepare(`SELECT COUNT(*) AS c FROM edge_inbox`).get() as any).c === 2);
  check("Cursor do nó avançou", getCursor() === 2);
  const s3 = await EdgeSyncClient.syncOnce(transport as any);
  check("Ciclo seguinte não repuxa nada", s3.pulled === 0 && getCursor() === 2);

  // ---- 5. Rede caída no push: fica na fila, próximo ciclo entrega ----
  const c3 = randomUUID();
  EdgeOutbox.enqueue({ commandId: c3, operationType: "SEND_MESSAGE", payload: { text: "offline" } });
  const failing = async () => { throw new Error("rede indisponível"); };
  const drainFail = await EdgeOutbox.drain(failing as any);
  check("Push com rede caída não entrega e mantém na fila", drainFail.sent === 0 && EdgeOutbox.pending() === 1);
  const row = edgeDb.prepare(`SELECT attempt_count, last_error, status FROM edge_outbox WHERE command_id = ?`).get(c3) as any;
  check("Tentativa contabilizada e erro registrado (ainda 'queued')", row.attempt_count === 1 && row.status === "queued" && !!row.last_error);
  // Simula o backoff vencido e reenvia com o transporte bom.
  edgeDb.prepare(`UPDATE edge_outbox SET next_attempt_at = CURRENT_TIMESTAMP WHERE command_id = ?`).run(c3);
  const drainOk = await EdgeOutbox.drain((commands) => transport.push(commands) as any);
  check("Conexão volta → o comando represado é entregue", drainOk.sent === 1 && EdgeOutbox.pending() === 0);

  // ---- 6. Heartbeat registra a versão do agente na nuvem ----
  check("Heartbeat gravou a versão do agente na nuvem", (cloudDb.prepare(`SELECT agent_version FROM edge_devices WHERE id = ?`).get(reg.id) as any).agent_version === "9.9.9");

  console.log("\n=== Continuity Layer — Fase 4b: runtime do Edge (ADR-082) ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
