/**
 * RetailReplenishmentStrategyService — estratégia de reposição da empresa (PRD Fase 1, F1.3).
 *
 * TOULON vende por COLEÇÃO: produto que zera no fim do ciclo é FIM NORMAL, não "ruptura a recomprar". O
 * sistema não pode empurrar "reponha/recalibre ponto de pedido" pra tudo que zerou.
 *  - `continuous_replenishment` (DEFAULT, comportamento de sempre — 0-regressão): zerou → vale sugerir recompra;
 *  - `collection_sellout`: zerou NÃO gera sugestão de recompra — EXCEÇÃO por peça: se a peça tem política de estoque
 *    (mínimo/alvo em `retail_stock_policies`), o dono disse que ela é reposta → continua sugerindo. A política É a
 *    exceção (sem tabela nova): "uma peça ou outra voltar a ser vendida" = o dono define a meta dela.
 * Escopo: silencia SÓ a sugestão de recompra (padrão `produto_ruptura_recorrente`). NÃO toca a oportunidade de
 * TRANSFERÊNCIA (`RetailFloorReplenishmentService`: zerou aqui + sobra em outra loja = dinheiro) nem o diagnóstico de
 * estoque NEGATIVO (divergência de dado ≠ fim de coleção). Um resolver, N consumidores. Isola por org.
 */
import db from "./db.js";
import { RetailStockPolicyService } from "./RetailStockPolicyService.js";
import { logAuthEvent } from "./auditLog.js";

export type ReplenishmentStrategy = "continuous_replenishment" | "collection_sellout";
export const STRATEGIES: ReplenishmentStrategy[] = ["continuous_replenishment", "collection_sellout"];

export class RetailReplenishmentStrategyService {
  static strategy(orgId: string): ReplenishmentStrategy {
    try {
      const r = db.prepare(`SELECT retail_replenishment_strategy AS s FROM organization_settings WHERE organization_id = ?`).get(orgId) as any;
      return r?.s === "collection_sellout" ? "collection_sellout" : "continuous_replenishment";
    } catch { return "continuous_replenishment"; }
  }

  static setStrategy(orgId: string, strategy: string, actorId?: string | null): ReplenishmentStrategy {
    if (!STRATEGIES.includes(strategy as ReplenishmentStrategy)) throw new Error(`estratégia inválida (${STRATEGIES.join("|")})`);
    db.prepare(`UPDATE organization_settings SET retail_replenishment_strategy = ? WHERE organization_id = ?`).run(strategy, orgId);
    try { logAuthEvent(orgId, actorId || "system", orgId, "RETAIL_REPLENISHMENT_STRATEGY_SET", { strategy }); } catch { /* noop */ }
    return strategy as ReplenishmentStrategy;
  }

  /** A peça tem meta de estoque definida pelo dono (qualquer escopo)? É a exceção do fim de coleção. */
  static hasPolicy(orgId: string, productId: string): boolean {
    try { return RetailStockPolicyService.list(orgId, { productId }).length > 0; } catch { return false; }
  }

  /** Vale SUGERIR recompra deste produto? (continuous: sim · collection_sellout: só com política = exceção.) */
  static suggestsRepurchase(orgId: string, productId: string): boolean {
    if (this.strategy(orgId) === "continuous_replenishment") return true;
    return this.hasPolicy(orgId, productId);
  }
}

export default RetailReplenishmentStrategyService;
