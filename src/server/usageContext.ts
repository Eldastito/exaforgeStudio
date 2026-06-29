import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Contexto de execução que carrega a organização "dona" das chamadas de IA do
 * fluxo atual (requisição autenticada ou mensagem do webhook). Permite atribuir
 * o consumo de tokens/custo de cada chamada de LLM à empresa certa, sem ter que
 * passar o orgId por todas as funções de IA.
 */
export const usageContext = new AsyncLocalStorage<{ orgId: string | null }>();

/** Define a org do fluxo atual (vale para os awaits seguintes deste contexto). */
export function setUsageOrg(orgId: string | null): void {
  try { usageContext.enterWith({ orgId: orgId || null }); } catch { /* noop */ }
}

/** Org atual do contexto de execução (ou null se não houver). */
export function currentOrgId(): string | null {
  return usageContext.getStore()?.orgId || null;
}
