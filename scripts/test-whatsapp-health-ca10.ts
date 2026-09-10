/**
 * TEST — F6.4 (RF-08 §18.6 / CA-08 + CA-10): saúde do envio pelo operador.
 * Fecha o Gate G6.
 *
 * Prova, offline (tmp db, sender injetado — sem rede), que:
 *  - a taxonomia de falha (F6.2) FLUI pra superfície de saúde: cada canal mostra
 *    QUAL ETAPA falhou (connection/queue/send_permanent/send_unknown/ok) +
 *    contadores por classe — o operador vê canal × etapa sem consultar token;
 *  - cada etapa traz uma AÇÃO DE RECUPERAÇÃO prática (CA-10);
 *  - bloqueio do gate de finalidade é PERMANENTE (F6.4 — retry não ajuda);
 *  - TOKEN-SAFE: o token do canal nunca aparece na saída;
 *  - métricas mínimas (§18.6) derivadas por query, honestas;
 *  - agrega sob volume representativo; isolamento por org.
 *
 * Uso: npm run test:whatsapp-health-ca10
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-wa-health-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-wa-health-1";
process.env.CONTINUITY_DELIVERY_MAX_ATTEMPTS = "2";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }
const STUCK = 3;
const TOKEN = "SUPER_SECRET_TOKEN_xyz";

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { MessageDeliveryService: MD, classifySendError } = await import("../src/server/MessageDeliveryService.js");
  const { WhatsAppHealthService: WH } = await import("../src/server/WhatsAppHealthService.js");

  // ── 1. gate de finalidade → permanent (F6.4) ──
  check("1.1 bloqueio do gate é permanente (retry não ajuda)", classifySendError({ code: "outbound_blocked:feature_disabled" }) === "permanent");

  const orgA = `org_${randomUUID().slice(0, 8)}`, orgB = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'A', 'active')`).run(randomUUID(), orgA);
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'B', 'active')`).run(randomUUID(), orgB);
  const mkCh = (org: string, name: string, status = "connected") => { const id = `ch_${name}_${randomUUID().slice(0, 4)}`; db.prepare(`INSERT INTO channels (id, organization_id, provider, name, identifier, status, token_encrypted) VALUES (?, ?, 'whatsapp_cloud', ?, ?, ?, ?)`).run(id, org, name, name, status, TOKEN); return id; };
  const chOk = mkCh(orgA, "ok"), chPerm = mkCh(orgA, "perm"), chUnk = mkCh(orgA, "unk"), chQueue = mkCh(orgA, "queue"), chDown = mkCh(orgA, "down", "disabled");

  // ── sender injetado: decide o erro pelo content ──
  (MD as any).__setSenderForTests(async (_ch: string, _to: string, content: string) => {
    if (content === "perm") throw new Error("invalid wa_id: recipient not found");
    if (content === "unk") throw new Error("socket hang up");
    return "wamid-ok";
  });

  // volume representativo no canal OK
  const N = 30;
  for (let i = 0; i < N; i++) MD.enqueue(orgA, { messageId: randomUUID(), channelId: chOk, recipient: `5511${i}`, content: "ok" });
  MD.enqueue(orgA, { messageId: randomUUID(), channelId: chPerm, recipient: "551100", content: "perm" });
  MD.enqueue(orgA, { messageId: randomUUID(), channelId: chUnk, recipient: "551101", content: "unk" });
  // canal com fila PRESA: linha queued vencida-no-futuro com attempt alto (não é reprocessada).
  const stuckRow = (org: string, ch: string) => db.prepare(`INSERT INTO message_deliveries (id, organization_id, message_id, channel_id, recipient, content, status, max_attempts, attempt_count, next_attempt_at, last_error) VALUES (?, ?, ?, ?, '5511', 'x', 'queued', 6, ?, datetime('now','+1 hour'), 'evolution 503')`).run(randomUUID(), org, randomUUID(), ch, STUCK);
  stuckRow(orgA, chQueue);
  // canal desconectado com 1 na fila.
  db.prepare(`INSERT INTO message_deliveries (id, organization_id, message_id, channel_id, recipient, content, status, max_attempts, attempt_count, next_attempt_at) VALUES (?, ?, ?, ?, '5511', 'x', 'queued', 6, 0, datetime('now','+1 hour'))`).run(randomUUID(), orgA, randomUUID(), chDown);

  await MD.dispatchDue(100);

  // ── 2. saúde por canal: etapa + dica ──
  const health = WH.channelHealth(orgA);
  const byCh = Object.fromEntries(health.map((h) => [h.channelId, h]));
  check("2.1 canal OK → stage 'ok'", byCh[chOk]?.stage === "ok");
  check("2.2 canal com número inválido → 'send_permanent'", byCh[chPerm]?.stage === "send_permanent" && byCh[chPerm].counts.failedPermanent === 1);
  check("2.3 canal com timeout → 'send_unknown'", byCh[chUnk]?.stage === "send_unknown" && byCh[chUnk].counts.unknown === 1);
  check("2.4 canal com fila presa → 'queue'", byCh[chQueue]?.stage === "queue" && byCh[chQueue].counts.stuck >= 1);
  check("2.5 canal desconectado → 'connection'", byCh[chDown]?.stage === "connection");
  check("2.6 cada canal traz ação de recuperação (CA-10)", health.every((h) => typeof h.recoveryHint === "string" && h.recoveryHint.length > 10));
  check("2.7 fila presa expõe idade da fila (>=0)", typeof byCh[chQueue]?.oldestQueuedAgeSec === "number");

  // ── 3. TOKEN-SAFE ──
  check("3.1 o token do canal NUNCA aparece na saúde", !JSON.stringify(health).includes(TOKEN));
  check("3.2 último erro é trecho do provedor, truncado", (byCh[chPerm]?.lastError || "").length <= 180);

  // ── 4. métricas mínimas (§18.6) ──
  const m = WH.metrics(orgA);
  check("4.1 falha por classe: permanent + unknown contados", m.failuresByClass.permanent === 1 && m.failuresByClass.unknown === 1);
  check("4.2 volume: 30 enviados no canal OK", byCh[chOk]?.counts.sent === N && m.sent === N);
  check("4.3 idade máx de fila derivada (>=0)", typeof m.queueAgeMaxSec === "number");

  // ── 5. isolamento ──
  check("5.1 org B (vazia) → sem canais", WH.channelHealth(orgB).length === 0 && WH.metrics(orgB).sent === 0);

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} whatsapp-health-ca10: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
