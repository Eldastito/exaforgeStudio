/**
 * Retail Ops — Custos fixos + variáveis + RESULTADO/LUCRO por loja
 * (ADR-083, extensões E1–E5).
 *
 * O gestor perguntou onde lançar os custos fixos de cada loja (aluguel, luz,
 * condomínio, água...) para ver o LUCRO por loja, e depois pediu para "fechar
 * a precificação de ponta a ponta" — o que exige também os custos VARIÁVEIS
 * (taxa de cartão/Pix, imposto sobre venda, embalagem, frete). Esta camada:
 *
 *   1. guarda os custos FIXOS DISCRIMINADOS por tipo, por loja
 *      (`retail_store_fixed_costs`);
 *   2. guarda os custos VARIÁVEIS por tipo, por loja, com dupla natureza
 *      (% do faturamento e/ou R$ por venda) — `retail_store_variable_costs`;
 *   3. calcula o RESULTADO gerencial da loja no mês e o PONTO DE EQUILÍBRIO
 *      com a cadeia completa.
 *
 * Cadeia de cálculo (gerencial, estimada — NÃO substitui a contabilidade):
 *   Faturamento    = fechamentos do mês (system_total do PDV quando houver,
 *                    senão informed_total; exclui 'rejected') — MESMA régua
 *                    que a aba "Operação da Rede" já mostra por loja.
 *   Custo Mercadoria = Faturamento × (1 − margem bruta %)   ← premissa
 *   Margem BRUTA   = Faturamento − Custo Mercadoria
 *                  = Faturamento × margem bruta %
 *   Custo Variável = Faturamento × Σ(percent) + nº vendas × Σ(fixed_per_sale)
 *   Margem CONTRIB = Margem BRUTA − Custo Variável
 *   Resultado      = Margem CONTRIB − custos fixos da loja
 *   MC% efetiva    = Margem CONTRIB ÷ Faturamento (quando faturamento > 0)
 *   Ponto equilíb. = custos fixos ÷ MC% efetiva    [em faturamento]
 *
 * Guardrails:
 *   - Sem `gross_margin_percent`: `resultado` e `pontoEquilibrio` ficam NULL
 *     (o app nunca finge lucro sem CMV — mentiria pra cima).
 *   - `fixed_per_sale` > 0 sem contagem de vendas do mês (nenhum PDV nem
 *     fechamento aprovado): a parcela é IGNORADA e sinalizada em
 *     `variableCostsWarning` (não estimamos "quantas vendas ocorreram").
 *
 * Determinístico, zero-token, isolado por organização.
 */
import { randomUUID } from "node:crypto";
import db from "./db.js";
import { RetailStoreService } from "./RetailStoreService.js";
import { RetailAnalyticsCache } from "./RetailAnalyticsCache.js";
import { logAuthEvent } from "./auditLog.js";

const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

/** CMV vazio (loja sem venda PDV item-a-item no mês → cai pro estimado). */
const EMPTY_CMV = (): StoreCmvBreakdown => ({
  source: "estimate",
  coverage: 0,
  cmvReal: 0,
  revenueCovered: 0,
  revenueTotalPdv: 0,
});

/** Custos fixos zerados com as 7 chaves (mesma forma que `list`). */
const emptyStoreCosts = (): StoreCosts => {
  const byCategory: Record<string, number> = {};
  for (const c of FIXED_COST_CATEGORIES) byCategory[c.key] = 0;
  return { byCategory, total: 0 };
};

/** Custos variáveis zerados com as chaves (mesma forma que `listVariable`). */
const emptyStoreVariableCosts = (): StoreVariableCosts => {
  const byCategory: Record<string, { percent: number; fixedPerSale: number }> = {};
  for (const c of VARIABLE_COST_CATEGORIES) byCategory[c.key] = { percent: 0, fixedPerSale: 0 };
  return { byCategory, totalPercent: 0, totalFixedPerSale: 0 };
};

/** Categorias de custo FIXO suportadas (chave técnica + rótulo pro gestor). */
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

/** Categorias de custo VARIÁVEL — o que sai proporcional à venda (ADR-083 E5).
 *  Duas naturezas por categoria: `percent` (% do faturamento, ex.: cartão,
 *  imposto) e `fixedPerSale` (R$ por venda/ticket, ex.: embalagem por pedido).
 *  Uma categoria pode ter as duas (ex.: cartão com fee % + tarifa fixa). */
export const VARIABLE_COST_CATEGORIES = [
  { key: "card_fee", label: "Taxa de cartão" },
  { key: "pix_fee", label: "Taxa de Pix" },
  { key: "tax_sale", label: "Imposto sobre venda (Simples etc.)" },
  { key: "packaging", label: "Embalagem" },
  { key: "freight", label: "Frete" },
  { key: "other", label: "Outros variáveis" },
] as const;

export type VariableCostCategory = (typeof VARIABLE_COST_CATEGORIES)[number]["key"];
const VAR_CATEGORY_KEYS = new Set<string>(VARIABLE_COST_CATEGORIES.map((c) => c.key));

// Faturamento da loja: prefere a verdade do PDV (system_total) quando houver,
// senão o total informado; ignora fechamentos rejeitados. Mesma expressão de
// valor da Ponte de Faturamento (RetailRevenueBridgeService), por consistência.
const VALUE_EXPR = "COALESCE(NULLIF(system_total, 0), informed_total)";

export type StoreCostMap = Partial<Record<FixedCostCategory, number>>;
export type StoreVariableCostInput = { percent?: number; fixedPerSale?: number };
export type StoreVariableCostMap = Partial<Record<VariableCostCategory, StoreVariableCostInput>>;

export interface StoreCosts {
  byCategory: Record<string, number>;
  total: number;
}

export interface StoreVariableCosts {
  byCategory: Record<string, { percent: number; fixedPerSale: number }>;
  totalPercent: number;      // Σ percent (referência)
  totalFixedPerSale: number; // Σ fixed_per_sale (referência)
}

/** Detalhamento do CMV usado no cálculo da loja (ADR-083 E6).
 *  source explica de onde veio o custo da mercadoria:
 *    - 'estimate' → 100% via gross_margin_percent (nenhum item PDV tem avg_cost).
 *    - 'blended'  → parte real (avg_cost × qtd) + parte estimada (fallback pra
 *                   os itens sem avg_cost, usando gross_margin_percent).
 *    - 'real'     → 100% real (todos os itens vendidos têm avg_cost).
 *  coverage = R$ dos itens com avg_cost / R$ total de itens PDV do mês (0..1).
 */
export interface StoreCmvBreakdown {
  source: "estimate" | "blended" | "real";
  coverage: number;                     // 0..1
  cmvReal: number;                      // Σ(qtd × avg_cost) dos itens cobertos
  revenueCovered: number;               // Σ(valor dos itens cobertos)
  revenueTotalPdv: number;              // Σ(valor de TODOS os itens PDV do mês)
}

export interface StoreResult {
  storeId: string;
  storeName: string;
  period: string;
  faturamento: number;
  vendasCount: number | null;         // nº de vendas do mês (null quando ausente)
  custosFixos: StoreCosts;
  custosVariaveis: StoreVariableCosts;
  custoVariavelTotal: number | null;  // R$ estimado no mês (proporcionais + fixos×vendas)
  grossMarginPercent: number | null;
  cmv: number | null;                          // CMV total usado (blended ou estimado)
  cmvBreakdown: StoreCmvBreakdown | null;      // Detalhamento pra UI (fonte, cobertura, real)
  margemBruta: number | null;                  // Faturamento − CMV
  margemContribuicao: number | null;           // Margem bruta − custo variável
  margemContribuicaoPercent: number | null;    // MC ÷ Faturamento (efetiva)
  resultado: number | null;
  pontoEquilibrio: number | null;
  progressoEquilibrio: number | null;          // faturamento ÷ ponto de equilíbrio (0..1+)
  hasMargin: boolean;
  hasCustos: boolean;
  variableCostsWarning: string | null;         // "fixed_per_sale ignorado — sem contagem de vendas" etc.
  cmvWarning: string | null;                   // "só 40% dos itens vendidos têm custo cadastrado" etc.
  disclaimer: string;
}

const DISCLAIMER =
  "Resultado gerencial e estimado (faturamento × margem − custos variáveis − custos fixos) — não substitui a contabilidade oficial.";

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

  /** Upsert em lote dos custos FIXOS da loja a partir de { categoria: valor }.
   *  Valor <= 0 (ou não numérico) ZERA a categoria; categorias fora da lista
   *  são ignoradas. Só owner/admin chega aqui (checado na rota). */
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
    RetailAnalyticsCache.invalidate(orgId); // PERF-005: custo mudou → recomputa
    return this.list(orgId, storeId);
  }

  /** Custos VARIÁVEIS cadastrados da loja (percent + fixed_per_sale por categoria). */
  static listVariable(orgId: string, storeId: string): StoreVariableCosts {
    const rows = db
      .prepare(
        `SELECT category, percent, fixed_per_sale FROM retail_store_variable_costs
          WHERE organization_id = ? AND store_id = ?`
      )
      .all(orgId, storeId) as any[];
    const byCategory: Record<string, { percent: number; fixedPerSale: number }> = {};
    let totalPercent = 0;
    let totalFixedPerSale = 0;
    for (const c of VARIABLE_COST_CATEGORIES) byCategory[c.key] = { percent: 0, fixedPerSale: 0 };
    for (const r of rows) {
      if (!VAR_CATEGORY_KEYS.has(r.category)) continue;
      const p = round2(r.percent);
      const f = round2(r.fixed_per_sale);
      byCategory[r.category] = { percent: p, fixedPerSale: f };
      totalPercent += p;
      totalFixedPerSale += f;
    }
    return {
      byCategory,
      totalPercent: round2(totalPercent),
      totalFixedPerSale: round2(totalFixedPerSale),
    };
  }

  /** Upsert em lote dos custos VARIÁVEIS. Payload é {categoria: {percent, fixedPerSale}}.
   *  Valor <= 0 zera a natureza (as duas naturezas convivem por linha). */
  static setManyVariable(
    orgId: string,
    storeId: string,
    costs: StoreVariableCostMap
  ): StoreVariableCosts {
    if (!RetailStoreService.get(orgId, storeId)) throw new Error("Loja não encontrada.");
    const upsert = db.prepare(
      `INSERT INTO retail_store_variable_costs (id, organization_id, store_id, category, percent, fixed_per_sale)
         VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(organization_id, store_id, category)
         DO UPDATE SET percent = excluded.percent,
                       fixed_per_sale = excluded.fixed_per_sale,
                       updated_at = CURRENT_TIMESTAMP`
    );
    const tx = db.transaction(() => {
      for (const c of VARIABLE_COST_CATEGORIES) {
        if (!(c.key in (costs || {}))) continue; // só mexe no que veio no payload
        const raw = (costs as any)[c.key] || {};
        const rawPct = Number(raw.percent);
        const rawFix = Number(raw.fixedPerSale);
        // Clamp: percent 0..100; fixed_per_sale >= 0. Não-numérico vira 0.
        const percent =
          Number.isFinite(rawPct) && rawPct > 0 ? round2(Math.min(rawPct, 100)) : 0;
        const fixedPerSale =
          Number.isFinite(rawFix) && rawFix > 0 ? round2(rawFix) : 0;
        upsert.run(randomUUID(), orgId, storeId, c.key, percent, fixedPerSale);
      }
    });
    tx();
    RetailAnalyticsCache.invalidate(orgId); // PERF-005: custo variável mudou
    return this.listVariable(orgId, storeId);
  }

  /**
   * SAVE-001/003 (PDR TOULON, Fatia 1C) — configuração financeira COMPOSTA da
   * loja (margem + custos fixos + custos variáveis) num só lugar, com versão
   * otimista. Leitura para a UI nova.
   */
  static financialSettings(orgId: string, storeId: string): any {
    const store = db.prepare(`SELECT gross_margin_percent, financial_settings_version, updated_at FROM retail_stores WHERE organization_id = ? AND id = ?`).get(orgId, storeId) as any;
    if (!store) throw new Error("Loja não encontrada.");
    return {
      grossMarginPercent: store.gross_margin_percent != null ? Number(store.gross_margin_percent) : null,
      fixedCosts: this.list(orgId, storeId),
      variableCosts: this.listVariable(orgId, storeId),
      version: Number(store.financial_settings_version || 0),
      updatedAt: store.updated_at || null,
    };
  }

  /**
   * SAVE-001/002/003 — grava margem + custos fixos + custos variáveis numa ÚNICA
   * transação (all-or-nothing). Valida TUDO antes de persistir; se `expectedVersion`
   * não bater com a versão atual, lança conflito (o route devolve 409). Incrementa
   * a versão dentro da mesma transação. Nunca persistência parcial (SAVE fim do
   * `.catch(()=>{})`).
   */
  static saveFinancialSettings(
    orgId: string, storeId: string,
    payload: { grossMarginPercent?: number | null; fixedCosts?: Record<string, any>; variableCosts?: Record<string, any>; expectedVersion?: number | null },
    actorId?: string
  ): any {
    const store = db.prepare(`SELECT gross_margin_percent, financial_settings_version FROM retail_stores WHERE organization_id = ? AND id = ?`).get(orgId, storeId) as any;
    if (!store) throw new Error("Loja não encontrada.");
    const currentVersion = Number(store.financial_settings_version || 0);

    // Conflito otimista (SAVE-003): outro usuário salvou entre a leitura e este PUT.
    if (payload.expectedVersion != null && Number(payload.expectedVersion) !== currentVersion) {
      const err: any = new Error("version_conflict");
      err.code = "VERSION_CONFLICT";
      err.currentVersion = currentVersion;
      throw err;
    }

    // Validação ANTES de qualquer escrita (SAVE-001) — margem 0..100 ou null.
    let margin: number | null | undefined = undefined;
    if (payload.grossMarginPercent !== undefined) {
      const v: any = payload.grossMarginPercent;
      if (v === null || v === "") margin = null;
      else {
        const n = Number(v);
        if (!Number.isFinite(n) || n < 0 || n > 100) throw new Error("Margem bruta inválida (0 a 100).");
        margin = round2(n);
      }
    }
    const fixed = payload.fixedCosts || null;
    const variable = payload.variableCosts || null;

    const fixedUpsert = db.prepare(
      `INSERT INTO retail_store_fixed_costs (id, organization_id, store_id, category, amount)
         VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(organization_id, store_id, category) DO UPDATE SET amount = excluded.amount, updated_at = CURRENT_TIMESTAMP`
    );
    const varUpsert = db.prepare(
      `INSERT INTO retail_store_variable_costs (id, organization_id, store_id, category, percent, fixed_per_sale)
         VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(organization_id, store_id, category) DO UPDATE SET percent = excluded.percent, fixed_per_sale = excluded.fixed_per_sale, updated_at = CURRENT_TIMESTAMP`
    );

    const tx = db.transaction(() => {
      if (margin !== undefined) {
        db.prepare(`UPDATE retail_stores SET gross_margin_percent = ? WHERE organization_id = ? AND id = ?`).run(margin, orgId, storeId);
      }
      if (fixed) {
        for (const c of FIXED_COST_CATEGORIES) {
          if (!(c.key in fixed)) continue;
          const raw = Number(fixed[c.key]);
          fixedUpsert.run(randomUUID(), orgId, storeId, c.key, Number.isFinite(raw) && raw > 0 ? round2(raw) : 0);
        }
      }
      if (variable) {
        for (const c of VARIABLE_COST_CATEGORIES) {
          if (!(c.key in variable)) continue;
          const raw = variable[c.key] || {};
          const p = Number(raw.percent), f = Number(raw.fixedPerSale);
          varUpsert.run(randomUUID(), orgId, storeId, c.key, Number.isFinite(p) && p > 0 ? round2(Math.min(p, 100)) : 0, Number.isFinite(f) && f > 0 ? round2(f) : 0);
        }
      }
      // Incrementa a versão DENTRO da mesma transação (SAVE-003 / §7.6).
      db.prepare(`UPDATE retail_stores SET financial_settings_version = COALESCE(financial_settings_version, 0) + 1, updated_at = CURRENT_TIMESTAMP WHERE organization_id = ? AND id = ?`).run(orgId, storeId);
    });
    tx();
    RetailAnalyticsCache.invalidate(orgId); // PERF-005: margem/custos mudaram
    try { logAuthEvent(orgId, actorId || "system", storeId, "RETAIL_FINANCIAL_SETTINGS_SAVED", { fromVersion: currentVersion }); } catch { /* noop */ }
    return this.financialSettings(orgId, storeId);
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

  /**
   * Nº de vendas (tickets) da loja no mês — prefere a granularidade do PDV
   * (`retail_pdv_sales`, uma linha por venda), com fallback pra contagem de
   * fechamentos aprovados quando não há PDV. Retorna `null` quando NENHUMA
   * das duas fontes tem registro no mês (guardrail: sem contagem, o
   * `fixed_per_sale` dos custos variáveis é ignorado — não estimamos "por
   * cima" quantas vendas ocorreram).
   */
  static monthlySalesCount(orgId: string, storeId: string, period: string): number | null {
    // 1) PDV: join por retail_stores.code = retail_pdv_sales.filial (mesma
    //    régua usada em RetailCommissionService).
    try {
      const pdv = db
        .prepare(
          `SELECT COUNT(*) AS c
             FROM retail_pdv_sales s
             JOIN retail_stores st ON st.organization_id = s.organization_id
                                  AND st.code = s.filial
                                  AND st.active = 1
            WHERE s.organization_id = ? AND st.id = ?
              AND substr(s.sale_date, 1, 7) = ?`
        )
        .get(orgId, storeId, period) as any;
      const c = Number(pdv?.c) || 0;
      if (c > 0) return c;
    } catch { /* segue pro fallback */ }
    // 2) Fallback: fechamentos aprovados (grão de dia, não de ticket — melhor
    //    que zero, mas subestima o Σ fixed_per_sale).
    try {
      const closings = db
        .prepare(
          `SELECT COUNT(*) AS c FROM retail_daily_closings
            WHERE organization_id = ? AND store_id = ? AND status != 'rejected'
              AND strftime('%Y-%m', closing_date) = ?`
        )
        .get(orgId, storeId, period) as any;
      const c = Number(closings?.c) || 0;
      if (c > 0) return c;
    } catch {}
    return null;
  }

  /**
   * CMV REAL da loja no mês, derivado dos itens do PDV (`retail_pdv_sale_items`)
   * casados ao custo médio ponderado do produto no catálogo
   * (`inventory_items.avg_cost`). Segue a MESMA resolução produto→catálogo do
   * `/pdv-top-products` (variant.external_ref → variant.sku → product.external_ref
   * → LIKE-prefix), pra tolerar EAN 13 vs 12 dígitos e código do ERP.
   *
   * O `avg_cost` é ORG-WIDE (não por loja) — hoje só é populado por
   * `POST /api/products/invoice-scan/xml` (NF-e de entrada). Se a operação da
   * loja for 100% Alterdata/PDV sem cadastro de nota, `avg_cost` fica 0 pra
   * tudo e o CMV real é 0 — o fallback pro `gross_margin_percent` cobre
   * (`source: 'estimate'`, `coverage: 0`).
   *
   * Retorna sempre um objeto: se a loja não vende via PDV item-a-item no mês
   * (`revenueTotalPdv = 0`), `source = 'estimate'` e `coverage = 0` — o caller
   * cai pro cálculo estimado inteiro.
   */
  static monthlyCogsBreakdown(orgId: string, storeId: string, period: string): StoreCmvBreakdown {
    return this.monthlyCogsBreakdownAll(orgId, period, storeId).get(storeId) || EMPTY_CMV();
  }

  /**
   * CMV REAL de TODAS as lojas no mês, agregado por `store_id` numa consulta
   * (PERF-003 — evita o N+1 do `allStoresResult`). Consome as colunas RESOLVIDAS
   * do item (`product_service_id`/`variant_id`, PERF-001): itens já resolvidos
   * casam por índice; o join por PREFIXO (`LIKE`) roda SÓ para os itens ainda
   * não resolvidos (`catalog_resolved_at IS NULL`) — nunca pro histórico inteiro
   * a cada abertura (PERF-004). Passe `storeId` para restringir a uma loja.
   */
  static monthlyCogsBreakdownAll(
    orgId: string,
    period: string,
    storeId?: string
  ): Map<string, StoreCmvBreakdown> {
    const out = new Map<string, StoreCmvBreakdown>();
    try {
      const where = storeId ? "AND st.id = ?" : "";
      // PERF-004 (escala): os itens RESOLVIDOS agregam pela coluna (índice); o
      // prefixo LIKE roda SÓ no subconjunto NÃO resolvido (filtrado ANTES do
      // join, via idx_pdv_items_unresolved) — nunca varre o catálogo por linha.
      // O UNION ALL separa os dois mundos pra o planner não aplicar o LIKE ao
      // histórico inteiro (era O(itens × produtos) e travava a tela).
      const args: any[] = storeId ? [orgId, period, orgId, period, storeId] : [orgId, period, orgId, period];
      const rows = db
        .prepare(
          `SELECT st.id AS store_id,
             SUM(x.quantidade * COALESCE(inv.avg_cost, 0)) AS cogs,
             SUM(CASE WHEN inv.avg_cost > 0 THEN x.valor ELSE 0 END) AS revenue_covered,
             SUM(x.valor) AS revenue_total
           FROM (
             SELECT i.organization_id, i.filial, i.quantidade, i.valor,
                    i.product_service_id AS psid, i.variant_id AS vid
               FROM retail_pdv_sale_items i
              WHERE i.organization_id = ? AND substr(i.sale_date, 1, 7) = ?
                AND i.catalog_resolved_at IS NOT NULL
             UNION ALL
             SELECT i.organization_id, i.filial, i.quantidade, i.valor,
                    COALESCE(fpv.product_service_id, fps2.id) AS psid, fpv.id AS vid
               FROM retail_pdv_sale_items i
               LEFT JOIN product_variants fpv
                 ON fpv.organization_id = i.organization_id
                AND (fpv.external_ref = i.produto OR fpv.sku = i.produto)
               LEFT JOIN products_services fps2
                 ON fps2.organization_id = i.organization_id
                AND (fps2.external_ref = i.produto OR i.produto LIKE fps2.external_ref || '%')
              WHERE i.organization_id = ? AND substr(i.sale_date, 1, 7) = ?
                AND i.catalog_resolved_at IS NULL
           ) x
           JOIN retail_stores st
             ON st.organization_id = x.organization_id
            AND st.code = x.filial
            AND st.active = 1
           LEFT JOIN inventory_items inv
             ON inv.organization_id = x.organization_id
            AND inv.product_service_id = x.psid
            AND (inv.variant_id = x.vid OR inv.variant_id IS NULL)
          WHERE 1 = 1 ${where}
          GROUP BY st.id`
        )
        .all(...args) as any[];
      for (const r of rows) {
        const revenueTotalPdv = round2(r?.revenue_total);
        if (revenueTotalPdv <= 0) continue;
        const revenueCovered = round2(r?.revenue_covered);
        const coverage = revenueCovered / revenueTotalPdv;
        const source: StoreCmvBreakdown["source"] =
          coverage <= 0 ? "estimate" : coverage >= 0.999 ? "real" : "blended";
        out.set(String(r.store_id), {
          source,
          coverage: Math.round(coverage * 10000) / 10000,
          cmvReal: round2(r?.cogs),
          revenueCovered,
          revenueTotalPdv,
        });
      }
    } catch {
      /* devolve o que tiver (mapa possivelmente vazio) */
    }
    return out;
  }

  /** Faturamento do mês de TODAS as lojas, agregado por store_id (PERF-003). */
  static monthlyRevenueAll(orgId: string, period: string): Map<string, number> {
    const out = new Map<string, number>();
    try {
      const rows = db
        .prepare(
          `SELECT store_id, COALESCE(SUM(${VALUE_EXPR}), 0) AS s
             FROM retail_daily_closings
            WHERE organization_id = ? AND status != 'rejected'
              AND strftime('%Y-%m', closing_date) = ?
            GROUP BY store_id`
        )
        .all(orgId, period) as any[];
      for (const r of rows) out.set(String(r.store_id), round2(r.s));
    } catch { /* mapa vazio */ }
    return out;
  }

  /**
   * Nº de vendas do mês de TODAS as lojas, agregado por store_id (PERF-003).
   * Mesma régua do `monthlySalesCount`: prefere o grão de ticket do PDV; cai
   * pros fechamentos aprovados; ausência das duas → sem entrada no mapa (o
   * caller trata como `null`, não como 0).
   */
  static monthlySalesCountAll(orgId: string, period: string): Map<string, number> {
    const out = new Map<string, number>();
    try {
      const pdv = db
        .prepare(
          `SELECT st.id AS store_id, COUNT(*) AS c
             FROM retail_pdv_sales s
             JOIN retail_stores st ON st.organization_id = s.organization_id
                                  AND st.code = s.filial AND st.active = 1
            WHERE s.organization_id = ? AND substr(s.sale_date, 1, 7) = ?
            GROUP BY st.id`
        )
        .all(orgId, period) as any[];
      for (const r of pdv) { const c = Number(r.c) || 0; if (c > 0) out.set(String(r.store_id), c); }
    } catch { /* segue pro fallback */ }
    try {
      const closings = db
        .prepare(
          `SELECT store_id, COUNT(*) AS c FROM retail_daily_closings
            WHERE organization_id = ? AND status != 'rejected'
              AND strftime('%Y-%m', closing_date) = ?
            GROUP BY store_id`
        )
        .all(orgId, period) as any[];
      for (const r of closings) {
        const id = String(r.store_id);
        if (out.has(id)) continue; // PDV tem precedência
        const c = Number(r.c) || 0;
        if (c > 0) out.set(id, c);
      }
    } catch { /* mapa como está */ }
    return out;
  }

  /** Custos FIXOS de TODAS as lojas, por store_id (PERF-003). */
  static listAll(orgId: string): Map<string, StoreCosts> {
    const out = new Map<string, StoreCosts>();
    try {
      const rows = db
        .prepare(`SELECT store_id, category, amount FROM retail_store_fixed_costs WHERE organization_id = ?`)
        .all(orgId) as any[];
      for (const r of rows) {
        const id = String(r.store_id);
        let sc = out.get(id);
        if (!sc) { sc = emptyStoreCosts(); out.set(id, sc); }
        const amount = round2(r.amount);
        if (CATEGORY_KEYS.has(r.category)) sc.byCategory[r.category] = amount;
        sc.total = round2(sc.total + amount);
      }
    } catch { /* mapa vazio */ }
    return out;
  }

  /** Custos VARIÁVEIS de TODAS as lojas, por store_id (PERF-003). */
  static listVariableAll(orgId: string): Map<string, StoreVariableCosts> {
    const out = new Map<string, StoreVariableCosts>();
    try {
      const rows = db
        .prepare(
          `SELECT store_id, category, percent, fixed_per_sale
             FROM retail_store_variable_costs WHERE organization_id = ?`
        )
        .all(orgId) as any[];
      for (const r of rows) {
        if (!VAR_CATEGORY_KEYS.has(r.category)) continue;
        const id = String(r.store_id);
        let vc = out.get(id);
        if (!vc) { vc = emptyStoreVariableCosts(); out.set(id, vc); }
        const p = round2(r.percent);
        const f = round2(r.fixed_per_sale);
        vc.byCategory[r.category] = { percent: p, fixedPerSale: f };
        vc.totalPercent = round2(vc.totalPercent + p);
        vc.totalFixedPerSale = round2(vc.totalFixedPerSale + f);
      }
    } catch { /* mapa vazio */ }
    return out;
  }

  /** Resultado gerencial + ponto de equilíbrio da loja no mês. */
  static storeResult(
    orgId: string,
    storeId: string,
    period = new Date().toISOString().slice(0, 7)
  ): StoreResult | null {
    const store = RetailStoreService.get(orgId, storeId);
    if (!store) return null;
    // Insumos por-loja (uma consulta cada). O `allStoresResult` (PERF-003)
    // computa esses mesmos insumos em LOTE (agregados por store_id) e chama
    // `assembleStoreResult` direto — a montagem abaixo é a MESMA, sem N+1.
    return this.assembleStoreResult(store, period, {
      faturamento: this.monthlyRevenue(orgId, storeId, period),
      vendasCount: this.monthlySalesCount(orgId, storeId, period),
      custosFixos: this.list(orgId, storeId),
      custosVariaveis: this.listVariable(orgId, storeId),
      cmvBd: this.monthlyCogsBreakdown(orgId, storeId, period),
    });
  }

  /**
   * Montagem PURA do resultado gerencial a partir dos insumos já computados
   * (faturamento, contagem, custos fixos/variáveis, CMV). Sem consulta ao DB —
   * é o que permite o caminho set-based (allStoresResult) reusar a MESMA regra
   * de cálculo sem repetir queries por loja (PERF-003).
   */
  static assembleStoreResult(
    store: any,
    period: string,
    inputs: {
      faturamento: number;
      vendasCount: number | null;
      custosFixos: StoreCosts;
      custosVariaveis: StoreVariableCosts;
      cmvBd: StoreCmvBreakdown;
    }
  ): StoreResult {
    const { faturamento, vendasCount, custosFixos, custosVariaveis, cmvBd } = inputs;
    const storeId = store.id;
    const marginPct: number | null =
      store.gross_margin_percent === null || store.gross_margin_percent === undefined
        ? null
        : Number(store.gross_margin_percent);
    const hasMargin = marginPct !== null && marginPct > 0;

    // Custo variável total do mês: parte proporcional (% do faturamento) +
    // parte por ticket (R$ × nº vendas). A parte por ticket só entra quando
    // temos contagem de vendas — senão, ignoramos e avisamos.
    const varProportional = round2(
      faturamento * (custosVariaveis.totalPercent / 100)
    );
    const canApplyFixedPerSale =
      vendasCount !== null && custosVariaveis.totalFixedPerSale > 0;
    const varPerTicket = canApplyFixedPerSale
      ? round2((vendasCount as number) * custosVariaveis.totalFixedPerSale)
      : 0;
    const custoVariavelTotal = round2(varProportional + varPerTicket);
    const variableCostsWarning =
      custosVariaveis.totalFixedPerSale > 0 && vendasCount === null
        ? "Sem contagem de vendas no mês — a parte fixa por ticket dos custos variáveis foi ignorada."
        : null;

    // CMV: prioriza o REAL (via avg_cost dos itens PDV do mês). Onde não há
    // avg_cost cadastrado (produto que nunca entrou por NF-e), cai no fallback
    // proporcional pelo `gross_margin_percent`. Sem margem cadastrada, o
    // fallback não roda — se coverage < 100% e não há margem, o CMV real
    // parcial não vira estimativa (guardrail). `cmvBd` vem dos insumos.
    let cmvUsado: number | null = null;
    let cmvBreakdown: StoreCmvBreakdown | null = null;
    let cmvWarning: string | null = null;
    let margemBruta: number | null = null;

    const hasPdvItens = cmvBd.revenueTotalPdv > 0;
    if (hasPdvItens && cmvBd.source === "real") {
      // 100% via avg_cost — a margem bruta é (faturamento − CMV real).
      // Se o CMV total do PDV não cobre o faturamento oficial (ex.: houve
      // fechamento manual sem item detalhado), extrapolamos o CMV/receita
      // do PDV pro faturamento total (regra de três) — melhor que ignorar
      // a parte fora do PDV.
      const ratio = cmvBd.revenueTotalPdv > 0 ? cmvBd.cmvReal / cmvBd.revenueTotalPdv : 0;
      cmvUsado = round2(faturamento * ratio);
      cmvBreakdown = cmvBd;
      margemBruta = round2(faturamento - cmvUsado);
    } else if (hasPdvItens && cmvBd.source === "blended" && hasMargin) {
      // Blended: parte real (itens cobertos) + parte estimada (itens sem
      // avg_cost, aplica gross_margin_percent) + parte fora do PDV (aplica
      // gross_margin_percent também). A margem bruta sai do faturamento − CMV.
      const uncoveredPdv = round2(cmvBd.revenueTotalPdv - cmvBd.revenueCovered);
      const outsidePdv = round2(Math.max(0, faturamento - cmvBd.revenueTotalPdv));
      const cmvEstimateTail =
        (uncoveredPdv + outsidePdv) * (1 - (marginPct as number) / 100);
      cmvUsado = round2(cmvBd.cmvReal + cmvEstimateTail);
      cmvBreakdown = cmvBd;
      margemBruta = round2(faturamento - cmvUsado);
      cmvWarning = `Só ${Math.round(cmvBd.coverage * 100)}% do faturamento PDV tem custo de aquisição cadastrado — o resto usa a margem estimada.`;
    } else if (hasMargin) {
      // Fallback puro: estima CMV pela margem bruta informada.
      margemBruta = round2(faturamento * (marginPct as number) / 100);
      cmvUsado = round2(faturamento - margemBruta);
      cmvBreakdown = hasPdvItens ? cmvBd : null;
      if (hasPdvItens && cmvBd.source === "blended") {
        cmvWarning = `Só ${Math.round(cmvBd.coverage * 100)}% do faturamento PDV tem custo de aquisição cadastrado — usando a margem estimada em 100%.`;
      }
    }
    // Caso hasMargin=false e não há CMV real utilizável: margemBruta/cmv ficam null
    // (guardrail já existente do PR anterior).

    const margemContribuicao =
      margemBruta !== null ? round2(margemBruta - custoVariavelTotal) : null;
    const margemContribuicaoPercent =
      margemContribuicao !== null && faturamento > 0
        ? round2((margemContribuicao / faturamento) * 100)
        : null;
    const resultado =
      margemContribuicao !== null
        ? round2(margemContribuicao - custosFixos.total)
        : null;
    // Ponto de equilíbrio = custos fixos ÷ MC% efetiva. Sem MC% positiva, PE
    // não faz sentido (empresa não empata pelo próprio faturamento).
    const pontoEquilibrio =
      margemContribuicaoPercent !== null && margemContribuicaoPercent > 0
        ? round2(custosFixos.total / (margemContribuicaoPercent / 100))
        : null;
    const progressoEquilibrio =
      pontoEquilibrio && pontoEquilibrio > 0 ? round2(faturamento / pontoEquilibrio) : null;

    return {
      storeId,
      storeName: store.name,
      period,
      faturamento,
      vendasCount,
      custosFixos,
      custosVariaveis,
      custoVariavelTotal: margemBruta !== null ? custoVariavelTotal : null,
      grossMarginPercent: marginPct,
      cmv: cmvUsado,
      cmvBreakdown,
      margemBruta,
      margemContribuicao,
      margemContribuicaoPercent,
      resultado,
      pontoEquilibrio,
      progressoEquilibrio,
      hasMargin,
      hasCustos: custosFixos.total > 0,
      variableCostsWarning,
      cmvWarning,
      disclaimer: DISCLAIMER,
    };
  }

  /**
   * Resultado de TODAS as lojas ativas no mês + totais da rede.
   *
   * PERF-003: em vez de chamar `storeResult` por loja (N+1 — ~5 consultas ×
   * N lojas), computa os insumos (faturamento, contagem, custos fixos/variáveis,
   * CMV) em LOTE — agregados por store_id numa consulta cada — e monta cada loja
   * com a MESMA regra (`assembleStoreResult`, pura). Resultado idêntico, sem N+1.
   */
  static allStoresResult(orgId: string, period = new Date().toISOString().slice(0, 7)) {
    const stores = RetailStoreService.list(orgId).filter((s: any) => s.active === 1 || s.active === true);
    // Insumos em lote (5 consultas fixas, não 5×N).
    const revenueAll = this.monthlyRevenueAll(orgId, period);
    const salesCountAll = this.monthlySalesCountAll(orgId, period);
    const fixedAll = this.listAll(orgId);
    const variableAll = this.listVariableAll(orgId);
    const cmvAll = this.monthlyCogsBreakdownAll(orgId, period);
    const perStore = stores.map((s: any) =>
      this.assembleStoreResult(s, period, {
        faturamento: revenueAll.get(s.id) || 0,
        vendasCount: salesCountAll.has(s.id) ? (salesCountAll.get(s.id) as number) : null,
        custosFixos: fixedAll.get(s.id) || emptyStoreCosts(),
        custosVariaveis: variableAll.get(s.id) || emptyStoreVariableCosts(),
        cmvBd: cmvAll.get(s.id) || EMPTY_CMV(),
      })
    );
    const totals = perStore.reduce(
      (a, r) => {
        a.faturamento += r.faturamento;
        a.custosFixos += r.custosFixos.total;
        if (r.custoVariavelTotal !== null) a.custosVariaveis += r.custoVariavelTotal;
        if (r.resultado !== null) a.resultado += r.resultado;
        return a;
      },
      { faturamento: 0, custosFixos: 0, custosVariaveis: 0, resultado: 0 }
    );
    return {
      period,
      perStore,
      totals: {
        faturamento: round2(totals.faturamento),
        custosFixos: round2(totals.custosFixos),
        custosVariaveis: round2(totals.custosVariaveis),
        resultado: round2(totals.resultado),
      },
      categories: FIXED_COST_CATEGORIES,
      variableCategories: VARIABLE_COST_CATEGORIES,
      disclaimer: DISCLAIMER,
    };
  }
}

export default RetailStoreCostService;
