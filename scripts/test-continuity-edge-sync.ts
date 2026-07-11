/**
 * TESTE — Continuity Layer Fase 4a: protocolo de sync Edge↔Cloud (ADR-082)
 * ------------------------------------------------------------------------
 * Prova, offline e em banco temporário:
 *   - registro de nó Edge: id `edg_*` + segredo devolvido 1x; só o HASH persiste;
 *   - auth de máquina: segredo certo autentica; errado/nó inexistente/revogado não;
 *   - PULL: entrega o delta de domain_events após o cursor e avança o cursor do nó;
 *   - PUSH: grava comandos idempotentes (accepted); reenviar deduplica; sem id rejeita;
 *   - isolamento multi-tenant: nó de A não vê eventos de B; revogação é por org;
 *   - heartbeat atualiza versão e devolve o cursor do servidor;
 *   - flag desligada = protocolo indisponível (enabled() reflete o env).
 *
 * Uso:  npm run test:continuity-edge-sync
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-continuity-edge-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-continuity-edge-1234567890";
process.env.CONTINUITY_EVENTS_ENABLED = "true";
process.env.CONTINUITY_EDGE_SYNC_ENABLED = "true";
process.env.EDGE_BCRYPT_ROUNDS = "4"; // hashes baratos p/ o teste não arrastar

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { ContinuityService } = await import("../src/server/ContinuityService.js");
  const { EdgeSyncService } = await import("../src/server/EdgeSyncService.js");

  const A = `org_A_${randomUUID().slice(0, 6)}`;
  const B = `org_B_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'A', 'active')`).run(randomUUID(), A);
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'B', 'active')`).run(randomUUID(), B);

  // ---- 1. Registro do nó ----
  const reg = await EdgeSyncService.register(A, "Recepção");
  check("Registro devolve id edg_*", typeof reg.id === "string" && reg.id.startsWith("edg_"));
  check("Registro devolve o segredo em texto puro (1x)", typeof reg.key === "string" && reg.key.length >= 32);
  const stored = db.prepare(`SELECT api_key_hash, organization_id, status FROM edge_devices WHERE id = ?`).get(reg.id) as any;
  check("Só o HASH é persistido (nunca o segredo puro)", !!stored?.api_key_hash && stored.api_key_hash !== reg.key);
  check("Nó nasce 'active' e vinculado à org", stored.status === "active" && stored.organization_id === A);

  // ---- 2. Autenticação de máquina ----
  const authOk = await EdgeSyncService.authenticate(reg.id, reg.key);
  check("Segredo correto autentica", !!authOk && authOk.organization_id === A);
  check("Segredo errado NÃO autentica", (await EdgeSyncService.authenticate(reg.id, "errado")) === null);
  check("Nó inexistente NÃO autentica", (await EdgeSyncService.authenticate("edg_naoexiste", reg.key)) === null);

  // ---- 3. PULL (delta) ----
  const s1 = ContinuityService.append(A, { aggregateType: "message", aggregateId: "m1", eventType: "message.sent", payload: { t: 1 } });
  ContinuityService.append(A, { aggregateType: "ticket", aggregateId: "t1", eventType: "ticket.stage_changed" });
  const device = (await EdgeSyncService.authenticate(reg.id, reg.key))!;
  const pull0 = EdgeSyncService.pull(device, 0, 200);
  check("PULL a partir de 0 traz o delta da org", pull0.events.length === 2 && pull0.events[0].seq === s1!.seq);
  check("PULL com after=0 mantém o cursor em 0 (nada confirmado ainda)", (db.prepare(`SELECT cursor FROM edge_devices WHERE id = ?`).get(reg.id) as any).cursor === 0);
  const pullTop = EdgeSyncService.pull({ ...device, cursor: 0 }, pull0.cursor, 200);
  check("PULL a partir do cursor atual vem vazio", pullTop.events.length === 0);
  check("PULL persiste o cursor confirmado pelo nó", (db.prepare(`SELECT cursor FROM edge_devices WHERE id = ?`).get(reg.id) as any).cursor === pull0.cursor);

  // ---- 4. PUSH (idempotente) ----
  const c1 = randomUUID(), c2 = randomUUID();
  const push1 = EdgeSyncService.push(device, [
    { commandId: c1, operationType: "SEND_MESSAGE", payload: { text: "oi" } },
    { commandId: c2, operationType: "SEND_MESSAGE", payload: { text: "tchau" } },
    { commandId: "", payload: {} }, // sem id → rejeitado
  ]);
  check("PUSH aceita comandos novos", push1.accepted === 2);
  check("PUSH rejeita comando sem commandId", push1.rejected === 1);
  const rec = db.prepare(`SELECT device_id, operation_type, status FROM client_commands WHERE organization_id = ? AND command_id = ?`).get(A, c1) as any;
  check("Comando gravado carrega o device_id e status 'received'", rec?.device_id === reg.id && rec.status === "received");
  const push2 = EdgeSyncService.push(device, [{ commandId: c1, payload: { text: "oi de novo" } }]);
  check("Reenviar o mesmo commandId deduplica (não duplica)", push2.deduped === 1 && push2.accepted === 0);

  // ---- 5. Isolamento multi-tenant ----
  const regB = await EdgeSyncService.register(B, "Loja B");
  const deviceB = (await EdgeSyncService.authenticate(regB.id, regB.key))!;
  const pullB = EdgeSyncService.pull(deviceB, 0, 200);
  check("Nó de B NÃO vê eventos de A", pullB.events.every((e: any) => e.aggregateId !== "m1" && e.aggregateId !== "t1"));
  check("Revogação é escopada por org (B não revoga nó de A)", EdgeSyncService.revoke(B, reg.id) === false);

  // ---- 6. Revogação corta o acesso ----
  check("Dono revoga o próprio nó", EdgeSyncService.revoke(A, reg.id) === true);
  check("Nó revogado NÃO autentica mais", (await EdgeSyncService.authenticate(reg.id, reg.key)) === null);

  // ---- 7. Heartbeat ----
  const hb = EdgeSyncService.heartbeat(deviceB, "1.2.3");
  check("Heartbeat devolve o cursor do servidor", typeof hb.serverCursor === "number");
  check("Heartbeat grava a versão do agente", (db.prepare(`SELECT agent_version FROM edge_devices WHERE id = ?`).get(regB.id) as any).agent_version === "1.2.3");

  // ---- 8. Flag de rollout ----
  check("enabled() true com a flag ligada", EdgeSyncService.enabled() === true);
  process.env.CONTINUITY_EDGE_SYNC_ENABLED = "off";
  check("enabled() false com a flag desligada", EdgeSyncService.enabled() === false);
  process.env.CONTINUITY_EDGE_SYNC_ENABLED = "true";

  console.log("\n=== Continuity Layer — Fase 4a: protocolo de sync Edge↔Cloud (ADR-082) ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
