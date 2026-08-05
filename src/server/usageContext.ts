import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Contexto de execução que carrega a organização "dona" das chamadas de IA do
 * fluxo atual (requisição autenticada ou mensagem do webhook). Permite atribuir
 * o consumo de tokens/custo de cada chamada de LLM à empresa certa, sem ter que
 * passar o orgId por todas as funções de IA.
 *
 * ADR-154 Fatia 1.1 — estende o contexto com userId (opcional) + module
 * (default 'legacy') pra que o ledger `ai_usage_log` possa atribuir custo NÃO
 * SÓ à org, mas também ao usuário e ao módulo que originou a chamada
 * (falatu/clinica/comigo/retail/escola/...). É aditivo: setUsageOrg continua
 * funcionando (só zera userId/module ao setar); quem quiser granularidade usa
 * setUsageContext. Assim, o "backfill best-effort" da fatia é opcional — call
 * sites migram no seu ritmo, e o que não migrou grava module='legacy'.
 */

interface UsageContext {
  orgId: string | null;
  userId: string | null;
  module: string; // 'legacy' se o call site não migrou
}

export const usageContext = new AsyncLocalStorage<UsageContext>();

/** Define a org do fluxo atual (vale para os awaits seguintes deste contexto). */
export function setUsageOrg(orgId: string | null): void {
  try { usageContext.enterWith({ orgId: orgId || null, userId: null, module: "legacy" }); } catch { /* noop */ }
}

/**
 * Define contexto completo (org + usuário + módulo). Preferir sobre setUsageOrg
 * quando a call site souber quem é o usuário e qual módulo está chamando IA —
 * é isso que popula o ledger com atribuição granular.
 */
export function setUsageContext(ctx: { orgId?: string | null; userId?: string | null; module?: string }): void {
  try {
    usageContext.enterWith({
      orgId: ctx.orgId || null,
      userId: ctx.userId || null,
      module: (ctx.module || "legacy").toLowerCase(),
    });
  } catch { /* noop */ }
}

/** Org atual do contexto de execução (ou null se não houver). */
export function currentOrgId(): string | null {
  return usageContext.getStore()?.orgId || null;
}

/** Contexto completo (org + usuário + módulo). Sempre retorna algo (defaults). */
export function currentUsageContext(): UsageContext {
  const s = usageContext.getStore();
  return { orgId: s?.orgId || null, userId: s?.userId || null, module: s?.module || "legacy" };
}
