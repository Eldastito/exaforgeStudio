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

export type CommissionRuleInput = {
  name: string;
  scope?: "store" | "seller" | "product" | "global";
  period?: "daily" | "weekly" | "monthly";
  calculationType: "percent_sales" | "quota_bonus" | "tiered" | "fixed";
  config: any;
  active?: boolean;
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
    db.prepare(
      `INSERT INTO retail_commission_rules (id, organization_id, name, scope, period, calculation_type, config_json, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, orgId, String(input.name || "Regra"), input.scope || "store", input.period || "monthly", input.calculationType, JSON.stringify(input.config || {}), input.active === false ? 0 : 1);
    try { logAuthEvent(orgId, actorId || "system", id, "RETAIL_COMMISSION_RULE_CREATED", { calc: input.calculationType }); } catch { /* noop */ }
    return db.prepare(`SELECT * FROM retail_commission_rules WHERE id = ?`).get(id);
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

    const bySeller = this.onlineSalesBySeller(orgId, start, end).map((s) => ({ ...s, commission: commissionOf(sellerRules, s.sales, 0) }));
    const byProduct = this.onlineSalesByProduct(orgId, start, end).map((p) => ({ ...p, commission: commissionOf(productRules, p.sales, 0) }));

    const stores = db.prepare(`SELECT id, name FROM retail_stores WHERE organization_id = ? AND active = 1`).all(orgId) as any[];
    const byStore = stores.map((s) => {
      const base = this.periodSales(orgId, s.id, start, end);
      const commission = commissionOf(storeRules, base, this.periodQuota(orgId, s.id, start, end));
      return { storeId: s.id, storeName: s.name, sales: round2(base), commission };
    });

    const globalBase = this.periodSales(orgId, null, start, end);
    const globalCommission = globalRules.length ? commissionOf(globalRules, globalBase, this.periodQuota(orgId, null, start, end)) : 0;

    const sum = (arr: any[], k: string) => round2(arr.reduce((a, x) => a + Number(x[k] || 0), 0));
    const totalCommission = round2(sum(bySeller, "commission") + sum(byProduct, "commission") + sum(byStore, "commission") + globalCommission);
    return {
      period: { start, end },
      bySeller, byProduct, byStore, globalCommission,
      totals: { sellerCommission: sum(bySeller, "commission"), productCommission: sum(byProduct, "commission"), storeCommission: round2(sum(byStore, "commission") + globalCommission), totalCommission },
      hasRules: { seller: sellerRules.length > 0, product: productRules.length > 0, store: storeRules.length > 0, global: globalRules.length > 0 },
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
        // Comissão por VENDEDOR: base = vendas faturadas do ZappFlow por vendedor.
        for (const sv of this.onlineSalesBySeller(orgId, periodStart, periodEnd)) {
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
        // store (default): base = realizado da loja (fechamentos).
        for (const s of stores) {
          const base = this.periodSales(orgId, s.id, periodStart, periodEnd);
          const quota = this.periodQuota(orgId, s.id, periodStart, periodEnd);
          const { amount, detail } = computeCommission(rule.calculation_type, config, base, quota);
          items.push({ storeId: s.id, sellerName: s.name, base, commission: amount, ruleId: rule.id, detail });
          totalCommission += amount;
        }
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
}
