/**
 * TEST — F6.2 (RF-08/CA-08): taxonomia de falha de envio + anti-repetição.
 *
 * Prova, offline (tmp db, sender injetado — sem rede), que a entrega DISTINGUE
 * os três resultados e age diferente em cada um (o coração do CA-08):
 *  - permanent (número inválido/opt-out/4xx) → falha JÁ, não gasta as tentativas;
 *  - unknown (timeout/sem resposta) → sai da fila e NÃO é reenviado
 *    automaticamente (repetir duplicaria o efeito) — reconcilia depois;
 *  - transient (5xx/reset) → retenta com backoff até o teto, então falha;
 *  - sucesso normal segue 'sent' (0-regressão).
 * `classifySendError` é puro/determinístico.
 *
 * Uso: npm run test:delivery-failure-taxonomy
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-deliv-tax-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-deliv-tax-1";
process.env.CONTINUITY_DELIVERY_MAX_ATTEMPTS = "2"; // teto baixo p/ chegar rápido ao 'failed' transitório

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { MessageDeliveryService: MD, classifySendError } = await import("../src/server/MessageDeliveryService.js");

  // ── 1. classifySendError (puro) ──
  check("1.1 número inválido → permanent", classifySendError(new Error("invalid wa_id: recipient not found")) === "permanent");
  check("1.2 403 → permanent", classifySendError(Object.assign(new Error("Forbidden"), { status: 403 })) === "permanent");
  check("1.3 opt-out → permanent", classifySendError(new Error("user opted-out / bloqueado")) === "permanent");
  check("1.4 timeout → unknown", classifySendError(new Error("socket hang up")) === "unknown");
  check("1.5 ETIMEDOUT → unknown", classifySendError(new Error("request ETIMEDOUT")) === "unknown");
  check("1.6 503 → transient", classifySendError(new Error("503 Service Unavailable")) === "transient");
  check("1.7 reset de conexão → transient (default conservador)", classifySendError(new Error("ECONNRESET")) === "transient");

  // ── sender injetado: decide o erro pelo `content`, conta chamadas ──
  const calls: Record<string, number> = {};
  (MD as any).__setSenderForTests(async (_ch: string, _to: string, content: string) => {
    calls[content] = (calls[content] || 0) + 1;
    if (content === "perm") throw new Error("invalid wa_id: recipient not found");
    if (content === "unk") throw new Error("socket hang up");
    if (content === "trans") throw new Error("503 Service Unavailable");
    return "wamid-ok";
  });

  const orgId = `org_${randomUUID().slice(0, 8)}`;
  const enq = (content: string) => MD.enqueue(orgId, { messageId: randomUUID(), channelId: "ch1", recipient: `55119${content}`, content });
  const row = (id: string) => db.prepare(`SELECT status, failure_class, attempt_count FROM message_deliveries WHERE id = ?`).get(id) as any;

  const idPerm = enq("perm"), idUnk = enq("unk"), idTrans = enq("trans"), idOk = enq("ok");
  const sum = await MD.dispatchDue();

  // ── 2. permanent: falha já, sem gastar tentativas ──
  check("2.1 permanent → status failed", row(idPerm).status === "failed");
  check("2.2 permanent → failure_class permanent", row(idPerm).failure_class === "permanent");
  check("2.3 permanent → 1 tentativa só (não gasta o teto)", row(idPerm).attempt_count === 1 && calls.perm === 1);

  // ── 3. unknown: sai da fila e NÃO reenvia automaticamente ──
  check("3.1 unknown → status unknown", row(idUnk).status === "unknown" && row(idUnk).failure_class === "unknown");
  await MD.dispatchDue(); // 2º passe não pode reprocessar o unknown
  check("3.2 unknown NÃO é reenviado (anti-duplicação CA-08)", calls.unk === 1);

  // ── 4. sucesso normal (0-regressão) ──
  check("4.1 sucesso → sent", row(idOk).status === "sent");

  // ── 5. transient: retenta e só falha ao esgotar o teto ──
  check("5.1 transient → segue na fila após 1ª falha", row(idTrans).status === "queued" && row(idTrans).failure_class === "transient" && row(idTrans).attempt_count === 1);
  db.prepare(`UPDATE message_deliveries SET next_attempt_at = CURRENT_TIMESTAMP WHERE id = ?`).run(idTrans); // vence o backoff (determinístico)
  await MD.dispatchDue();
  check("5.2 transient → failed ao atingir o teto (2 tentativas)", row(idTrans).status === "failed" && row(idTrans).failure_class === "transient" && row(idTrans).attempt_count === 2);

  // ── 6. resumo distingue unknown ──
  check("6.1 dispatchDue reporta unknown separado", typeof sum.unknown === "number" && sum.unknown === 1 && sum.failed === 1 && sum.sent === 1 && sum.retried === 1);

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} delivery-failure-taxonomy: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
