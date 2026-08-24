import { FinancialLedgerService } from "./FinancialLedgerService.js";
import { CashForecastService } from "./CashForecastService.js";
import { ManagerialDreService } from "./ManagerialDreService.js";
import { OwnerDrawService } from "./OwnerDrawService.js";
import { BusinessHealthService } from "./BusinessHealthService.js";
import { PnlCostReconciliationService } from "./PnlCostReconciliationService.js";
import { ConsolidatedResultService } from "./ConsolidatedResultService.js";

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
      const cost = safe(() => PnlCostReconciliationService.monthlyCost(orgId, period) as any, null);
      const consolidated = safe(() => ConsolidatedResultService.monthly(orgId, period) as any, null);
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
          // ADR-182 F3 — ESCOPO explícito: o DRE gerencial é CORE-only (pedidos + Comigo) e
          // NÃO inclui fechamentos de loja. Difere de `sales.receitaMes` (all_channels) pela
          // receita das lojas — os dois NUNCA devem ser somados nem tratados como o mesmo número.
          scope: "core",
          scopeNote: "Receita líquida do DRE = canais core (pedidos + Comigo); exclui fechamentos de loja. Não somar com sales.receitaMes (all_channels).",
          // ADR-184 F2 — COERÊNCIA DE CUSTO: a base do resultado é margem CORE − despesas
          // ORG-WIDE; a confiança do CMV (cobertura de custo cadastrado) e o que o resultado
          // IGNORA (perdas operacionais + custo de loja) ficam explícitos pro Diretor IA narrar
          // sem fingir precisão. Deriva do read-model reconciliado; NÃO altera nenhuma linha.
          costScope: cost ? cost.scope : null,
          cmvCoverage: cost ? cost.segments?.cogs?.coverage ?? null : null,
          unknownCostRisk: cost ? cost.unknownCostRisk : null,
          excludedFromResultado: cost ? cost.excludedFromResultado : null,
          // ADR-184 F3 — DETALHE legível das perdas operacionais que o resultado ignora (merma/
          // quebra/furto/etc.), com rótulo canônico. Não muda o resultado; torna o vazamento visível.
          operationalLossesDetail: safe(() => PnlCostReconciliationService.operationalLossesDetail(orgId, period) as any, null),
          costScopeNote: cost
            ? "Base do resultado = margem dos canais core − despesas (payables) org-wide. " +
              (cost.unknownCostRisk ? "A maioria da receita não tem custo cadastrado — o CMV está subestimado e a margem/lucro NÃO podem ser afirmados como fato. " : "") +
              "Perdas operacionais e custos de loja NÃO estão nesta base (ver excludedFromResultado)."
            : null,
          // ADR-186 F2 — RESULTADO CONSOLIDADO (all_channels = core + lojas) AO LADO do
          // `resultadoOperacional` core acima (que fica INTACTO — 0-regressão). É o lucro REAL do
          // dono de varejo, com `partial` (loja sem resultado computável → não inventa lucro) e
          // `doubleCountRisk` (mesmo custo lançado como payable E custo de loja) explícitos. O
          // resultado core acima segue CORE — nunca confundir com o consolidado (escopos rotulados).
          consolidated: consolidated ? {
            resultadoOperacional: consolidated.consolidated?.resultadoOperacional ?? null,
            scope: "all_channels",
            partial: consolidated.consolidated?.partial ?? false,
            coreResult: consolidated.core?.resultadoOperacional ?? null,
            storesResult: consolidated.stores?.resultado ?? null,
            doubleCountRisk: consolidated.doubleCountRisk ?? false,
            doubleCountCategories: consolidated.doubleCountCategories ?? [],
            note: consolidated.note ?? null,
          } : null,
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
