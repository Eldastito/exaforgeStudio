/**
 * ConsolidatedResultService — ADR-186 F1: resultado CONSOLIDADO (all-channels) = core + lojas.
 *
 * O DRE gerencial (`ManagerialDreService`) é CORE-only (exclui receita E custo das lojas físicas);
 * o resultado das lojas (`RetailStoreCostService`) vive numa tela à parte e nunca é folded. Este
 * service COMPÕE os dois (read-only) e devolve o lucro REAL do dono, AO LADO do core (nunca no
 * lugar — 0-regressão), escopo-rotulado, HONESTO onde o custo de loja é incomputável (herda o
 * null-by-design do RetailStoreCostService → `partial`), e DETECTANDO a dupla contagem de custo
 * (mesmo custo — ex.: aluguel — lançado como payable E como custo fixo de loja subtrairia 2×).
 *
 * Guardrails RN-CR: 1 (não muta o core) · 2 (escopo rotulado) · 3 (custo de loja honesto-null →
 * partial) · 4 (dupla contagem detectada, nunca subtrai 2× em silêncio) · 5 (read-only/derivado) ·
 * 6 (nunca inventa lucro) · 7 (isolado/determinístico/honesto).
 */
import db from "./db.js";
import { ManagerialDreService } from "./ManagerialDreService.js";
import { RetailStoreCostService } from "./RetailStoreCostService.js";

function round2(n: number): number { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }

export interface ConsolidatedResult {
  period: string;
  core: { resultadoOperacional: number; scope: "core" };
  stores: {
    resultado: number;
    faturamento: number;
    storesTotal: number;
    storesWithResult: number;
    materialMissing: number; // lojas com faturamento mas SEM resultado computável
  };
  consolidated: { resultadoOperacional: number; partial: boolean; scope: "all_channels" };
  doubleCountRisk: boolean;
  doubleCountCategories: string[];
  note: string;
}

export class ConsolidatedResultService {
  /**
   * Dupla contagem: mesma categoria de custo aparecendo em `payables` (competência do mês) E em
   * `retail_store_fixed_costs`. Heurística por categoria (payable é texto livre → `contains`);
   * advisory (hipótese), nunca prova. Sem custo fixo de loja → sem risco.
   */
  private static detectDoubleCount(orgId: string, period: string): { risk: boolean; categories: string[] } {
    try {
      const storeCatRows = db.prepare(`SELECT DISTINCT LOWER(TRIM(category)) c FROM retail_store_fixed_costs WHERE organization_id = ? AND category IS NOT NULL`).all(orgId) as any[];
      const storeCats = storeCatRows.map((r) => r.c).filter(Boolean);
      if (storeCats.length === 0) return { risk: false, categories: [] };
      const payRows = db.prepare(`SELECT DISTINCT LOWER(TRIM(COALESCE(category,''))) c FROM payables WHERE organization_id = ? AND status IN ('open','paid') AND strftime('%Y-%m', due_date) = ?`).all(orgId, period) as any[];
      const payCats = payRows.map((r) => r.c).filter(Boolean);
      const overlap = storeCats.filter((sc) => payCats.some((pc) => pc === sc || pc.includes(sc)));
      return { risk: overlap.length > 0, categories: overlap };
    } catch { return { risk: false, categories: [] }; }
  }

  /** Resultado consolidado do mês. Core intacto; consolidado ao lado; honesto/partial; dupla-contagem flag. */
  static monthly(orgId: string, period: string): ConsolidatedResult {
    const dre = ManagerialDreService.monthly(orgId, period) as any;
    const coreResult = round2(Number(dre?.linhas?.resultadoOperacional) || 0);

    const stores = RetailStoreCostService.allStoresResult(orgId, period) as any;
    const perStore: any[] = stores?.perStore || [];
    const storesResult = round2(Number(stores?.totals?.resultado) || 0); // soma só os resultados não-null
    const storesFaturamento = round2(Number(stores?.totals?.faturamento) || 0);
    const storesWithResult = perStore.filter((s) => s.resultado !== null && s.resultado !== undefined).length;
    // Loja MATERIAL sem resultado computável = tem faturamento mas o resultado é null (sem margem/avg_cost).
    const materialMissing = perStore.filter((s) => (s.resultado === null || s.resultado === undefined) && Number(s.faturamento) > 0).length;
    const partial = materialMissing > 0;

    // Consolidado = core + lojas. Sem loja nenhuma, all_channels == core (não há o que somar).
    const consolidated = round2(coreResult + storesResult);

    const { risk, categories } = this.detectDoubleCount(orgId, period);

    const parts: string[] = [];
    if (perStore.length === 0) parts.push("Sem lojas físicas: resultado consolidado = resultado core.");
    else parts.push("Resultado consolidado = resultado core (pedidos + Comigo) + resultado das lojas (Operação da Rede).");
    if (partial) parts.push(`${materialMissing} loja(s) com faturamento mas SEM resultado computável (falta margem/custo cadastrado) — o consolidado é PARCIAL, não inventa lucro de loja.`);
    if (risk) parts.push(`Atenção: custo(s) "${categories.join(", ")}" aparece(m) como conta a pagar E como custo fixo de loja — se for o MESMO custo, ele está sendo subtraído duas vezes. Confira.`);

    return {
      period,
      core: { resultadoOperacional: coreResult, scope: "core" },
      stores: { resultado: storesResult, faturamento: storesFaturamento, storesTotal: perStore.length, storesWithResult, materialMissing },
      consolidated: { resultadoOperacional: consolidated, partial, scope: "all_channels" },
      doubleCountRisk: risk,
      doubleCountCategories: categories,
      note: parts.join(" "),
    };
  }
}

export default ConsolidatedResultService;
