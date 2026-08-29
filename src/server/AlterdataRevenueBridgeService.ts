/**
 * AlterdataRevenueBridgeService — PRD-ZF-ALTERDATA-GOLIVE-01 (PR 8, RF-15).
 *
 * Auditoria + visão pública da ponte Fechamento → Faturamento (retail_revenue_bridge)
 * que já existe em RetailRevenueBridgeService. Este arquivo:
 *
 *   1. Empacota o estado atual (enabled/disabled) e o breakdown de receita
 *      dos últimos N meses (default 3) — pra Diretor IA / DRE / snapshot
 *      mostrarem "de onde veio o faturamento": integração Alterdata (via PDV
 *      no fechamento) ou informe manual da loja.
 *   2. Expõe uma trilha resumida por closing: id, data, loja, valor, source
 *      ('pdv' significa que o valor veio do sync Alterdata) — evidência
 *      auditável pra RF-15 (origem do dado: Alterdata Sales → fechamento →
 *      ledger).
 *   3. Não recomputa nada — só lê. Determinístico, zero-token, isolado por
 *      org. Não fecha ciclo com o FinancialLedgerService (evita dependência
 *      circular; a POSTAGEM já é feita lá).
 */
import db from "./db.js";
import { RetailRevenueBridgeService } from "./RetailRevenueBridgeService.js";

const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

export interface RevenueBridgePeriodBreakdown {
  period: string;              // 'YYYY-MM'
  totalRevenue: number;        // soma monetária
  closingsCount: number;       // fechamentos elegíveis no mês
  bySource: {
    pdv: { count: number; amount: number };       // origem = PDV (Alterdata sync)
    manual: { count: number; amount: number };    // digitado
    whatsapp: { count: number; amount: number };  // enviado via WA
    other: { count: number; amount: number };
  };
}

export interface RevenueBridgeClosingRow {
  id: string;
  storeId: string;
  closingDate: string;         // YYYY-MM-DD
  value: number;
  source: string;              // 'pdv' | 'manual' | 'whatsapp' | 'integration' | 'image_ocr' | ...
  status: string;              // 'approved' | 'reconciled' | 'divergent'
}

export interface RevenueBridgeAudit {
  organizationId: string;
  enabled: boolean;
  months: RevenueBridgePeriodBreakdown[];
  recentClosings: RevenueBridgeClosingRow[];
  computedAt: string;
}

const ELIGIBLE_STATUSES = "('approved','reconciled','divergent')";
const VALUE_EXPR = "COALESCE(NULLIF(system_total, 0), informed_total)";

export class AlterdataRevenueBridgeService {
  /** Liga/desliga a ponte. Passa por RetailRevenueBridgeService pra manter uma fonte da verdade. */
  static setEnabled(orgId: string, on: boolean): boolean {
    return RetailRevenueBridgeService.setEnabled(orgId, on);
  }

  static isEnabled(orgId: string): boolean {
    return RetailRevenueBridgeService.isEnabled(orgId);
  }

  /**
   * Audit + visão para o Diretor IA / DRE / snapshot. Default = 3 meses.
   */
  static audit(orgId: string, opts: { months?: number; recentLimit?: number } = {}): RevenueBridgeAudit {
    const monthsN = Math.min(24, Math.max(1, opts.months ?? 3));
    const recentLimit = Math.min(500, Math.max(1, opts.recentLimit ?? 50));

    const periods: string[] = [];
    const now = new Date();
    for (let i = 0; i < monthsN; i++) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
      periods.push(d.toISOString().slice(0, 7));
    }

    const months: RevenueBridgePeriodBreakdown[] = periods.map((period) => this.breakdownFor(orgId, period));

    const recentClosings = db.prepare(
      `SELECT id, store_id, closing_date, ${VALUE_EXPR} AS value, source, status
         FROM retail_daily_closings
        WHERE organization_id = ? AND status IN ${ELIGIBLE_STATUSES} AND ${VALUE_EXPR} > 0
        ORDER BY closing_date DESC LIMIT ?`
    ).all(orgId, recentLimit) as any[];

    return {
      organizationId: orgId,
      enabled: this.isEnabled(orgId),
      months,
      recentClosings: recentClosings.map(r => ({
        id: String(r.id),
        storeId: String(r.store_id),
        closingDate: String(r.closing_date).slice(0, 10),
        value: round2(r.value),
        source: String(r.source || "manual"),
        status: String(r.status || ""),
      })),
      computedAt: new Date().toISOString(),
    };
  }

  private static breakdownFor(orgId: string, period: string): RevenueBridgePeriodBreakdown {
    const rows = db.prepare(
      `SELECT source, ${VALUE_EXPR} AS value FROM retail_daily_closings
        WHERE organization_id = ? AND status IN ${ELIGIBLE_STATUSES}
          AND strftime('%Y-%m', closing_date) = ? AND ${VALUE_EXPR} > 0`
    ).all(orgId, period) as any[];

    const bySource = {
      pdv:      { count: 0, amount: 0 },
      manual:   { count: 0, amount: 0 },
      whatsapp: { count: 0, amount: 0 },
      other:    { count: 0, amount: 0 },
    };
    let total = 0;
    for (const r of rows) {
      const value = round2(r.value);
      total += value;
      const bucket =
        r.source === "pdv" || r.source === "integration" ? "pdv"
        : r.source === "manual" ? "manual"
        : r.source === "whatsapp" ? "whatsapp"
        : "other";
      bySource[bucket].count++;
      bySource[bucket].amount = round2(bySource[bucket].amount + value);
    }

    return {
      period,
      totalRevenue: round2(total),
      closingsCount: rows.length,
      bySource,
    };
  }
}
