/**
 * PnlCostReconciliationService — ADR-184 F1: read-model RECONCILIADO do CUSTO/DESPESA mensal.
 *
 * Companion do `PnlReconciliationService` (ADR-182, que reconciliou a RECEITA). O custo vive em
 * stores DISJUNTOS sem dimensão comum e só um (payables) entra no resultado do DRE. Este service é
 * a FONTE ÚNICA que DECOMPÕE o custo por natureza, sem recomputar nada de forma nova (reusa as
 * MESMAS queries do `ManagerialDreService`/`RetailStoreCostService`/`loss_events`), rotula ESCOPO,
 * e é HONESTO onde o custo é incomputável (custo desconhecido ≠ zero; custo de loja null-by-design).
 *
 * Segmentos:
 *  - cogs (CMV): core (`order_items.unit_cost`) + comigo (`ComigoHealthService`), com `coverage`
 *    (fração da receita core com custo cadastrado) e `unknownCostRisk` (maioria sem custo → margem
 *    superestimada; NUNCA apresentada como fato — RN-PNL-C-2).
 *  - operatingExpenses: `payables` por competência (fixas × variáveis + byCategory) — ORG-WIDE.
 *  - operationalLosses: `loss_events` das perdas PURAS (exclui desconto/devolucao, que são dedução
 *    de RECEITA já no DRE) — o vazamento que o resultado do DRE ignora hoje (RN-PNL-C-5).
 *  - storeCosts: `RetailStoreCostService.allStoresResult` (fixo/variável/CMV de loja), null onde
 *    incomputável (preserva a honestidade-null do serviço) — rail PARALELO, fora da base do DRE.
 *
 * `total` = base de custo do DRE = cogs + operatingExpenses (o que o resultado do DRE subtrai da
 * receita core). operationalLosses e storeCosts ficam SEPARADOS (não somados no `total`) — como o
 * ADR-182 manteve storeClosings separado: escopos distintos nunca viram um bolo (RN-PNL-C-1/3).
 *
 * Guardrails RN-PNL-C: 1 (segmentos, não bolo) · 2 (desconhecido ≠ zero) · 3 (escopo rotulado) ·
 * 4 (read-only/derivado RN-004) · 5 (perdas visíveis) · 6 (0-regressão: não muda linha do DRE) ·
 * 7 (isolado/determinístico/honesto).
 */
import db from "./db.js";
import { ComigoHealthService } from "./ComigoHealthService.js";
import { RetailStoreCostService } from "./RetailStoreCostService.js";
import { DRIVER_LABEL } from "./LossMarginService.js";
import { BusinessSignalService } from "./BusinessSignalService.js";

function round2(n: number): number { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }

function monthBounds(period: string): { from: string; to: string } {
  const [y, m] = period.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${period}-01`, to: `${period}-${String(last).padStart(2, "0")}` };
}

// Drivers de `loss_events` que são DEDUÇÃO DE RECEITA (já no receitaLiquida do DRE) — não recontar
// como custo. Todos os demais drivers são perda pura (custo real fora do resultado do DRE).
const REVENUE_DEDUCTION_DRIVERS = new Set(["desconto", "devolucao"]);

export interface CogsSegment {
  core: number;              // Σ order_items.unit_cost*qty (status pago/em_preparo/entregue/concluido)
  comigo: number;            // custo Comigo (ComigoHealthService.rangeResult)
  total: number;
  coverage: number | null;   // fração da receita CORE com unit_cost>0 (null sem receita core)
  unknownCostRisk: boolean;  // coverage < 0.5 com receita core → CMV subestimado / margem inflada
}
export interface OperatingExpensesSegment {
  fixas: number; variaveis: number; total: number;
  byCategory: Record<string, number>;
}
export interface OperationalLossesSegment {
  total: number;
  byDriver: Record<string, number>;
}
export interface StoreCostsSegment {
  fixed: number; variable: number;
  cogs: number | null;       // Σ CMV das lojas com custo computável (null se nenhuma)
  coverage: number | null;   // lojas com CMV computável / lojas ativas (null sem lojas)
  total: number;             // fixed + variable (+ cogs quando houver)
}
export interface PnlCostReconciliation {
  period: string;
  segments: {
    cogs: CogsSegment;
    operatingExpenses: OperatingExpensesSegment;
    operationalLosses: OperationalLossesSegment;
    storeCosts: StoreCostsSegment | null;
  };
  total: number;             // base de custo do DRE = cogs + operatingExpenses (0-regressão)
  excludedFromResultado: { operationalLosses: number; storeCosts: number | null };
  unknownCostRisk: boolean;  // atalho do cogs (base do resultado pode superestimar margem)
  scope: string;
  note: string;
}

export class PnlCostReconciliationService {
  /** CMV core + comigo, com cobertura de custo (RN-PNL-C-2: desconhecido ≠ zero). */
  private static cogs(orgId: string, period: string): CogsSegment {
    let core = 0, coveredRev = 0, totalRev = 0;
    try {
      const r = db.prepare(`
        SELECT COALESCE(SUM(oi.unit_cost * oi.quantity), 0) AS cost,
               COALESCE(SUM(CASE WHEN oi.unit_cost > 0 THEN oi.line_total ELSE 0 END), 0) AS covered,
               COALESCE(SUM(oi.line_total), 0) AS total
        FROM order_items oi JOIN orders o ON o.id = oi.order_id
        WHERE oi.organization_id = ? AND o.status IN ('pago','em_preparo','entregue','concluido')
          AND strftime('%Y-%m', o.created_at) = ?
      `).get(orgId, period) as any;
      core = round2(r?.cost); coveredRev = Number(r?.covered) || 0; totalRev = Number(r?.total) || 0;
    } catch { /* honesto: sem dado → 0 */ }
    let comigo = 0;
    try { const { from, to } = monthBounds(period); comigo = round2(ComigoHealthService.rangeResult(orgId, from, to)?.cost || 0); } catch { /* noop */ }
    const coverage = totalRev > 0 ? round2(coveredRev / totalRev) : null;
    // Risco de custo desconhecido: há receita core, mas a maioria sem custo cadastrado → o CMV
    // core está subestimado e a margem bruta superestimada. Nunca "conserta" (não inventa custo).
    const unknownCostRisk = totalRev > 0 && (coverage as number) < 0.5;
    return { core, comigo, total: round2(core + comigo), coverage, unknownCostRisk };
  }

  /** Despesas do mês por competência do vencimento — fixas × variáveis + por categoria (texto livre). */
  private static operatingExpenses(orgId: string, period: string): OperatingExpensesSegment {
    let fixas = 0, variaveis = 0; const byCategory: Record<string, number> = {};
    try {
      const rows = db.prepare(
        `SELECT recurrence, COALESCE(category,'sem_categoria') AS category, COALESCE(SUM(amount),0) AS s
         FROM payables WHERE organization_id = ? AND status IN ('open','paid')
           AND strftime('%Y-%m', due_date) = ? GROUP BY recurrence, category`
      ).all(orgId, period) as any[];
      for (const r of rows) {
        const v = Number(r.s) || 0;
        if (r.recurrence === "weekly" || r.recurrence === "monthly") fixas += v; else variaveis += v;
        byCategory[r.category] = round2((byCategory[r.category] || 0) + v);
      }
    } catch { /* noop */ }
    return { fixas: round2(fixas), variaveis: round2(variaveis), total: round2(fixas + variaveis), byCategory };
  }

  /** Perdas operacionais PURAS (exclui desconto/devolucao = dedução de receita). RN-PNL-C-5. */
  private static operationalLosses(orgId: string, period: string): OperationalLossesSegment {
    const byDriver: Record<string, number> = {}; let total = 0;
    try {
      const rows = db.prepare(
        `SELECT driver, COALESCE(SUM(amount),0) AS s FROM loss_events
         WHERE organization_id = ? AND period = ? GROUP BY driver`
      ).all(orgId, period) as any[];
      for (const r of rows) {
        if (REVENUE_DEDUCTION_DRIVERS.has(r.driver)) continue; // já é dedução de receita no DRE
        const v = round2(Number(r.s) || 0);
        if (v === 0) continue;
        byDriver[r.driver] = v; total += v;
      }
    } catch { /* noop */ }
    return { total: round2(total), byDriver };
  }

  /** Custo de loja (rail paralelo), reusando o serviço que já é honesto-null. */
  private static storeCosts(orgId: string, period: string): StoreCostsSegment | null {
    try {
      const all = RetailStoreCostService.allStoresResult(orgId, period);
      const perStore: any[] = all?.perStore || [];
      if (perStore.length === 0) return null; // sem loja → segmento ausente (honesto)
      const fixed = round2(Number(all.totals?.custosFixos) || 0);
      const variable = round2(Number(all.totals?.custosVariaveis) || 0);
      const withCmv = perStore.filter((s) => s.cmv !== null && s.cmv !== undefined);
      const cogs = withCmv.length > 0 ? round2(withCmv.reduce((a, s) => a + (Number(s.cmv) || 0), 0)) : null;
      const coverage = round2(withCmv.length / perStore.length);
      return { fixed, variable, cogs, coverage, total: round2(fixed + variable + (cogs || 0)) };
    } catch { return null; }
  }

  /** Custo mensal DECOMPOSTO por segmento (fonte única). Não muda nenhuma linha do DRE. */
  static monthlyCost(orgId: string, period: string): PnlCostReconciliation {
    const cogs = this.cogs(orgId, period);
    const operatingExpenses = this.operatingExpenses(orgId, period);
    const operationalLosses = this.operationalLosses(orgId, period);
    const storeCosts = this.storeCosts(orgId, period);

    // `total` = base de custo do DRE (o que o resultado subtrai da receita core): CMV + despesas.
    // Perdas operacionais e custo de loja ficam SEPARADOS (escopos distintos — RN-PNL-C-1/3).
    const total = round2(cogs.total + operatingExpenses.total);

    const parts: string[] = ["Custo do resultado do DRE = CMV (core+Comigo) + despesas (payables, org-wide)."];
    if (cogs.unknownCostRisk) parts.push("Atenção: a maioria da receita não tem custo de aquisição cadastrado — o CMV está subestimado e a margem bruta superestimada (não é possível afirmar o lucro).");
    if (operationalLosses.total > 0) parts.push(`Perdas operacionais de R$ ${operationalLosses.total.toFixed(2)} (merma/quebra/furto/etc.) NÃO entram no resultado do DRE — some do lucro sem aviso.`);
    if (storeCosts) parts.push("Custos de loja (Operação da Rede) são um rail à parte e não estão na base do resultado do DRE.");

    return {
      period,
      segments: { cogs, operatingExpenses, operationalLosses, storeCosts },
      total,
      excludedFromResultado: { operationalLosses: operationalLosses.total, storeCosts: storeCosts ? storeCosts.total : null },
      unknownCostRisk: cogs.unknownCostRisk,
      scope: "dre_core",
      note: parts.join(" "),
    };
  }

  /** Só a base de custo do DRE (compat número). */
  static monthlyCostTotal(orgId: string, period: string): number {
    return this.monthlyCost(orgId, period).total;
  }

  /**
   * ADR-184 F3 — DETALHE das perdas operacionais que o resultado do DRE IGNORA (RN-PNL-C-5).
   * Torna LEGÍVEL o vazamento: decompõe as perdas puras (exclui desconto/devolucao, que são
   * dedução de receita já no DRE) por driver, com o rótulo canônico (`DRIVER_LABEL`, fonte única —
   * não duplica), ordenado por valor desc. Read-only/derivado; honesto (sem perda → items vazio).
   * NÃO muda o resultado — só expõe o que já sai do lucro sem aviso.
   */
  static operationalLossesDetail(orgId: string, period: string): {
    total: number;
    items: { driver: string; label: string; amount: number }[];
    note: string;
  } {
    const { byDriver, total } = this.operationalLosses(orgId, period);
    const items = Object.entries(byDriver)
      .map(([driver, amount]) => ({ driver, label: DRIVER_LABEL[driver] || driver, amount: round2(amount) }))
      .sort((a, b) => b.amount - a.amount);
    const note = total > 0
      ? `Perdas operacionais de R$ ${total.toFixed(2)} NÃO entram no resultado do DRE — reduzem o lucro real sem aparecer na linha.`
      : "Sem perdas operacionais registradas no período.";
    return { total: round2(total), items, note };
  }

  /**
   * ADR-184 F4 — sinal ADVISORY de BASE INCOERENTE do resultado. Espelha o `publishOverlapSignal`
   * do ADR-182: quando o `unknownCostRisk` do período existe (a maioria da receita não tem custo
   * cadastrado → CMV subestimado, margem/lucro NÃO confiáveis), publica um `business_signal` pro
   * dono CADASTRAR os custos — nunca conserta sozinho (não inventa custo). É hipótese (não prova):
   * `basis:'hypothesis'`, `impactAmount:null`. Self-healing: risco some → `resolveByDedupe`;
   * recorre → `reopenByDedupe` (respeita o `dismissed` humano §65). Dedupe por período. Best-effort.
   */
  static publishCostCoherenceSignal(orgId: string, period: string): { published: boolean; resolved: boolean } {
    const dedupeKey = `pnl_cost_coherence:${period}`;
    let published = false, resolved = false;
    try {
      const c = this.monthlyCost(orgId, period);
      if (c.unknownCostRisk) {
        BusinessSignalService.publish(orgId, {
          domain: "pnl_cost",
          signalType: "base_incoherent",
          severity: "attention",
          basis: "hypothesis",            // risco, não prova
          confidence: 0.5,
          impactAmount: null,             // nunca inventa dinheiro/custo
          sourceService: "PnlCostReconciliationService",
          evidence: {
            period, cmvCoverage: c.segments.cogs.coverage,
            message: "A maioria da sua receita não tem custo de aquisição cadastrado — o CMV está subestimado e a margem/lucro do mês NÃO são confiáveis. Cadastre os custos dos produtos (entrada/NF-e) para o resultado fechar.",
          },
          dedupeKey,
        });
        try { BusinessSignalService.reopenByDedupe(orgId, dedupeKey); } catch { /* noop */ }
        published = true;
      } else {
        try { const rr = BusinessSignalService.resolveByDedupe(orgId, dedupeKey); resolved = !!rr?.ok; } catch { /* noop */ }
      }
    } catch { /* best-effort */ }
    return { published, resolved };
  }

  /** Passe do Scheduler: orgs que venderam no mês corrente (onde o risco de CMV faz sentido). */
  static pass(): void {
    let orgs: any[] = [];
    const period = new Date().toISOString().slice(0, 7);
    try { orgs = db.prepare(`SELECT DISTINCT organization_id FROM orders WHERE strftime('%Y-%m', created_at) = ?`).all(period) as any[]; }
    catch { return; }
    for (const o of orgs) {
      try { this.publishCostCoherenceSignal(o.organization_id, period); }
      catch (e) { console.error("[PnL-Custo] coherence pass falhou", o.organization_id, e); }
    }
  }
}

export default PnlCostReconciliationService;
