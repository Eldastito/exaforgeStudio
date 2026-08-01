/**
 * Comigo Balcão — fila offline (Gap D do levantamento autônomos).
 *
 * Cola o Balcão do frontend com o Continuity Layer (outbox IDB + flusher +
 * registry de senders). Cada operação de venda vira um comando persistido:
 *
 *   COMIGO_OPEN_ORDER  → POST /api/comigo/orders
 *   COMIGO_ADD_ITEM    → POST /api/comigo/orders/:orderId/items
 *   COMIGO_PAY         → POST /api/comigo/orders/:orderId/pay
 *
 * Como as 3 rotas aceitam `commandId` no body (backend dedup por
 * organization_id+command_id — src/server/BalcaoService.ts), reenvios do
 * outbox NUNCA duplicam pedido / item / dívida. O `orderId` é gerado no
 * CLIENTE quando o Balcão está offline, pra addItem/pay conseguirem
 * referenciar um pedido que o server ainda não viu — o server aceita `id`
 * do cliente no openOrder e usa como natural key.
 *
 * O sender rejeita 4xx/5xx (não adianta reenviar erros de validação); só
 * exceção de rede vira `retry`.
 */
import { apiFetch } from "@/src/lib/api";
import { getOutbox, registerCommandSender } from "@/src/lib/continuity/sync";
import type { OutboxCommand } from "@/src/lib/continuity/outbox";

export const COMIGO_CMD_TYPES = ["COMIGO_OPEN_ORDER", "COMIGO_ADD_ITEM", "COMIGO_PAY"] as const;
export type ComigoCmdType = typeof COMIGO_CMD_TYPES[number];

export type OpenOrderPayload = { orderId: string; sessionAlias?: string; contactId?: string; consumo?: string };
export type AddItemPayload = { orderId: string; productId?: string; name: string; qty: number; unitPrice: number; unitCostSnapshot?: number };
export type PayPayload = { orderId: string; paidVia: "cash" | "pix_manual" | "fiado"; customer?: { name: string; phone: string }; override?: boolean };

/** True se a última tentativa foi um erro de rede (ou se navigator.onLine indica offline). */
export function isNetworkError(e: unknown): boolean {
  if (typeof navigator !== "undefined" && !navigator.onLine) return true;
  const msg = e instanceof Error ? e.message : String(e || "");
  return /fail(ed)?|network|fetch/i.test(msg);
}

/** Enfileira "abrir pedido". `orderId` VEM DO CLIENTE (crypto.randomUUID). */
export async function enqueueOpenOrder(commandId: string, p: OpenOrderPayload) {
  await getOutbox().enqueue({ commandId, type: "COMIGO_OPEN_ORDER", payload: p });
}

export async function enqueueAddItem(commandId: string, p: AddItemPayload) {
  await getOutbox().enqueue({ commandId, type: "COMIGO_ADD_ITEM", payload: p });
}

export async function enqueuePay(commandId: string, p: PayPayload) {
  await getOutbox().enqueue({ commandId, type: "COMIGO_PAY", payload: p });
}

/** Contagem de comandos do Balcão pendentes (pra chip "sincronizando N"). */
export async function pendingComigoCount(): Promise<number> {
  const all = await getOutbox().all();
  return all.filter(c => (COMIGO_CMD_TYPES as readonly string[]).includes(c.type) && (c.status === "pending" || c.status === "syncing")).length;
}

// ── Registro dos senders (auto-run: importar este módulo já registra) ──────
function isNetworkFailure(e: unknown) { return e instanceof TypeError || /fetch|network/i.test(String((e as any)?.message || "")); }

registerCommandSender("COMIGO_OPEN_ORDER", async (cmd: OutboxCommand) => {
  try {
    const p = cmd.payload as OpenOrderPayload;
    const res = await apiFetch("/api/comigo/orders", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: p.orderId, sessionAlias: p.sessionAlias, contactId: p.contactId, consumo: p.consumo, commandId: cmd.commandId }),
    });
    return res.ok ? "sent" : "failed";
  } catch (e) {
    return isNetworkFailure(e) ? "retry" : "failed";
  }
});

registerCommandSender("COMIGO_ADD_ITEM", async (cmd: OutboxCommand) => {
  try {
    const p = cmd.payload as AddItemPayload;
    const res = await apiFetch(`/api/comigo/orders/${encodeURIComponent(p.orderId)}/items`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ productId: p.productId, name: p.name, qty: p.qty, unitPrice: p.unitPrice, unitCostSnapshot: p.unitCostSnapshot, commandId: cmd.commandId }),
    });
    return res.ok ? "sent" : "failed";
  } catch (e) {
    return isNetworkFailure(e) ? "retry" : "failed";
  }
});

registerCommandSender("COMIGO_PAY", async (cmd: OutboxCommand) => {
  try {
    const p = cmd.payload as PayPayload;
    const res = await apiFetch(`/api/comigo/orders/${encodeURIComponent(p.orderId)}/pay`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paidVia: p.paidVia, customer: p.customer, override: p.override, commandId: cmd.commandId }),
    });
    return res.ok ? "sent" : "failed";
  } catch (e) {
    return isNetworkFailure(e) ? "retry" : "failed";
  }
});
