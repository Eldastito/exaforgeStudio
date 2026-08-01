/**
 * Continuity Layer — cola do outbox com o app (ADR-082, Fase 1b).
 *
 * Mantém o singleton do outbox (IndexedDB no browser), o "sender" que reenvia
 * comandos de mensagem ao servidor (com commandId → idempotência da Fase 1) e o
 * flusher disparado ao voltar a conexão. `onChange` reflete o estado do comando
 * de volta na UI (o balão vira "enviada" ou "não enviada").
 */
import { apiFetch } from "@/src/lib/api";
import { Outbox, IdbOutboxStore, type CommandSender, type OutboxCommand } from "./outbox";

let _outbox: Outbox | null = null;
export function getOutbox(): Outbox {
  if (!_outbox) _outbox = new Outbox(new IdbOutboxStore());
  return _outbox;
}
/** Injeção para testes. */
export function setOutbox(o: Outbox) { _outbox = o; }

/** Enfileira uma mensagem que não pôde ser enviada agora (offline). */
export async function enqueueMessage(commandId: string, payload: { contactId: string; text: string }): Promise<void> {
  try { await getOutbox().enqueue({ commandId, type: "SEND_MESSAGE", payload }); } catch (e) { console.error("[Outbox] enqueue falhou", e); }
}

/**
 * Registry de senders por `cmd.type`. Cada feature registra seu handler
 * (ex.: SEND_MESSAGE — chat; COMIGO_OPEN_ORDER / COMIGO_ADD_ITEM / COMIGO_PAY —
 * Balcão offline). Se o tipo não tem sender registrado, o comando é marcado
 * como `failed` (não fica pendurado eternamente).
 */
const senders: Record<string, CommandSender> = {};
export function registerCommandSender(type: string, sender: CommandSender) { senders[type] = sender; }

// Sender de SEND_MESSAGE — o handler original. Registrado eagerly aqui pra
// não quebrar quem já dependia do sync sem se registrar.
registerCommandSender("SEND_MESSAGE", async (cmd: OutboxCommand) => {
  try {
    const res = await apiFetch("/api/messages/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...cmd.payload, commandId: cmd.commandId }),
    });
    return res.ok ? "sent" : "failed";
  } catch {
    return "retry";
  }
});

/** Sender roteador — despacha por cmd.type ao handler correto. */
function makeRoutingSender(): CommandSender {
  return async (cmd: OutboxCommand) => {
    const handler = senders[cmd.type];
    if (!handler) { console.warn("[Outbox] sem sender para type", cmd.type); return "failed"; }
    return handler(cmd);
  };
}

/**
 * Esvazia o outbox. `onChange(commandId, status)` atualiza a UI para cada
 * comando resolvido (o id do comando é o id local da mensagem no store).
 */
export async function flushOutbox(onChange?: (commandId: string, status: "sent" | "failed") => void): Promise<void> {
  const ob = getOutbox();
  const before = await ob.all();
  await ob.flush(makeRoutingSender());
  if (onChange) {
    const after = new Map((await ob.all()).map(c => [c.commandId, c] as const));
    for (const c of before) {
      const now = after.get(c.commandId);
      if (!now) onChange(c.commandId, "sent");            // saiu da fila = entregue
      else if (now.status === "failed") onChange(c.commandId, "failed");
    }
  }
}

/**
 * Inicia o flusher: tenta esvaziar ao montar, ao voltar 'online' e num intervalo
 * de segurança. Retorna a função de limpeza.
 */
export function startOutboxFlusher(onChange?: (commandId: string, status: "sent" | "failed") => void): () => void {
  const run = () => { flushOutbox(onChange).catch(() => {}); };
  run();
  const onOnline = () => run();
  window.addEventListener("online", onOnline);
  const timer = window.setInterval(run, 30000);
  return () => { window.removeEventListener("online", onOnline); window.clearInterval(timer); };
}
