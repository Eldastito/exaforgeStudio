/**
 * TESTE — Continuity Layer Fase 1b: outbox do navegador (ADR-082)
 * ---------------------------------------------------------------
 * Testa a lógica DURA da fila offline (armazenamento em memória + sender falso,
 * sem IndexedDB), que é a mesma usada no browser:
 *   - enqueue persiste 'pending'; reenfileirar o mesmo commandId não duplica;
 *   - flush envia e REMOVE da fila quando 'sent';
 *   - 'retry' (rede caiu) mantém na fila; próximo flush entrega;
 *   - 'failed' (servidor rejeitou) sai de pending e fica marcado como falha;
 *   - teto de tentativas vira 'failed';
 *   - ordem de envio é por criação (FIFO).
 *
 * Uso:  npm run test:continuity-outbox
 */
import { Outbox, MemoryOutboxStore, type CommandSender } from "../src/lib/continuity/outbox.js";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

// Relógio determinístico (createdAt crescente e estável).
let clock = 0;
const now = () => new Date(1_700_000_000_000 + (clock++) * 1000).toISOString();

async function main() {
  // ---- 1. enqueue + idempotência ----
  {
    const ob = new Outbox(new MemoryOutboxStore(), now);
    await ob.enqueue({ commandId: "c1", type: "SEND_MESSAGE", payload: { text: "oi" } });
    await ob.enqueue({ commandId: "c1", type: "SEND_MESSAGE", payload: { text: "oi de novo" } });
    const all = await ob.all();
    check("Reenfileirar o mesmo commandId não duplica", all.length === 1);
    check("Comando nasce 'pending'", all[0].status === "pending");
    check("Payload do primeiro enqueue é mantido", all[0].payload.text === "oi");
  }

  // ---- 2. flush com sucesso remove da fila ----
  {
    const ob = new Outbox(new MemoryOutboxStore(), now);
    await ob.enqueue({ commandId: "s1", type: "SEND_MESSAGE", payload: {} });
    const sender: CommandSender = async () => "sent";
    const sum = await ob.flush(sender);
    check("flush envia o comando (sent=1)", sum.sent === 1);
    check("Comando entregue sai da fila", (await ob.all()).length === 0);
  }

  // ---- 3. retry mantém na fila; próximo flush entrega ----
  {
    const ob = new Outbox(new MemoryOutboxStore(), now);
    await ob.enqueue({ commandId: "r1", type: "SEND_MESSAGE", payload: {} });
    let online = false;
    const sender: CommandSender = async () => (online ? "sent" : "retry");
    const s1 = await ob.flush(sender);
    check("Offline → retry (não envia)", s1.retry === 1 && s1.sent === 0);
    check("Comando continua pendente após retry", (await ob.pending()).length === 1);
    const c = (await ob.all())[0];
    check("Tentativa foi contabilizada", c.attempts === 1 && c.status === "pending");
    online = true;
    const s2 = await ob.flush(sender);
    check("Conexão volta → entrega no flush seguinte", s2.sent === 1 && (await ob.all()).length === 0);
  }

  // ---- 4. failed (servidor rejeitou) sai de pending e fica marcado ----
  {
    const ob = new Outbox(new MemoryOutboxStore(), now);
    await ob.enqueue({ commandId: "f1", type: "SEND_MESSAGE", payload: {} });
    const sender: CommandSender = async () => "failed";
    const sum = await ob.flush(sender);
    check("Rejeição do servidor → failed", sum.failed === 1);
    const c = await (new Outbox(ob["store"] as any, now)).all();
    check("Comando falho permanece marcado 'failed' (não some)", c.length === 1 && c[0].status === "failed");
    check("Comando falho não é mais reprocessado (fora de pending)", (await ob.pending()).length === 0);
  }

  // ---- 5. teto de tentativas vira failed ----
  {
    const ob = new Outbox(new MemoryOutboxStore(), now);
    await ob.enqueue({ commandId: "m1", type: "SEND_MESSAGE", payload: {} });
    const sender: CommandSender = async () => "retry";
    for (let i = 0; i < 8; i++) await ob.flush(sender);
    const c = (await ob.all())[0];
    check("Após o teto de tentativas → failed", c.status === "failed" && c.attempts >= 8);
  }

  // ---- 6. FIFO por criação ----
  {
    const ob = new Outbox(new MemoryOutboxStore(), now);
    await ob.enqueue({ commandId: "a", type: "SEND_MESSAGE", payload: {} });
    await ob.enqueue({ commandId: "b", type: "SEND_MESSAGE", payload: {} });
    const order: string[] = [];
    const sender: CommandSender = async (cmd) => { order.push(cmd.commandId); return "sent"; };
    await ob.flush(sender);
    check("Envio em ordem de criação (FIFO)", order.join(",") === "a,b");
  }

  console.log("\n=== Continuity Layer — Fase 1b: outbox do navegador (ADR-082) ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
