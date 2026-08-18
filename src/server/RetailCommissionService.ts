/**
 * Retail Ops — Premiação/Comissão (ADR-083, Fase G).
 *
 * Regras por loja/global e uma apuração (run) que gera uma PRÉVIA (draft) a
 * partir dos fechamentos do período. A aprovação é sempre HUMANA (D7): a IA/
 * sistema nunca paga sozinho — gera a prévia, permite comparar com a premiação
 * informada manualmente (divergência) e só o gestor aprova. Isolado por org.
 *
 * Base de cálculo = realizado do período (soma dos `informed_total` dos
 * fechamentos da loja no intervalo). Cota do período = soma das cotas diárias.
 */
import { randomUUID } from "node:crypto";
import db from "./db.js";
import { logAuthEvent } from "./auditLog.js";
import { RetailSellerSalesService } from "./RetailSellerSalesService.js";
import { RetailErpSellerSalesService } from "./RetailErpSellerSalesService.js";

export type CommissionRuleInput = {
  name: string;
  scope?: "store" | "seller" | "product" | "global";
  period?: "daily" | "weekly" | "monthly";
  calculationType: "percent_sales" | "quota_bonus" | "tiered" | "fixed";
  config: any;
  active?: boolean;
  /** Só vale p/ scope='store': mira UMA loja específica (percentual próprio da
   * Loja X, diferente da Loja Y). Ausente/null = vale pra rede toda (default). */
  storeId?: string | null;
};

function safeParse(s: any): any { try { return JSON.parse(s ?? "null"); } catch { return null; } }
const round2 = (n: any) => Math.round((Number(n) || 0) * 100) / 100;

/** Aplica um tipo de cálculo sobre a base (realizado) e a cota do período. */
export function computeCommission(calcType: string, config: any, base: number, quotaTotal: number): { amount: number; detail: any } {
  const c = config || {};
  switch (calcType) {
    case "percent_sales": {
      const pct = Number(c.percent || 0);
      return { amount: base * pct / 100, detail: { type: "percent_sales", percent: pct, base } };
    }
    case "fixed":
      return { amount: Number(c.amount || 0), detail: { type: "fixed", amount: Number(c.amount || 0) } };
    case "quota_bonus": {
      const hit = quotaTotal > 0 && base >= quotaTotal;
      return { amount: hit ? Number(c.bonus || 0) : 0, detail: { type: "quota_bonus", quotaTotal, base, hit, bonus: Number(c.bonus || 0) } };
    }
    case "tiered": {
      const tiers = (Array.isArray(c.tiers) ? c.tiers : []).slice().sort((a: any, b: any) => Number(a.min || 0) - Number(b.min || 0));
      let chosen: any = null;
      for (const t of tiers) if (base >= Number(t.min || 0)) chosen = t;
      const pct = chosen ? Number(chosen.percent || 0) : 0;
      return { amount: base * pct / 100, detail: { type: "tiered", base, tierMin: chosen?.min ?? null, percent: pct } };
    }
    default:
      return { amount: 0, detail: { type: calcType, note: "tipo desconhecido" } };
  }
}

export class RetailCommissionService {
  // ── Regras ─────────────────────────────────────────────────────────────────
  static createRule(orgId: string, input: CommissionRuleInput, actorId?: string): any {
    const id = randomUUID();
    // storeId só faz sentido pra regra de escopo 'store' (mira UMA loja); em
    // qualquer outro escopo é ignorado (evita configuração sem efeito).
    const storeId = input.scope === "store" && input.storeId ? String(input.storeId) : null;
    db.prepare(
      `INSERT INTO retail_commission_rules (id, organization_id, name, scope, period, calculation_type, config_json, active, store_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, orgId, String(input.name || "Regra"), input.scope || "store", input.period || "monthly", input.calculationType, JSON.stringify(input.config || {}), input.active === false ? 0 : 1, storeId);
    try { logAuthEvent(orgId, actorId || "system", id, "RETAIL_COMMISSION_RULE_CREATED", { calc: input.calculationType, storeId }); } catch { /* noop */ }
    return db.prepare(`SELECT * FROM retail_commission_rules WHERE id = ?`).get(id);
  }

  /**
   * Regras efetivas de escopo LOJA para uma loja específica: se existir uma
   * regra que MIRA essa loja (`store_id` = a loja), ela tem precedência e as
   * regras de rede (`store_id` NULL) NÃO se aplicam a essa loja (evita pagar a
   * mesma verba duas vezes); sem regra específica, cai nas regras de rede.
   */
  private static effectiveStoreRules(storeId: string, storeRules: any[]): any[] {
    const specific = storeRules.filter((r) => r.store_id === storeId);
    return specific.length ? specific : storeRules.filter((r) => !r.store_id);
  }

  static listRules(orgId: string): any[] {
    return db.prepare(`SELECT * FROM retail_commission_rules WHERE organization_id = ? ORDER BY created_at DESC`).all(orgId) as any[];
  }

  static setRuleActive(orgId: string, id: string, active: boolean, actorId?: string): any | null {
    const r = db.prepare(`SELECT * FROM retail_commission_rules WHERE organization_id = ? AND id = ?`).get(orgId, id) as any;
    if (!r) return null;
    db.prepare(`UPDATE retail_commission_rules SET active = ? WHERE organization_id = ? AND id = ?`).run(active ? 1 : 0, orgId, id);
    return db.prepare(`SELECT * FROM retail_commission_rules WHERE id = ?`).get(id);
  }

  // ── Bases do período ────────────────────────────────────────────────────────
  private static periodSales(orgId: string, storeId: string | null, start: string, end: string): number {
    const q = storeId
      ? db.prepare(`SELECT COALESCE(SUM(informed_total),0) AS s FROM retail_daily_closings WHERE organization_id = ? AND store_id = ? AND closing_date BETWEEN ? AND ? AND status != 'rejected'`).get(orgId, storeId, start, end)
      : db.prepare(`SELECT COALESCE(SUM(informed_total),0) AS s FROM retail_daily_closings WHERE organization_id = ? AND closing_date BETWEEN ? AND ? AND status != 'rejected'`).get(orgId, start, end);
    return Number((q as any)?.s || 0);
  }
  private static periodQuota(orgId: string, storeId: string | null, start: string, end: string): number {
    const q = storeId
      ? db.prepare(`SELECT COALESCE(SUM(quota_amount),0) AS s FROM retail_store_quotas WHERE organization_id = ? AND store_id = ? AND quota_date BETWEEN ? AND ?`).get(orgId, storeId, start, end)
      : db.prepare(`SELECT COALESCE(SUM(quota_amount),0) AS s FROM retail_store_quotas WHERE organization_id = ? AND quota_date BETWEEN ? AND ?`).get(orgId, start, end);
    return Number((q as any)?.s || 0);
  }

  // Vendas do ZappFlow (orders faturados) por VENDEDOR e por PRODUTO — base das
  // comissões por vendedor/produto (as vendas do PDV físico só têm total/loja).
  private static readonly FULFILLED = "('pago','em_preparo','entregue','concluido')";

  /** Vendas faturadas por vendedor no período (só pedidos com seller_user_id). */
  static onlineSalesBySeller(orgId: string, start: string, end: string): Array<{ sellerUserId: string; sellerName: string; sales: number; orders: number }> {
    const rows = db.prepare(
      `SELECT o.seller_user_id AS sid, COALESCE(SUM(o.total_amount),0) AS s, COUNT(*) AS n
         FROM orders o
        WHERE o.organization_id = ? AND o.seller_user_id IS NOT NULL
          AND o.status IN ${this.FULFILLED} AND date(o.created_at) BETWEEN ? AND ?
        GROUP BY o.seller_user_id`
    ).all(orgId, start, end) as any[];
    return rows.map((r) => ({ sellerUserId: String(r.sid), sellerName: this.sellerName(orgId, String(r.sid)), sales: Number(r.s) || 0, orders: Number(r.n) || 0 }));
  }

  /**
   * Vendas por VENDEDOR combinando as três fontes: ZappFlow (pedidos com
   * vendedor), lançamentos manuais/foto do Cenário B (retail_seller_sales) e o
   * ERP do Cenário A (retail_erp_seller_sales). Consolida por vendedor (userId
   * quando houver, senão nome) somando o valor vendido — é a base da comissão por
   * vendedor. Do ERP guarda também a `erpCommission` (comissão já calculada lá),
   * para conferir divergência contra a nossa apuração. `source` lista as fontes
   * que contribuíram (ex.: zappflow+manual, erp, manual+erp).
   */
  static combinedSalesBySeller(orgId: string, start: string, end: string): Array<{ sellerUserId: string | null; sellerName: string; matricula: string | null; sales: number; pecas: number; orders: number; erpCommission: number; source: string; pendingIdentity: boolean }> {
    const norm = (name: string) => String(name || "").trim().toLowerCase();
    const map = new Map<string, { sellerUserId: string | null; sellerName: string; matricula: string | null; sales: number; pecas: number; orders: number; erpCommission: number; sources: Set<string> }>();
    // name normalizado → chave, p/ reconciliar lançamentos manuais/ERP (que
    // trazem só o nome) com o vendedor do ZappFlow (que tem userId) de mesmo nome.
    const nameToKey = new Map<string, string>();
    const add = (userId: string | null, name: string, sales: number, pecas: number, orders: number, source: string, erpCommission = 0, matricula: string | null = null) => {
      const n = norm(name);
      const k = (userId && `user:${userId}`) || nameToKey.get(n) || `nom:${n}`;
      const cur = map.get(k) || { sellerUserId: userId || null, sellerName: name, matricula: null, sales: 0, pecas: 0, orders: 0, erpCommission: 0, sources: new Set<string>() };
      cur.sales = round2(cur.sales + (Number(sales) || 0));
      cur.pecas += Number(pecas) || 0;
      cur.orders += Number(orders) || 0;
      cur.erpCommission = round2(cur.erpCommission + (Number(erpCommission) || 0));
      if (userId && !cur.sellerUserId) cur.sellerUserId = userId;
      if (matricula && !cur.matricula) cur.matricula = matricula;
      cur.sources.add(source);
      map.set(k, cur);
      if (n && !nameToKey.has(n)) nameToKey.set(n, k);
    };
    // ZappFlow primeiro: registra os nomes p/ o manual/ERP cair na mesma chave.
    for (const s of this.onlineSalesBySeller(orgId, start, end)) add(s.sellerUserId, s.sellerName, s.sales, 0, s.orders, "zappflow");
    for (const s of RetailSellerSalesService.bySeller(orgId, start, end)) add(s.sellerUserId, s.sellerName, s.sales, s.pecas, s.orders, "manual");
    for (const s of RetailErpSellerSalesService.bySeller(orgId, start, end)) add(s.sellerUserId, s.sellerName, s.sales, s.pecas, s.orders, "erp", s.erpCommission);
    // PDV físico por VENDEDOR (VendaMalote → CAI_USUARIO/`vendedor_codigo`): é a
    // base real da comissão por vendedor da rede. Entra por último; casa por
    // userId/nome com as demais fontes quando for a mesma pessoa.
    for (const s of this.pdvSalesBySeller(orgId, start, end)) add(s.sellerUserId, s.sellerName, s.sales, s.pecas, s.orders, "pdv", 0, s.matricula);
    return Array.from(map.values())
      .map((v) => ({
        sellerUserId: v.sellerUserId, sellerName: v.sellerName, matricula: v.matricula,
        sales: v.sales, pecas: v.pecas, orders: v.orders, erpCommission: v.erpCommission,
        source: Array.from(v.sources).sort().join("+"),
        // SELL-007: matrícula sem nome (e sem usuário ZappFlow) = pendência
        // acionável — não é resultado final silencioso.
        pendingIdentity: !v.sellerUserId && /^Matrícula\s/.test(String(v.sellerName || "")),
      }))
      .sort((a, b) => b.sales - a.sales);
  }

  /** Vendas faturadas por produto no período (itens dos pedidos faturados). */
  static onlineSalesByProduct(orgId: string, start: string, end: string): Array<{ productId: string; productName: string; sales: number; orders: number }> {
    const rows = db.prepare(
      `SELECT i.product_service_id AS pid, COALESCE(SUM(i.line_total),0) AS s, COUNT(DISTINCT o.id) AS n, MAX(i.name_snapshot) AS nm
         FROM order_items i JOIN orders o ON o.id = i.order_id
        WHERE i.organization_id = ? AND i.product_service_id IS NOT NULL
          AND o.status IN ${this.FULFILLED} AND date(o.created_at) BETWEEN ? AND ?
        GROUP BY i.product_service_id`
    ).all(orgId, start, end) as any[];
    return rows.map((r) => ({ productId: String(r.pid), productName: this.productName(orgId, String(r.pid)) || String(r.nm || "produto"), sales: Number(r.s) || 0, orders: Number(r.n) || 0 }));
  }

  /**
   * RELATÓRIO do período (só leitura, não persiste): comissão consolidada por
   * VENDEDOR, por PRODUTO e por LOJA, aplicando as regras ATIVAS. Serve para o
   * gestor ver quanto cada um recebe antes de aprovar a apuração.
   */
  static report(orgId: string, start: string, end: string): any {
    const rules = db.prepare(`SELECT * FROM retail_commission_rules WHERE organization_id = ? AND active = 1`).all(orgId) as any[];
    const byScope = (sc: string) => rules.filter((r) => r.scope === sc);
    const commissionOf = (ruleList: any[], base: number, quota: number) =>
      round2(ruleList.reduce((acc, r) => {
        const cfg = safeParse(r.config_json) || {};
        const q = r.scope === "seller" || r.scope === "product" ? Number(cfg.quota || 0) : quota;
        return acc + computeCommission(r.calculation_type, cfg, base, q).amount;
      }, 0));

    const sellerRules = byScope("seller"), productRules = byScope("product"), storeRules = byScope("store"), globalRules = byScope("global");

    // Por vendedor = ZappFlow (pedidos com vendedor) + lançamentos manuais/foto +
    // ERP + PDV físico (VendaMalote → CAI_USUARIO). Quando NÃO há regra própria por
    // vendedor, a comissão por vendedor sai da % EFETIVA DA LOJA onde cada venda
    // aconteceu (loja específica > rede > global) — não uma % plana, que ficaria
    // errada quando as lojas pagam percentuais diferentes: assim o gestor que só
    // criou regra(s) "por loja" ainda vê a comissão individualizada por vendedor
    // sobre o que cada um vendeu — que é o que "individualizar por vendedor" e
    // "o percentual definido pelo dono de cada loja" significam juntos.
    const fbRule = sellerRules.length ? null : this.sellerFallbackRule(orgId);
    const fbPct = fbRule ? Number(safeParse(fbRule.config_json)?.percent || 0) : 0;
    const fb = sellerRules.length ? null : this.sellerFallbackCommission(orgId, start, end);
    const hasStoreSpecificRules = storeRules.some((r) => r.store_id);
    const bySeller = this.combinedSalesBySeller(orgId, start, end).map((s) => ({
      ...s,
      commission: sellerRules.length
        ? commissionOf(sellerRules, s.sales, 0)
        : round2(fb?.bySellerKey.get(this.sellerMatchKey(s.sellerUserId, s.sellerName)) || 0),
    }));
    const byProduct = this.onlineSalesByProduct(orgId, start, end).map((p) => ({ ...p, commission: commissionOf(productRules, p.sales, 0) }));

    const stores = db.prepare(`SELECT id, name FROM retail_stores WHERE organization_id = ? AND active = 1`).all(orgId) as any[];
    const byStore = stores.map((s) => {
      const base = this.periodSales(orgId, s.id, start, end);
      const effRules = this.effectiveStoreRules(s.id, storeRules);
      const commission = commissionOf(effRules, base, this.periodQuota(orgId, s.id, start, end));
      return { storeId: s.id, storeName: s.name, sales: round2(base), commission };
    });

    const globalBase = this.periodSales(orgId, null, start, end);
    const globalCommission = globalRules.length ? commissionOf(globalRules, globalBase, this.periodQuota(orgId, null, start, end)) : 0;

    const sum = (arr: any[], k: string) => round2(arr.reduce((a, x) => a + Number(x[k] || 0), 0));
    const sellerCommission = sum(bySeller, "commission");
    const productCommission = sum(byProduct, "commission");
    const storeCommission = round2(sum(byStore, "commission") + globalCommission);
    // Fallback ativo: a comissão por vendedor saiu da MESMA verba da(s) regra(s)
    // de loja/global (só que respeitando o % de CADA loja), então a linha "por
    // loja" é só REFERÊNCIA e NÃO soma no total (senão pagaria a comissão duas
    // vezes). Com regra própria por vendedor, as duas são distintas e somam.
    const storeIsReference = !!fb?.anyPercent && sellerCommission > 0;
    const totalCommission = round2(sellerCommission + productCommission + (storeIsReference ? 0 : storeCommission));
    return {
      period: { start, end },
      bySeller, byProduct, byStore, globalCommission,
      // SELL-007: quantos vendedores estão como "Matrícula X" (identidade
      // pendente) — o gestor resolve antes de confiar na apuração.
      pendingIdentityCount: bySeller.filter((s: any) => s.pendingIdentity).length,
      totals: { sellerCommission, productCommission, storeCommission, totalCommission, sellerErpCommission: sum(bySeller, "erpCommission") },
      hasRules: { seller: sellerRules.length > 0, product: productRules.length > 0, store: storeRules.length > 0, global: globalRules.length > 0 },
      // "store_fallback_mixed": há lojas com % PRÓPRIO diferente da rede — não dá
      // pra mostrar um único percentual representativo (cada loja tem o seu).
      sellerCommissionSource: sellerRules.length ? "seller_rule" : (fb?.anyPercent ? (hasStoreSpecificRules ? "store_fallback_mixed" : "store_fallback") : null),
      sellerCommissionPercent: sellerRules.length || hasStoreSpecificRules ? null : (fbPct || null),
      storeIsReference,
      hasErpSellerSales: bySeller.some((s: any) => Number(s.erpCommission) > 0 || String(s.source || "").includes("erp")),
    };
  }

  /**
   * Regra percentual ativa usada como FALLBACK da comissão por vendedor quando o
   * gestor não criou uma regra de escopo "vendedor": pega a regra `percent_sales`
   * de loja (ou, na falta, global) — a mesma preferência de /pdv-sellers. Retorna
   * a linha da regra (ou null) para reaproveitar id/percentual na apuração.
   */
  private static sellerFallbackRule(orgId: string): any | null {
    try {
      // Prefere a regra de loja de REDE (store_id NULL) — representa a rede
      // toda; só cai numa regra de loja ESPECÍFICA (% de uma única loja) na
      // falta de uma de rede, o que é uma estimativa, não o valor exato por
      // vendedor (esse é o job de `storeSellerExtract`, que respeita a loja
      // de cada vendedor).
      return db.prepare(
        `SELECT * FROM retail_commission_rules
          WHERE organization_id = ? AND active = 1 AND calculation_type = 'percent_sales' AND scope IN ('store','global')
          ORDER BY CASE WHEN scope = 'store' AND store_id IS NULL THEN 0 WHEN scope = 'store' THEN 1 ELSE 2 END, created_at DESC LIMIT 1`
      ).get(orgId) || null;
    } catch { return null; }
  }

  /** Chave p/ reconciliar `combinedSalesBySeller` (sem loja/matrícula) com
   * `salesBySellerStore` (com loja): userId quando houver, senão NOME
   * normalizado — a mesma convenção que `combinedSalesBySeller.add()` usa, já
   * que "Matrícula X" (nome de fallback) sai idêntico dos dois lados. */
  private static sellerMatchKey(userId: string | null, name: string): string {
    return userId ? `user:${userId}` : `nom:${String(name || "").trim().toLowerCase()}`;
  }

  /**
   * Comissão por VENDEDOR usada como FALLBACK (sem regra própria de escopo
   * "vendedor"): ao invés de aplicar uma % PLANA pra todo mundo (o que fica
   * ERRADO quando as lojas têm percentuais diferentes — ex.: Loja X 7%, Loja Y
   * 5%), soma por vendedor a comissão calculada com a % EFETIVA da loja onde
   * cada venda aconteceu (loja específica > rede > global). `anyPercent`
   * indica se alguma regra percentual se aplicou (gate do fallback).
   */
  private static sellerFallbackCommission(orgId: string, start: string, end: string): { bySellerKey: Map<string, number>; anyPercent: boolean } {
    const rules = db.prepare(`SELECT * FROM retail_commission_rules WHERE organization_id = ? AND active = 1`).all(orgId) as any[];
    const storeRules = rules.filter((r) => r.scope === "store");
    const globalRules = rules.filter((r) => r.scope === "global");
    const bySellerKey = new Map<string, number>();
    let anyPercent = false;
    for (const row of this.salesBySellerStore(orgId, start, end)) {
      const eff = row.storeId ? this.effectiveStoreRules(row.storeId, storeRules) : storeRules.filter((r) => !r.store_id);
      const rulesToUse = eff.length ? eff : globalRules;
      if (rulesToUse.some((r) => r.calculation_type === "percent_sales")) anyPercent = true;
      const commission = round2(rulesToUse.reduce((acc, r) => {
        const cfg = safeParse(r.config_json) || {};
        return acc + computeCommission(r.calculation_type, cfg, row.sales, 0).amount;
      }, 0));
      const key = this.sellerMatchKey(row.sellerUserId, row.sellerName);
      bySellerKey.set(key, round2((bySellerKey.get(key) || 0) + commission));
    }
    return { bySellerKey, anyPercent };
  }

  /**
   * Vendas do PDV por VENDEDOR — nome vem do mapeamento retail_sellers.
   *
   * Homologação Toulon (ADR-105): o vendedor da comissão é o CAI_USUARIO
   * (`vendedor_codigo`), NÃO a matrícula do operador de caixa (`vendedor`). Usa o
   * código do vendedor quando presente e cai no operador só quando ausente
   * (retrocompatível: bases antigas sem `vendedor_codigo` mantêm o comportamento).
   */
  static pdvSalesBySeller(orgId: string, start: string, end: string): Array<{ sellerUserId: string | null; sellerName: string; matricula: string; sales: number; pecas: number; orders: number; source: string }> {
    try {
      // Loja com seller_source='manual' (Toulon): o CAI_USUARIO dessa loja não
      // individualiza vendedor de verdade (código único/compartilhado) — o
      // gestor decidiu que a fonte de verdade por vendedor é o lançamento
      // manual/foto (retail_seller_sales), então o PDV dela FICA DE FORA daqui
      // (senão a mesma venda entraria duas vezes: uma pelo PDV genérico, outra
      // pelo lançamento manual real). Loja sem loja resolvida (filial não
      // casada) nunca é excluída — sem saber a loja, não dá pra decidir.
      const rows = db.prepare(
        `SELECT COALESCE(NULLIF(s.vendedor_codigo, ''), s.vendedor) AS matricula, rs.name AS mapped_name, rs.user_id AS user_id,
                SUM(s.valor) AS sales, COALESCE(SUM(s.pecas), 0) AS pecas, COUNT(*) AS orders
           FROM retail_pdv_sales s
           LEFT JOIN retail_sellers rs ON rs.organization_id = s.organization_id AND rs.matricula = COALESCE(NULLIF(s.vendedor_codigo, ''), s.vendedor)
           LEFT JOIN retail_stores st ON st.organization_id = s.organization_id AND st.code = s.filial AND st.active = 1
          WHERE s.organization_id = ? AND s.sale_date BETWEEN ? AND ?
            AND COALESCE(s.status, 'N') <> 'C' AND COALESCE(NULLIF(s.vendedor_codigo, ''), s.vendedor, '') <> ''
            AND COALESCE(st.seller_source, 'pdv') <> 'manual'
          GROUP BY COALESCE(NULLIF(s.vendedor_codigo, ''), s.vendedor) ORDER BY sales DESC`
      ).all(orgId, start, end) as any[];
      return rows.map((r) => ({
        sellerUserId: r.user_id || null,
        sellerName: r.mapped_name || `Matrícula ${r.matricula}`,
        matricula: String(r.matricula),
        sales: round2(Number(r.sales || 0)),
        pecas: Number(r.pecas || 0),
        orders: Number(r.orders || 0),
        source: "pdv",
      }));
    } catch { return []; }
  }

  /** Chave estável de um vendedor p/ filtrar/casar entre chamadas (userId > matrícula > nome). */
  private static sellerKeyOf(userId: string | null, matricula: string | null, name: string): string {
    if (userId) return `user:${userId}`;
    if (matricula) return `mat:${matricula}`;
    return `nom:${String(name || "").trim().toLowerCase()}`;
  }

  /**
   * Vendas por (LOJA, VENDEDOR) no período — funde as quatro fontes mantendo a
   * LOJA de cada venda: ZappFlow (orders.store_id), lançamentos manuais/foto
   * (retail_seller_sales.store_id), ERP (retail_erp_seller_sales.store_id) e o
   * PDV físico (retail_pdv_sales.filial → retail_stores.code). É a base para
   * "individualizar as equipes por loja": um vendedor que vendeu em duas lojas
   * aparece com uma linha PARA CADA loja (a comissão de cada uma usa a regra
   * efetiva daquela loja). Dedup por (loja + userId/matrícula/nome) dentro da
   * MESMA loja — não funde a mesma pessoa entre lojas diferentes.
   */
  static salesBySellerStore(orgId: string, start: string, end: string): Array<{ storeId: string | null; storeName: string; sellerUserId: string | null; sellerName: string; matricula: string | null; sales: number; pecas: number; orders: number; source: string }> {
    const norm = (name: string) => String(name || "").trim().toLowerCase();
    type Row = { storeId: string | null; storeName: string; sellerUserId: string | null; sellerName: string; matricula: string | null; sales: number; pecas: number; orders: number; sources: Set<string> };
    const map = new Map<string, Row>();
    const nameToKey = new Map<string, string>();

    const add = (storeId: string | null, storeName: string, userId: string | null, matricula: string | null, name: string, sales: number, pecas: number, orders: number, source: string) => {
      const storeKey = storeId || `semLoja:${norm(storeName)}`;
      const n = norm(name);
      const nk = `${storeKey}::${n}`;
      const k = (userId && `${storeKey}::user:${userId}`) || (matricula && `${storeKey}::mat:${matricula}`) || nameToKey.get(nk) || `${storeKey}::nom:${n}`;
      const cur = map.get(k) || { storeId, storeName, sellerUserId: userId || null, sellerName: name, matricula: matricula || null, sales: 0, pecas: 0, orders: 0, sources: new Set<string>() };
      cur.sales = round2(cur.sales + (Number(sales) || 0));
      cur.pecas += Number(pecas) || 0;
      cur.orders += Number(orders) || 0;
      if (userId && !cur.sellerUserId) cur.sellerUserId = userId;
      if (matricula && !cur.matricula) cur.matricula = matricula;
      cur.sources.add(source);
      map.set(k, cur);
      if (n && !nameToKey.has(nk)) nameToKey.set(nk, k);
    };

    const zf = db.prepare(
      `SELECT o.store_id AS store_id, COALESCE(st.name, 'Sem loja') AS store_name, o.seller_user_id AS sid,
              COALESCE(SUM(o.total_amount),0) AS s, COUNT(*) AS n
         FROM orders o
         LEFT JOIN retail_stores st ON st.id = o.store_id
        WHERE o.organization_id = ? AND o.seller_user_id IS NOT NULL
          AND o.status IN ${this.FULFILLED} AND date(o.created_at) BETWEEN ? AND ?
        GROUP BY o.store_id, o.seller_user_id`
    ).all(orgId, start, end) as any[];
    for (const r of zf) add(r.store_id || null, r.store_name, String(r.sid), null, this.sellerName(orgId, String(r.sid)), Number(r.s) || 0, 0, Number(r.n) || 0, "zappflow");

    const manual = db.prepare(
      `SELECT ss.store_id AS store_id, COALESCE(st.name, 'Sem loja') AS store_name, ss.seller_name, ss.matricula,
              rs.name AS mapped_name, rs.user_id AS user_id, SUM(ss.valor) AS s, SUM(ss.pecas) AS p, COUNT(*) AS n
         FROM retail_seller_sales ss
         LEFT JOIN retail_stores st ON st.id = ss.store_id
         LEFT JOIN retail_sellers rs ON rs.organization_id = ss.organization_id AND rs.matricula = ss.matricula
        WHERE ss.organization_id = ? AND ss.sale_date BETWEEN ? AND ?
        GROUP BY ss.store_id, COALESCE(NULLIF(ss.matricula, ''), LOWER(TRIM(ss.seller_name)))`
    ).all(orgId, start, end) as any[];
    for (const r of manual) add(r.store_id || null, r.store_name, r.user_id || null, r.matricula || null, r.mapped_name || r.seller_name, Number(r.s) || 0, Number(r.p) || 0, Number(r.n) || 0, "manual");

    const erp = db.prepare(
      `SELECT es.store_id AS store_id, COALESCE(st.name, 'Sem loja') AS store_name, es.matricula, es.seller_name,
              rs.name AS mapped_name, rs.user_id AS user_id, SUM(es.valor) AS s, SUM(es.pecas) AS p, COUNT(*) AS n
         FROM retail_erp_seller_sales es
         LEFT JOIN retail_stores st ON st.id = es.store_id
         LEFT JOIN retail_sellers rs ON rs.organization_id = es.organization_id AND rs.matricula = es.matricula
        WHERE es.organization_id = ? AND es.sale_date BETWEEN ? AND ?
        GROUP BY es.store_id, COALESCE(NULLIF(es.matricula, ''), LOWER(TRIM(es.seller_name)))`
    ).all(orgId, start, end) as any[];
    for (const r of erp) {
      const realMat = r.matricula && !String(r.matricula).startsWith("nome:") ? r.matricula : null;
      add(r.store_id || null, r.store_name, r.user_id || null, realMat, r.mapped_name || r.seller_name || (realMat ? `Matrícula ${realMat}` : "vendedor"), Number(r.s) || 0, Number(r.p) || 0, Number(r.n) || 0, "erp");
    }

    const pdv = db.prepare(
      `SELECT st.id AS store_id, COALESCE(st.name, 'Filial ' || s.filial) AS store_name,
              COALESCE(NULLIF(s.vendedor_codigo, ''), s.vendedor) AS matricula, rs.name AS mapped_name, rs.user_id AS user_id,
              SUM(s.valor) AS sv, SUM(s.pecas) AS p, COUNT(*) AS n
         FROM retail_pdv_sales s
         LEFT JOIN retail_stores st ON st.organization_id = s.organization_id AND st.code = s.filial AND st.active = 1
         LEFT JOIN retail_sellers rs ON rs.organization_id = s.organization_id AND rs.matricula = COALESCE(NULLIF(s.vendedor_codigo, ''), s.vendedor)
        WHERE s.organization_id = ? AND s.sale_date BETWEEN ? AND ?
          AND COALESCE(s.status, 'N') <> 'C' AND COALESCE(NULLIF(s.vendedor_codigo, ''), s.vendedor, '') <> ''
          AND COALESCE(st.seller_source, 'pdv') <> 'manual'
        GROUP BY st.id, s.filial, COALESCE(NULLIF(s.vendedor_codigo, ''), s.vendedor)`
    ).all(orgId, start, end) as any[];
    for (const r of pdv) add(r.store_id || null, r.store_name, r.user_id || null, String(r.matricula), r.mapped_name || `Matrícula ${r.matricula}`, Number(r.sv) || 0, Number(r.p) || 0, Number(r.n) || 0, "pdv");

    return Array.from(map.values())
      .map((v) => ({ storeId: v.storeId, storeName: v.storeName, sellerUserId: v.sellerUserId, sellerName: v.sellerName, matricula: v.matricula, sales: v.sales, pecas: v.pecas, orders: v.orders, source: Array.from(v.sources).sort().join("+") }))
      .sort((a, b) => a.storeName.localeCompare(b.storeName) || b.sales - a.sales);
  }

  /**
   * Extrato de comissão por LOJA e por VENDEDOR (comando do dono da rede):
   * escolhe uma loja (ou todas) e, opcionalmente, um vendedor específico, num
   * intervalo de datas QUALQUER — inclusive parcial dentro do mês (ex.: 1º ao
   * dia 15, pra saber quanto já acumulou antes do fechamento). Cada vendedor
   * recebe a comissão pela regra EFETIVA da loja onde vendeu (regra específica
   * daquela loja > regra de rede > regra global) — a menos que exista uma
   * regra própria de escopo "vendedor" (essa vale igual pra todo mundo).
   * Retorna a lista de vendedores (com loja, vendas, peças e comissão), os
   * totais por loja e o total geral do filtro aplicado.
   */
  static storeSellerExtract(orgId: string, start: string, end: string, opts?: { storeId?: string | null; sellerKey?: string | null }): any {
    const rules = db.prepare(`SELECT * FROM retail_commission_rules WHERE organization_id = ? AND active = 1`).all(orgId) as any[];
    const sellerRules = rules.filter((r) => r.scope === "seller");
    const storeRules = rules.filter((r) => r.scope === "store");
    const globalRules = rules.filter((r) => r.scope === "global");

    const applyRules = (ruleList: any[], base: number) =>
      round2(ruleList.reduce((acc, r) => {
        const cfg = safeParse(r.config_json) || {};
        return acc + computeCommission(r.calculation_type, cfg, base, Number(cfg.quota || 0)).amount;
      }, 0));
    const percentOf = (ruleList: any[]) => {
      const r = ruleList.find((x) => x.calculation_type === "percent_sales");
      return r ? Number(safeParse(r.config_json)?.percent || 0) : null;
    };

    const rows = this.salesBySellerStore(orgId, start, end);
    const filtered = rows.filter((r) => {
      if (opts?.storeId && r.storeId !== opts.storeId) return false;
      if (opts?.sellerKey && this.sellerKeyOf(r.sellerUserId, r.matricula, r.sellerName) !== opts.sellerKey) return false;
      return true;
    });

    const sellers = filtered.map((r) => {
      let commission: number, percent: number | null, commissionSource: string;
      if (sellerRules.length) {
        commission = applyRules(sellerRules, r.sales);
        percent = percentOf(sellerRules);
        commissionSource = "seller_rule";
      } else {
        const eff = r.storeId ? this.effectiveStoreRules(r.storeId, storeRules) : storeRules.filter((x) => !x.store_id);
        const rulesToUse = eff.length ? eff : globalRules;
        commission = applyRules(rulesToUse, r.sales);
        percent = percentOf(rulesToUse);
        commissionSource = eff.length ? (eff.some((x: any) => x.store_id) ? "store_specific_rule" : "store_network_rule") : (globalRules.length ? "global_rule" : "none");
      }
      return { ...r, sellerKey: this.sellerKeyOf(r.sellerUserId, r.matricula, r.sellerName), commission, commissionPercent: percent, commissionSource };
    });

    const byStoreMap = new Map<string, { storeId: string | null; storeName: string; sales: number; pecas: number; orders: number; commission: number; sellerCount: number }>();
    for (const s of sellers) {
      const k = s.storeId || `semLoja:${s.storeName}`;
      const cur = byStoreMap.get(k) || { storeId: s.storeId, storeName: s.storeName, sales: 0, pecas: 0, orders: 0, commission: 0, sellerCount: 0 };
      cur.sales = round2(cur.sales + s.sales); cur.pecas += s.pecas; cur.orders += s.orders; cur.commission = round2(cur.commission + s.commission); cur.sellerCount += 1;
      byStoreMap.set(k, cur);
    }

    return {
      period: { start, end },
      filters: { storeId: opts?.storeId || null, sellerKey: opts?.sellerKey || null },
      sellers,
      byStore: Array.from(byStoreMap.values()).sort((a, b) => a.storeName.localeCompare(b.storeName)),
      totals: {
        sales: round2(sellers.reduce((a, s) => a + s.sales, 0)),
        pecas: sellers.reduce((a, s) => a + s.pecas, 0),
        commission: round2(sellers.reduce((a, s) => a + s.commission, 0)),
        sellerCount: sellers.length,
      },
      hasRules: { seller: sellerRules.length > 0, store: storeRules.length > 0, global: globalRules.length > 0 },
    };
  }

  private static sellerName(orgId: string, userId: string): string {
    try { const u = db.prepare(`SELECT name, email FROM users WHERE id = ? AND organization_id = ?`).get(userId, orgId) as any; return u?.name || u?.email || userId; } catch { return userId; }
  }
  private static productName(orgId: string, productId: string): string | null {
    try { return (db.prepare(`SELECT name FROM products_services WHERE id = ? AND organization_id = ?`).get(productId, orgId) as any)?.name || null; } catch { return null; }
  }

  /** Estimativa da premiação do período SEM persistir (card do dashboard). */
  static estimateTotal(orgId: string, periodStart: string, periodEnd: string): number {
    const rules = db.prepare(`SELECT * FROM retail_commission_rules WHERE organization_id = ? AND active = 1`).all(orgId) as any[];
    const stores = db.prepare(`SELECT id FROM retail_stores WHERE organization_id = ? AND active = 1`).all(orgId) as any[];
    let total = 0;
    for (const rule of rules) {
      const config = safeParse(rule.config_json);
      if (rule.scope === "global") {
        total += computeCommission(rule.calculation_type, config, this.periodSales(orgId, null, periodStart, periodEnd), this.periodQuota(orgId, null, periodStart, periodEnd)).amount;
      } else {
        for (const s of stores) {
          total += computeCommission(rule.calculation_type, config, this.periodSales(orgId, s.id, periodStart, periodEnd), this.periodQuota(orgId, s.id, periodStart, periodEnd)).amount;
        }
      }
    }
    return total;
  }

  // ── Apuração (prévia) ────────────────────────────────────────────────────────
  static createRun(orgId: string, periodStart: string, periodEnd: string, actorId?: string): any {
    const rules = db.prepare(`SELECT * FROM retail_commission_rules WHERE organization_id = ? AND active = 1`).all(orgId) as any[];
    const stores = db.prepare(`SELECT id, name FROM retail_stores WHERE organization_id = ? AND active = 1`).all(orgId) as any[];
    const runId = randomUUID();
    let totalSales = 0, totalCommission = 0;
    const items: any[] = [];

    // Precedência por loja: quando uma loja tem regra ESPECÍFICA (store_id =
    // a loja), as regras de REDE (store_id NULL) não valem pra ela (não paga a
    // mesma verba duas vezes). Calculado uma vez, fora do loop por regra.
    const storeRules = rules.filter((r) => r.scope === "store");
    const effectiveStoreRuleIds = new Map<string, Set<string>>();
    for (const s of stores) effectiveStoreRuleIds.set(s.id, new Set(this.effectiveStoreRules(s.id, storeRules).map((r: any) => r.id)));

    for (const rule of rules) {
      const config = safeParse(rule.config_json);
      // Cota para vendedor/produto vem da regra (config.quota) — não há cota
      // diária por vendedor como há por loja.
      const ruleQuota = Number(config?.quota || 0);
      if (rule.scope === "global") {
        const base = this.periodSales(orgId, null, periodStart, periodEnd);
        const quota = this.periodQuota(orgId, null, periodStart, periodEnd);
        const { amount, detail } = computeCommission(rule.calculation_type, config, base, quota);
        items.push({ storeId: null, sellerName: "GLOBAL", base, commission: amount, ruleId: rule.id, detail });
        totalCommission += amount;
      } else if (rule.scope === "seller") {
        // Comissão por VENDEDOR: base = ZappFlow + lançamentos manuais/foto.
        for (const sv of this.combinedSalesBySeller(orgId, periodStart, periodEnd)) {
          const { amount, detail } = computeCommission(rule.calculation_type, config, sv.sales, ruleQuota);
          items.push({ storeId: null, sellerUserId: sv.sellerUserId, sellerName: sv.sellerName, base: sv.sales, commission: amount, ruleId: rule.id, detail });
          totalCommission += amount;
        }
      } else if (rule.scope === "product") {
        // Comissão por PRODUTO: base = vendas faturadas do ZappFlow por produto.
        for (const pv of this.onlineSalesByProduct(orgId, periodStart, periodEnd)) {
          const { amount, detail } = computeCommission(rule.calculation_type, config, pv.sales, ruleQuota);
          items.push({ storeId: null, productId: pv.productId, sellerName: pv.productName, base: pv.sales, commission: amount, ruleId: rule.id, detail });
          totalCommission += amount;
        }
      } else {
        // store (default): base = realizado da loja (fechamentos). Pula a loja
        // que tem uma regra ESPECÍFICA própria quando esta é a regra de REDE
        // (senão pagaria a verba da loja duas vezes).
        for (const s of stores) {
          if (!effectiveStoreRuleIds.get(s.id)?.has(rule.id)) continue;
          const base = this.periodSales(orgId, s.id, periodStart, periodEnd);
          const quota = this.periodQuota(orgId, s.id, periodStart, periodEnd);
          const { amount, detail } = computeCommission(rule.calculation_type, config, base, quota);
          items.push({ storeId: s.id, sellerName: s.name, base, commission: amount, ruleId: rule.id, detail });
          totalCommission += amount;
        }
      }
    }

    // "Por vendedor vira o oficial" (decisão do gestor): quando NÃO há regra
    // própria por vendedor mas há regra(s) percentual(is) de loja/global, a
    // comissão por VENDEDOR (PDV/CAI_USUARIO + ZappFlow + manual + ERP) sai pela
    // % EFETIVA DA LOJA onde cada venda aconteceu (loja específica > rede >
    // global — não uma % plana, que ficaria errada com lojas em percentuais
    // diferentes) e as linhas por loja/global geradas por essas regras viram
    // REFERÊNCIA (comissão 0) para não pagar a mesma verba duas vezes.
    const hasSellerRule = rules.some((r) => r.scope === "seller");
    const fbRule = hasSellerRule ? null : this.sellerFallbackRule(orgId);
    const fb = hasSellerRule ? null : this.sellerFallbackCommission(orgId, periodStart, periodEnd);
    if (fb?.anyPercent) {
      const sellerItems = this.combinedSalesBySeller(orgId, periodStart, periodEnd)
        .map((sv) => {
          const commission = round2(fb.bySellerKey.get(this.sellerMatchKey(sv.sellerUserId, sv.sellerName)) || 0);
          return { storeId: null, sellerUserId: sv.sellerUserId, sellerName: sv.sellerName, base: sv.sales, commission, ruleId: fbRule?.id || null, detail: { type: "seller_fallback_by_store_rate", base: sv.sales } };
        })
        .filter((it) => it.commission > 0);
      // Só vira "por vendedor oficial" se HÁ comissão por vendedor a pagar; senão
      // a linha por loja continua valendo (não há o que individualizar).
      if (sellerItems.length) {
        const referenceRuleIds = new Set(
          rules.filter((r) => (r.scope === "store" || r.scope === "global") && r.calculation_type === "percent_sales").map((r) => r.id)
        );
        for (const it of items) {
          if (referenceRuleIds.has(it.ruleId)) { totalCommission -= it.commission; it.commission = 0; it.detail = { ...(it.detail || {}), reference: true }; }
        }
        for (const it of sellerItems) { items.push(it); totalCommission += it.commission; }
      }
    }
    totalSales = this.periodSales(orgId, null, periodStart, periodEnd);

    db.prepare(`INSERT INTO retail_commission_runs (id, organization_id, period_start, period_end, status, total_sales, total_commission, created_by) VALUES (?, ?, ?, ?, 'draft', ?, ?, ?)`)
      .run(runId, orgId, periodStart, periodEnd, totalSales, totalCommission, actorId || null);
    for (const it of items) {
      db.prepare(`INSERT INTO retail_commission_items (id, organization_id, run_id, store_id, seller_user_id, seller_name, product_service_id, base_amount, commission_amount, rule_id, calculation_details_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(randomUUID(), orgId, runId, it.storeId || null, it.sellerUserId || null, it.sellerName, it.productId || null, it.base, it.commission, it.ruleId, JSON.stringify(it.detail));
    }
    try { logAuthEvent(orgId, actorId || "system", runId, "RETAIL_COMMISSION_RUN_CREATED", { periodStart, periodEnd, totalCommission }); } catch { /* noop */ }
    return this.getRun(orgId, runId);
  }

  static getRun(orgId: string, id: string): any | null {
    const run = db.prepare(`SELECT * FROM retail_commission_runs WHERE organization_id = ? AND id = ?`).get(orgId, id) as any;
    if (!run) return null;
    run.items = db.prepare(`SELECT * FROM retail_commission_items WHERE run_id = ? ORDER BY seller_name`).all(id);
    return run;
  }

  static listRuns(orgId: string): any[] {
    return db.prepare(`SELECT * FROM retail_commission_runs WHERE organization_id = ? ORDER BY period_start DESC, created_at DESC`).all(orgId) as any[];
  }

  /** Compara a prévia com a premiação informada manualmente e marca divergências. */
  static compare(orgId: string, runId: string, expected: Array<{ storeId?: string | null; amount: number }>, actorId?: string): any | null {
    const run = this.getRun(orgId, runId);
    if (!run) return null;
    const byStore = new Map<string, number>();
    for (const e of Array.isArray(expected) ? expected : []) byStore.set(String(e.storeId ?? "GLOBAL"), Number(e.amount || 0));
    let divergences = 0;
    for (const it of run.items) {
      if (!byStore.has(String(it.store_id ?? "GLOBAL"))) continue;
      const exp = byStore.get(String(it.store_id ?? "GLOBAL"))!;
      const div = Number(it.commission_amount || 0) - exp;
      if (Math.abs(div) > 0.01) divergences++;
      db.prepare(`UPDATE retail_commission_items SET expected_amount = ?, divergence_amount = ?, status = ? WHERE id = ?`)
        .run(exp, div, Math.abs(div) > 0.01 ? "divergent" : "calculated", it.id);
    }
    db.prepare(`UPDATE retail_commission_runs SET divergence_count = ? WHERE organization_id = ? AND id = ?`).run(divergences, orgId, runId);
    try { logAuthEvent(orgId, actorId || "system", runId, "RETAIL_COMMISSION_COMPARED", { divergences }); } catch { /* noop */ }
    return this.getRun(orgId, runId);
  }

  /** Aprovação SEMPRE humana (D7). Nunca paga automaticamente. */
  static setStatus(orgId: string, runId: string, status: "approved" | "rejected", actorId?: string): any | null {
    const run = this.getRun(orgId, runId);
    if (!run) return null;
    db.prepare(`UPDATE retail_commission_runs SET status = ?, approved_by = ?, approved_at = CURRENT_TIMESTAMP WHERE organization_id = ? AND id = ?`)
      .run(status, actorId || null, orgId, runId);
    try { logAuthEvent(orgId, actorId || "system", runId, `RETAIL_COMMISSION_${status.toUpperCase()}`, {}); } catch { /* noop */ }
    return this.getRun(orgId, runId);
  }

  /**
   * Ajuste manual do gerente/dono numa apuração DRAFT: sobrescreve o valor de
   * comissão calculado ou remove um item por completo (loja/vendedor fora da
   * apuração). Só draft — approved/rejected são congelados (retenção contábil).
   *
   * O `total_commission` do run é sempre recalculado como SUM(items) — tudo
   * derivado, nunca somatório mutável (RN-004). Cada operação vira audit
   * event com a diferença pra rastrear "quem tirou/mudou o quê".
   */
  private static assertDraft(orgId: string, runId: string): any {
    const run = db.prepare(`SELECT id, status FROM retail_commission_runs WHERE organization_id = ? AND id = ?`).get(orgId, runId) as any;
    if (!run) throw new Error("run_not_found");
    if (run.status !== "draft") throw new Error("run_not_editable");
    return run;
  }

  static updateItem(orgId: string, runId: string, itemId: string, patch: { commissionAmount: number }, actorId?: string): any | null {
    this.assertDraft(orgId, runId);
    const item = db.prepare(`SELECT id, commission_amount FROM retail_commission_items WHERE id = ? AND run_id = ? AND organization_id = ?`).get(itemId, runId, orgId) as any;
    if (!item) throw new Error("item_not_found");
    const next = Math.round((Number(patch.commissionAmount) || 0) * 100) / 100;
    if (next < 0) throw new Error("negative_commission");
    const previous = Number(item.commission_amount) || 0;
    db.prepare(`UPDATE retail_commission_items SET commission_amount = ? WHERE id = ?`).run(next, itemId);
    const total = (db.prepare(`SELECT COALESCE(SUM(commission_amount), 0) AS s FROM retail_commission_items WHERE run_id = ?`).get(runId) as any).s;
    db.prepare(`UPDATE retail_commission_runs SET total_commission = ? WHERE organization_id = ? AND id = ?`).run(Math.round(total * 100) / 100, orgId, runId);
    try { logAuthEvent(orgId, actorId || "system", runId, "RETAIL_COMMISSION_ITEM_ADJUSTED", { itemId, previous, next, delta: Math.round((next - previous) * 100) / 100 }); } catch { /* noop */ }
    return this.getRun(orgId, runId);
  }

  static deleteItem(orgId: string, runId: string, itemId: string, actorId?: string): any | null {
    this.assertDraft(orgId, runId);
    const item = db.prepare(`SELECT id, seller_name, commission_amount FROM retail_commission_items WHERE id = ? AND run_id = ? AND organization_id = ?`).get(itemId, runId, orgId) as any;
    if (!item) throw new Error("item_not_found");
    db.prepare(`DELETE FROM retail_commission_items WHERE id = ?`).run(itemId);
    const total = (db.prepare(`SELECT COALESCE(SUM(commission_amount), 0) AS s FROM retail_commission_items WHERE run_id = ?`).get(runId) as any).s;
    db.prepare(`UPDATE retail_commission_runs SET total_commission = ? WHERE organization_id = ? AND id = ?`).run(Math.round(total * 100) / 100, orgId, runId);
    try { logAuthEvent(orgId, actorId || "system", runId, "RETAIL_COMMISSION_ITEM_REMOVED", { itemId, sellerName: item.seller_name, removedAmount: Number(item.commission_amount) || 0 }); } catch { /* noop */ }
    return this.getRun(orgId, runId);
  }
}
