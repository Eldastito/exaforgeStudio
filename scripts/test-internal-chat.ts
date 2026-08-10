/**
 * TEST — PRD 1 Fase 7 (§80): chat interno FUNDAÇÃO-SÓ. Notas de equipe ancoradas
 * a um caso (correlation_id). Não é Slack.
 *
 * Prova (determinístico):
 *   - post (direcionada / nota-do-caso) + validação (vazia/sem user/longa);
 *   - inbox: só as endereçadas a mim + contagem de não-lidas; markRead só o
 *     destinatário (idempotente);
 *   - forThread: visibilidade (autor/destinatário/broadcast) — nota direcionada
 *     NÃO vaza pra terceiro; a thread da Fase 6 costura o estágio 'nota';
 *   - isolamento multi-tenant.
 *
 * Uso: npm run test:internal-chat
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-internal-chat-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-internal-chat-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }
function throws(fn: () => any): boolean { try { fn(); return false; } catch { return true; } }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { InternalChatService: IC } = await import("../src/server/InternalChatService.js");
  const { FalaTuThreadService: FT } = await import("../src/server/FalaTuThreadService.js");

  const mkOrg = () => { const id = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), id); return id; };
  const org = mkOrg();
  const alice = randomUUID(), bob = randomUUID(), carol = randomUUID();
  const CID = "corr-CASE-7";

  // ===== 1. Post + validação =====
  const m1 = IC.post(org, alice, { toUserId: bob, correlationId: CID, body: "Bob, dá uma olhada nessa aprovação?" });
  const mCase = IC.post(org, alice, { correlationId: CID, body: "Nota do caso: cliente pediu urgência." }); // broadcast
  IC.post(org, bob, { toUserId: carol, correlationId: CID, body: "Carol, você fechou isso?" });
  check("1.1 post direcionada guarda from/to/correlation", m1.from_user_id === alice && m1.to_user_id === bob && m1.correlation_id === CID);
  check("1.2 nota-do-caso tem to_user_id NULL", mCase.to_user_id == null);
  check("1.3 valida: vazia / sem user / longa", throws(() => IC.post(org, alice, { body: "  " })) && throws(() => IC.post(org, "", { body: "x" })) && throws(() => IC.post(org, alice, { body: "x".repeat(4001) })));

  // ===== 2. Inbox + markRead =====
  const inbBob = IC.inbox(org, bob);
  check("2.1 inbox do bob: só a endereçada a ele (1) + 1 não-lida", inbBob.total === 1 && inbBob.items[0].id === m1.id && inbBob.unread === 1);
  check("2.2 carol NÃO marca a nota do bob como lida (não é destinatária)", IC.markRead(org, carol, m1.id).read === false);
  check("2.3 bob marca como lida (idempotente)", IC.markRead(org, bob, m1.id).read === true && IC.markRead(org, bob, m1.id).read === false);
  check("2.4 inbox unreadOnly do bob agora vazio", IC.inbox(org, bob, { unreadOnly: true }).total === 0);

  // ===== 3. forThread: visibilidade =====
  const bobThread = IC.forThread(org, bob, CID).map((n: any) => n.id);
  check("3.1 bob vê: a dele (autor), a p/ ele, e a do caso (3)", bobThread.length === 3);
  const carolThread = IC.forThread(org, carol, CID);
  check("3.2 carol vê a do caso + a p/ ela, NÃO a de alice→bob", carolThread.length === 2 && !carolThread.some((n: any) => n.id === m1.id));

  // ===== 4. Thread da Fase 6 costura o estágio 'nota' =====
  const th = FT.thread(org, carol, CID);
  check("4.1 thread inclui estágio 'nota' pra quem pode ver", th.events.some((e: any) => e.stage === "nota"));
  check("4.2 thread da carol NÃO traz a nota direcionada a bob", !th.events.some((e: any) => e.title === "Bob, dá uma olhada nessa aprovação?"));

  // ===== 5. Isolamento multi-tenant =====
  const orgB = mkOrg();
  check("5.1 nota de A não aparece na inbox/thread de B", IC.inbox(orgB, bob).total === 0 && IC.forThread(orgB, bob, CID).length === 0 && IC.get(orgB, m1.id) == null);

  console.log("\n=== TEST: Chat interno fundação (PRD 1 Fase 7) ===\n");
  for (const rr of results) console.log(`${rr.ok ? "✅" : "❌"} ${rr.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Chat interno fundação (Fase 7) OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
