/**
 * TESTE — Detecção proativa de canal quebrado (ADR-082, reação ao stuckQueued)
 * ---------------------------------------------------------------------------
 * Prova, offline, que o sistema REAGE ao sinal de entregas presas: identifica um
 * canal degradado (várias entregas 'queued' após já terem tentado) e alerta o
 * operador na hora, deduplicado — sem esperar as tentativas esgotarem.
 *
 *   - degradedChannels() lista canais com DEGRADED_MIN+ presos (attempts >= STUCK);
 *   - canal abaixo do mínimo, ou com poucas tentativas, NÃO é degradado;
 *   - filtro por organização isola os canais;
 *   - checkChannelHealth() cria 1 alerta por canal e NÃO repete (dedupe).
 *
 * Uso:  npm run test:channel-health
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-chanhealth-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-chan-health-1234567890";
// Defaults: STUCK_ATTEMPTS=3, DEGRADED_MIN=3.

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { MessageDeliveryService } = await import("../src/server/MessageDeliveryService.js");

  const A = `org_${randomUUID().slice(0, 6)}`, B = `org_${randomUUID().slice(0, 6)}`;
  for (const o of [A, B]) db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), o);

  const mkDeliv = (org: string, channelId: string, status: string, attempts: number) =>
    db.prepare(`INSERT INTO message_deliveries (id, organization_id, message_id, channel_id, recipient, content, status, attempt_count) VALUES (?, ?, ?, ?, 'r', 'x', ?, ?)`)
      .run(randomUUID(), org, randomUUID(), channelId, status, attempts);

  const chX = "chX", chY = "chY", chZ = "chZ", chB = "chB";
  for (let i = 0; i < 3; i++) mkDeliv(A, chX, "queued", 4);   // degradado (3 presos, 4 tentativas)
  for (let i = 0; i < 2; i++) mkDeliv(A, chY, "queued", 4);   // abaixo do mínimo (só 2)
  for (let i = 0; i < 3; i++) mkDeliv(A, chZ, "queued", 1);   // tentativas insuficientes (1 < 3)
  for (let i = 0; i < 3; i++) mkDeliv(B, chB, "queued", 5);   // degradado, org B
  mkDeliv(A, chX, "sent", 4);                                  // 'sent' não conta

  // ---- 1. degradedChannels (global) ----
  const glob = MessageDeliveryService.degradedChannels();
  const ids = glob.map((c) => c.channelId).sort();
  check("Detecta chX (A) e chB (B) como degradados", ids.join(",") === "chB,chX", ids.join(","));
  check("Não inclui chY (abaixo do mínimo) nem chZ (tentativas baixas)", !ids.includes("chY") && !ids.includes("chZ"));
  const x = glob.find((c) => c.channelId === chX)!;
  check("Traz stuckCount e maxAttempts do canal", x.stuckCount === 3 && x.maxAttempts === 4);

  // ---- 2. Filtro por organização ----
  const onlyA = MessageDeliveryService.degradedChannels(A).map((c) => c.channelId);
  check("Filtro por org isola (A não vê chB)", onlyA.length === 1 && onlyA[0] === chX);

  // ---- 3. checkChannelHealth alerta (deduplicado) ----
  const n1 = MessageDeliveryService.checkChannelHealth();
  check("checkChannelHealth acha 2 canais degradados", n1 === 2);
  const alertsA = () => (db.prepare(`SELECT COUNT(*) AS c FROM notifications WHERE organization_id = ? AND type = 'alert' AND title = 'Um canal parece indisponível'`).get(A) as any).c;
  check("Gera 1 alerta para a org A", alertsA() === 1);
  check("Gera alerta para a org B", (db.prepare(`SELECT COUNT(*) AS c FROM notifications WHERE organization_id = ? AND type = 'alert'`).get(B) as any).c === 1);

  MessageDeliveryService.checkChannelHealth(); // sem mudança nos dados
  check("Segunda checagem NÃO duplica o alerta (dedupe)", alertsA() === 1);

  console.log("\n=== Detecção proativa de canal quebrado (ADR-082) ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
