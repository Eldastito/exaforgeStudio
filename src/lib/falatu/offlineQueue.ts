/**
 * FalaTu F8.2 (ADR-154 Fase 8) — fila offline de captura.
 *
 * Mesmo molde do Balcão (src/lib/comigo/offlineQueue.ts): outbox IDB do
 * Continuity Layer (ADR-082 F1b) + sender registrado por tipo. Captura que
 * falhou por REDE vira comando FALATU_CAPTURE; o flusher reenvia com
 * `commandId` e o backend deduplica por (org, user, client_command_id) —
 * reenvio nunca duplica item nem paga extração de IA duas vezes.
 *
 * 4xx/5xx NÃO volta pra fila (erro de validação/limite não se resolve
 * reenviando); só exceção de rede vira retry. Ao entregar, dispara o evento
 * `falatu:outbox-sent` — a FalaTuView escuta pra atualizar inbox/contador
 * sem acoplar em quem roda o flusher (App da suíte ou FalatuApp standalone).
 */
import { apiFetch } from "@/src/lib/api";
import { getOutbox, registerCommandSender } from "@/src/lib/continuity/sync";
import type { OutboxCommand } from "@/src/lib/continuity/outbox";

export const FALATU_CMD_TYPE = "FALATU_CAPTURE";

/** True se a falha foi de rede (aí a fila offline resolve; 4xx/5xx não). */
export function isNetworkError(e: unknown): boolean {
  if (typeof navigator !== "undefined" && !navigator.onLine) return true;
  if (e instanceof TypeError) return true;
  return /fail(ed)? to fetch|network/i.test(e instanceof Error ? e.message : String(e || ""));
}

export async function enqueueCapture(
  commandId: string,
  payload: { text?: string; audio?: { mimeType: string; data: string }; image?: { mimeType: string; data: string }; source?: string },
): Promise<void> {
  await getOutbox().enqueue({ commandId, type: FALATU_CMD_TYPE, payload });
}

/** Capturas aguardando conexão (pro aviso "N aguardando" da FalaTuView). */
export async function pendingFalatuCount(): Promise<number> {
  const all = await getOutbox().all();
  return all.filter((c) => c.type === FALATU_CMD_TYPE && (c.status === "pending" || c.status === "syncing")).length;
}

// ── Sender (auto-run: importar este módulo já registra) ────────────────────
registerCommandSender(FALATU_CMD_TYPE, async (cmd: OutboxCommand) => {
  try {
    const res = await apiFetch("/api/falatu/capture", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...(cmd.payload as object), commandId: cmd.commandId }),
    });
    if (res.ok) {
      window.dispatchEvent(new CustomEvent("falatu:outbox-sent"));
      return "sent";
    }
    return "failed";
  } catch {
    return "retry";
  }
});
