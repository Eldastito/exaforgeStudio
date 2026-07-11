/**
 * TESTE — Materialização de agregados no Edge (eventos "gordos") (ADR-082)
 * ----------------------------------------------------------------------
 * Prova, offline e com dois SQLite separados, que o nó materializa o TICKET
 * numa tabela dedicada (edge_tickets) a partir dos domain_events "gordos"
 * (que carregam o novo estado), dando um board consultável offline:
 *
 *   - ticket.stage_changed / ticket.ai_toggled puxados são aplicados por seq;
 *   - edge_tickets reflete o ESTADO ATUAL (último estágio + IA pausada);
 *   - campos parciais acumulam (ai_toggled não zera o stage e vice-versa);
 *   - reaplicar é no-op (idempotente); a projeção genérica coexiste.
 *
 * Uso:  npm run test:edge-materialize
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const cloudDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-mat-cloud-"));
const edgeDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-mat-node-"));
process.env.DATA_DIR = cloudDir;
process.env.EDGE_DATA_DIR = edgeDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-edge-mat-1234567890";
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
  const { default: cloudDb } = await import("../src/server/db.js");
  const { ContinuityService } = await import("../src/server/ContinuityService.js");
  const { EdgeSyncService } = await import("../src/server/EdgeSyncService.js");
  const { initEdgeDb } = await import("../apps/edge/db.js");
  const { EdgeSyncClient } = await import("../apps/edge/EdgeSyncClient.js");
  const { registerBuiltinAppliers, getEdgeTicket, EdgeInboxApplicator } = await import("../apps/edge/EdgeInboxApplicator.js");

  initEdgeDb();
  registerBuiltinAppliers();

  const org = `org_${randomUUID().slice(0, 6)}`;
  cloudDb.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'S', 'active')`).run(randomUUID(), org);
  const reg = await EdgeSyncService.register(org, "Nó");
  const device = (await EdgeSyncService.authenticate(reg.id, reg.key))!;
  const transport = {
    pull: async (after: number, limit: number) => EdgeSyncService.pull(device, after, limit),
    push: async (c: any[]) => EdgeSyncService.push(device, c),
    heartbeat: async (v?: string) => EdgeSyncService.heartbeat(device, v),
  };

  // Eventos GORDOS de ticket na nuvem (o novo estado no payload).
  const tk = "tk_" + randomUUID().slice(0, 6);
  ContinuityService.append(org, { aggregateType: "ticket", aggregateId: tk, eventType: "ticket.stage_changed", payload: { stage: "novo", contactId: "5511999" } });
  ContinuityService.append(org, { aggregateType: "ticket", aggregateId: tk, eventType: "ticket.ai_toggled", payload: { aiPaused: true } });
  ContinuityService.append(org, { aggregateType: "ticket", aggregateId: tk, eventType: "ticket.stage_changed", payload: { stage: "ganho" } });

  // Nó sincroniza (pull + apply).
  const s = await EdgeSyncClient.syncOnce(transport as any);
  check("Nó aplicou os 3 eventos", s.applied === 3);

  const t = getEdgeTicket(tk);
  check("edge_tickets reflete o ÚLTIMO estágio (LWW por seq)", t?.stage === "ganho");
  check("edge_tickets acumula a IA pausada (evento parcial)", t?.ai_paused === 1);
  check("edge_tickets manteve o contactId do 1º evento", t?.contact_id === "5511999");
  check("edge_tickets registra o último seq", t?.last_seq === 3);
  check("Projeção genérica (edge_aggregates) coexiste", EdgeInboxApplicator.get("ticket", tk)?.state?.stage === "ganho");

  // Idempotência: novo ciclo não muda nada.
  const before = getEdgeTicket(tk).updated_at;
  const s2 = await EdgeSyncClient.syncOnce(transport as any);
  check("Ciclo seguinte não reaplica (idempotente)", s2.applied === 0 && getEdgeTicket(tk).last_seq === 3);

  // Isolamento entre tickets.
  const tk2 = "tk_" + randomUUID().slice(0, 6);
  ContinuityService.append(org, { aggregateType: "ticket", aggregateId: tk2, eventType: "ticket.stage_changed", payload: { stage: "perdido" } });
  await EdgeSyncClient.syncOnce(transport as any);
  check("Segundo ticket materializa independente", getEdgeTicket(tk2)?.stage === "perdido" && getEdgeTicket(tk)?.stage === "ganho");

  console.log("\n=== Materialização de agregados no Edge (eventos gordos) (ADR-082) ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
