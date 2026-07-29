/**
 * Retail Ops — Custos fixos + RESULTADO/LUCRO por loja (ADR-083, extensão).
 *
 * O gestor perguntou onde lançar os custos fixos de cada loja (aluguel, luz,
 * condomínio, água...) para ver o LUCRO por loja. Até aqui o app só tinha
 * custo fixo AGREGADO da organização (`comigo_fixed_costs_monthly`) e contas a
 * pagar sem loja (`payables`) — nada segmentável por filial. Esta camada:
 *
 *   1. guarda os custos DISCRIMINADOS por tipo, por loja (`retail_store_fixed_costs`);
 *   2. calcula o RESULTADO gerencial da loja no mês e o PONTO DE EQUILÍBRIO.
 *
 * Cálculo (gerencial, estimado — NÃO substitui a contabilidade):
 *   Faturamento   = fechamentos do mês (system_total do PDV quando houver, senão
 *                   informed_total; exclui 'rejected') — a MESMA régua que a aba
 *                   "Operação da Rede" já mostra por loja.
 *   Margem contrib.= Faturamento × margem bruta média da loja (%)  ← premissa
 *   Resultado      = Margem de contribuição − custos fixos da loja
 *   Ponto equilíb. = custos fixos ÷ (margem bruta % / 100)   [em faturamento]
 *
 * Guardrail: sem a margem bruta cadastrada na loja, resultado e ponto de
 * equilíbrio ficam NULL (o app nunca finge lucro subtraindo só o custo fixo do
 * faturamento — isso ignoraria o custo da mercadoria e mentiria pra cima).
 * Determinístico, zero-token, isolado por organização.
 */
import { randomUUID } from "node:crypto";
import db from "./db.js";
import { RetailStoreService } from "./RetailStoreService.js";

const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

/** Categorias de custo fixo suportadas (chave técnica + rótulo pro gestor). */
export const FIXED_COST_CATEGORIES = [
  { key: "aluguel", label: "Aluguel" },
  { key: "energia", label: "Energia (luz)" },
  { key: "condominio", label: "Condomínio" },
  { key: "agua", label: "Água" },
  { key: "internet", label: "Internet/telefone" },
  { key: "folha", label: "Folha (salários)" },
  { key: "outros", label: "Outros" },
] as const;

export type FixedCostCategory = (typeof FIXED_COST_CATEGORIES)[number]["key"];
const CATEGORY_KEYS = new Set<string>(FIXED_COST_CATEGORIES.map((c) => c.key));

// Faturamento da loja: prefere a verdade do PDV (system_total) quando houver,
// senão o total informado; ignora fechamentos rejeitados. Mesma expressão de
// valor da Ponte de Faturamento (RetailRevenueBridgeService), por consistência.
const VALUE_EXPR = "COALESCE(NULLIF(system_total, 0), informed_total)";

export type StoreCostMap = Partial<Record<FixedCostCategory, number>>;

export interface StoreCosts {
  byCategory: Record<string, number>;
  total: number;
}

export interface StoreResult {
  storeId: string;
  storeName: string;
  period: string;
  faturamento: number;
  custosFixos: StoreCosts;
  grossMarginPercent: number | null;
  margemContribuicao: number | null;
  resultado: number | null;
  pontoEquilibrio: number | null;
  progressoEquilibrio: number | null; // faturamento ÷ ponto de equilíbrio (0..1+)
  hasMargin: boolean;
  hasCustos: boolean;
  disclaimer: string;
}

const DISCLAIMER =
  "Resultado gerencial e estimado (faturamento × margem − custos fixos) — não substitui a contabilidade oficial.";

export class RetailStoreCostService {
  /** Custos fixos cadastrados da loja, por categoria + total. */
  static list(orgId: string, storeId: string): StoreCosts {
    const rows = db
      .prepare(
        `SELECT category, amount FROM retail_store_fixed_costs WHERE organization_id = ? AND store_id = ?`
      )
      .all(orgId, storeId) as any[];
    const byCategory: Record<string, number> = {};
    let total = 0;
    for (const c of FIXED_COST_CATEGORIES) byCategory[c.key] = 0; // sempre expõe as 7 chaves
    for (const r of rows) {
      const amount = round2(r.amount);
      if (CATEGORY_KEYS.has(r.category)) byCategory[r.category] = amount;
      total += amount;
    }
    return { byCategory, total: round2(total) };
  }

  /** Upsert em lote dos custos da loja a partir de { categoria: valor }. Valor
   *  <= 0 (ou não numérico) ZERA a categoria; categorias fora da lista são
   *  ignoradas. Só owner/admin chega aqui (checado na rota). */
  static setMany(orgId: string, storeId: string, costs: StoreCostMap): StoreCosts {
    if (!RetailStoreService.get(orgId, storeId)) throw new Error("Loja não encontrada.");
    const upsert = db.prepare(
      `INSERT INTO retail_store_fixed_costs (id, organization_id, store_id, category, amount)
         VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(organization_id, store_id, category)
         DO UPDATE SET amount = excluded.amount, updated_at = CURRENT_TIMESTAMP`
    );
    const tx = db.transaction(() => {
      for (const c of FIXED_COST_CATEGORIES) {
        if (!(c.key in (costs || {}))) continue; // só mexe no que veio no payload
        const raw = Number((costs as any)[c.key]);
        const amount = Number.isFinite(raw) && raw > 0 ? round2(raw) : 0;
        upsert.run(randomUUID(), orgId, storeId, c.key, amount);
      }
    });
    tx();
    return this.list(orgId, storeId);
  }

  /** Total mensal de custo fixo da loja (soma das categorias). */
  static monthlyFixedTotal(orgId: string, storeId: string): number {
    return this.list(orgId, storeId).total;
  }

  /** Faturamento do mês da loja (fechamentos elegíveis). period = 'YYYY-MM'. */
  static monthlyRevenue(orgId: string, storeId: string, period: string): number {
    try {
      const r = db
        .prepare(
          `SELECT COALESCE(SUM(${VALUE_EXPR}), 0) AS s
             FROM retail_daily_closings
            WHERE organization_id = ? AND store_id = ? AND status != 'rejected'
              AND strftime('%Y-%m', closing_date) = ?`
        )
        .get(orgId, storeId, period) as any;
      return round2(r?.s);
    } catch {
      return 0;
    }
  }

  /** Resultado gerencial + ponto de equilíbrio da loja no mês. */
  static storeResult(
    orgId: string,
    storeId: string,
    period = new Date().toISOString().slice(0, 7)
  ): StoreResult | null {
    const store = RetailStoreService.get(orgId, storeId);
    if (!store) return null;
    const faturamento = this.monthlyRevenue(orgId, storeId, period);
    const custosFixos = this.list(orgId, storeId);
    const marginPct: number | null =
      store.gross_margin_percent === null || store.gross_margin_percent === undefined
        ? null
        : Number(store.gross_margin_percent);
    const hasMargin = marginPct !== null && marginPct > 0;

    const margemContribuicao = hasMargin ? round2(faturamento * (marginPct as number) / 100) : null;
    const resultado = hasMargin ? round2((margemContribuicao as number) - custosFixos.total) : null;
    const pontoEquilibrio = hasMargin ? round2(custosFixos.total / ((marginPct as number) / 100)) : null;
    const progressoEquilibrio =
      pontoEquilibrio && pontoEquilibrio > 0 ? round2(faturamento / pontoEquilibrio) : null;

    return {
      storeId,
      storeName: store.name,
      period,
      faturamento,
      custosFixos,
      grossMarginPercent: marginPct,
      margemContribuicao,
      resultado,
      pontoEquilibrio,
      progressoEquilibrio,
      hasMargin,
      hasCustos: custosFixos.total > 0,
      disclaimer: DISCLAIMER,
    };
  }

  /** Resultado de TODAS as lojas ativas no mês + totais da rede. */
  static allStoresResult(orgId: string, period = new Date().toISOString().slice(0, 7)) {
    const stores = RetailStoreService.list(orgId).filter((s: any) => s.active === 1 || s.active === true);
    const perStore = stores
      .map((s: any) => this.storeResult(orgId, s.id, period))
      .filter((r): r is StoreResult => r !== null);
    const totals = perStore.reduce(
      (a, r) => {
        a.faturamento += r.faturamento;
        a.custosFixos += r.custosFixos.total;
        if (r.resultado !== null) a.resultado += r.resultado;
        return a;
      },
      { faturamento: 0, custosFixos: 0, resultado: 0 }
    );
    return {
      period,
      perStore,
      totals: {
        faturamento: round2(totals.faturamento),
        custosFixos: round2(totals.custosFixos),
        resultado: round2(totals.resultado),
      },
      categories: FIXED_COST_CATEGORIES,
      disclaimer: DISCLAIMER,
    };
  }
}

export default RetailStoreCostService;
