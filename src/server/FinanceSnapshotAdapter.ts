import { FinancialLedgerService } from "./FinancialLedgerService.js";
import { CashForecastService } from "./CashForecastService.js";
import { ManagerialDreService } from "./ManagerialDreService.js";
import { OwnerDrawService } from "./OwnerDrawService.js";
import { BusinessHealthService } from "./BusinessHealthService.js";

/**
 * FinanceSnapshotAdapter (ADR-135, Enterprise Intelligence Kernel — Epic 1).
 *
 * Adaptador READ-ONLY do domínio financeiro para o Business Snapshot V2. NÃO
 * recalcula nada: reusa os motores determinísticos que já existem (caixa/DRE/
 * previsão/retiradas) e devolve JSON estruturado com `source`/`basis`/
 * `confidence` por métrica — para o Diretor IA NARRAR sem inventar. Falha isolada:
 * qualquer erro devolve `{ available:false, error }` sem derrubar o snapshot.
 */

const safe = <T>(fn: () => T, fallback: T): T => { try { return fn(); } catch { return fallback; } };

export class FinanceSnapshotAdapter {
  static build(orgId: string, period = new Date().toISOString().slice(0, 7)): any {
    try {
      const sum = FinancialLedgerService.summary(orgId) as any;
      const fc = CashForecastService.forecast(orgId, { minCash: 0 }) as any;
      const dre = safe(() => ManagerialDreService.monthly(orgId, period) as any, null);
      const owner = safe(() => OwnerDrawService.summary(orgId, period) as any, null);
      const status = safe(() => (BusinessHealthService.status(orgId) as any)?.status, null);
      const L = dre?.linhas || {};

      return {
        available: true,
        source: "FinanceSnapshotAdapter",
        period,
        statusGeral: status,
        caixa: { value: Number(sum.caixaAtual) || 0, basis: "fact", source: "FinancialLedgerService" },
        aReceber: {
          value: Number(sum.aReceber) || 0,
          vencido: Number(sum.aReceberVencido) || 0,
          vencidoCount: Number(sum.aReceberVencidoCount) || 0,
          detalhe: sum.aReceberDetalhe || null,
          basis: "fact", source: "FinancialLedgerService",
        },
        aPagar: { value: Number(sum.aPagar) || 0, basis: "fact", source: "FinancialLedgerService" },
        entrouHoje: { value: Number(sum.realizadoHoje) || 0, basis: "fact", source: "FinancialLedgerService" },
        previsaoCaixa: {
          survivalDays: fc?.survivalDays ?? null,
          primeiraRuptura: fc?.firstRisk ? { semanasAdiante: fc.firstRisk.weeksAhead, semana: fc.firstRisk.weekStart, saldo: fc.firstRisk.ending } : null,
          basis: "estimate", confidence: 0.7, source: "CashForecastService",
        },
        dre: dre ? {
          receitaLiquida: L.receitaLiquida ?? null, cmv: L.cmv ?? null,
          margemBruta: L.margemBruta ?? null, margemPct: L.margemPct ?? null,
          resultadoOperacional: L.resultadoOperacional ?? null, retiradas: L.retiradas ?? null, sobra: L.sobra ?? null,
          basis: "estimate", source: "ManagerialDreService",
        } : { available: false },
        retiradas: owner ? {
          mes: Number(owner.retiradas) || 0, proLaboreSugerido: Number(owner.proLaboreSugerido) || 0,
          pctDoResultado: owner.pctDoResultado ?? null, alerta: owner.alerta || null,
          basis: "fact", source: "OwnerDrawService",
        } : { available: false },
      };
    } catch (e: any) {
      return { available: false, error: String(e?.message || e), source: "FinanceSnapshotAdapter" };
    }
  }
}

export default FinanceSnapshotAdapter;
