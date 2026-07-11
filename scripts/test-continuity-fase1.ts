/**
 * TESTE — Continuity Layer Fase 1: event log + delta sync + idempotência (ADR-082)
 * -------------------------------------------------------------------------------
 * Prova, offline e em banco temporário:
 *   - append gera seq MONOTÔNICO por organização (1,2,3…), isolado entre orgs;
 *   - delta sync (`since`) devolve só eventos após o cursor, ordenados, paginado;
 *   - flag desligada = não grava evento (rollout seguro);
 *   - idempotência: runIdempotent roda UMA vez e devolve o resultado guardado;
 *   - isolamento multi-tenant do event log e dos comandos.
 *
 * Uso:  npm run test:continuity-fase1
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-continuity-f1-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-continuity-f1-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { ContinuityService } = await import("../src/server/ContinuityService.js");

  const A = `org_A_${randomUUID().slice(0, 6)}`;
  const B = `org_B_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'A', 'active')`).run(randomUUID(), A);
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'B', 'active')`).run(randomUUID(), B);

  // ---- 1. Flag DESLIGADA: append é no-op ----
  delete process.env.CONTINUITY_EVENTS_ENABLED;
  check("Flag off → append não grava", ContinuityService.append(A, { aggregateType: 'message', eventType: 'x' }) === null);
  check("Flag off → cursor 0", ContinuityService.cursor(A) === 0);

  // ---- 2. Flag LIGADA: seq monotônico por org ----
  process.env.CONTINUITY_EVENTS_ENABLED = "true";
  const e1 = ContinuityService.append(A, { aggregateType: 'message', aggregateId: 'm1', eventType: 'message.sent', payload: { a: 1 } });
  const e2 = ContinuityService.append(A, { aggregateType: 'ticket', aggregateId: 't1', eventType: 'ticket.stage_changed' });
  const e3 = ContinuityService.append(A, { aggregateType: 'message', aggregateId: 'm2', eventType: 'message.sent' });
  check("Seq começa em 1 e incrementa", e1?.seq === 1 && e2?.seq === 2 && e3?.seq === 3);
  check("Cursor reflete o último seq", ContinuityService.cursor(A) === 3);

  // Org B tem sequência PRÓPRIA (independente de A).
  const b1 = ContinuityService.append(B, { aggregateType: 'message', aggregateId: 'mb', eventType: 'message.sent' });
  check("Seq da org B começa em 1 (isolado de A)", b1?.seq === 1);

  // ---- 3. Delta sync ----
  const delta = ContinuityService.since(A, 1); // após o seq 1 → deve trazer 2 e 3
  check("Delta após seq 1 traz 2 eventos", delta.events.length === 2 && delta.events[0].seq === 2 && delta.events[1].seq === 3);
  check("Delta em ordem crescente de seq", delta.events[0].seq < delta.events[1].seq);
  check("Delta devolve cursor final", delta.cursor === 3);
  check("Payload preservado no delta", ContinuityService.since(A, 0).events[0].payload?.a === 1);
  check("Delta a partir do cursor atual vem vazio", ContinuityService.since(A, 3).events.length === 0);

  // Paginação: hasMore quando há mais que o limite.
  for (let i = 0; i < 5; i++) ContinuityService.append(A, { aggregateType: 'message', eventType: 'noise' });
  const page = ContinuityService.since(A, 0, 3);
  check("Paginação respeita o limite e sinaliza hasMore", page.events.length === 3 && page.hasMore === true);

  // ---- 4. Isolamento do delta ----
  check("Delta de B não vê eventos de A", ContinuityService.since(B, 0).events.every(e => e.aggregateId !== 'm1' && e.aggregateId !== 't1'));

  // ---- 5. Idempotência genérica ----
  let runs = 0;
  const cmd = randomUUID();
  const r1 = await ContinuityService.runIdempotent(A, cmd, { userId: 'u1', operationType: 'SEND_MESSAGE' }, async () => { runs++; return { id: 'msg-1' }; });
  const r2 = await ContinuityService.runIdempotent(A, cmd, { userId: 'u1', operationType: 'SEND_MESSAGE' }, async () => { runs++; return { id: 'msg-2' }; });
  check("runIdempotent executa a fn só uma vez", runs === 1);
  check("Segunda chamada é deduplicada e devolve o resultado guardado", r2.deduped === true && r2.result.id === 'msg-1');
  check("Primeira chamada não é deduplicada", r1.deduped === false);
  check("Mesmo commandId em outra org NÃO colide", (await ContinuityService.runIdempotent(B, cmd, { operationType: 'SEND_MESSAGE' }, async () => ({ id: 'b' }))).deduped === false);

  console.log("\n=== Continuity Layer — Fase 1: event log + delta sync + idempotência (ADR-082) ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
