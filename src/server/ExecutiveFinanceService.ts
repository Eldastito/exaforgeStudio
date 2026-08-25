import { FinanceSnapshotAdapter } from "./FinanceSnapshotAdapter.js";
import { BusinessGoalService } from "./BusinessGoalService.js";

/**
 * Executive Finance (ADR-190 F7, CEO Operating Layer).
 *
 * O pilar financeiro RICO projetado na moldura executiva: liquidez (caixa +
 * sobrevivência), recebíveis (a receber + vencido + inadimplência), rentabilidade
 * (margem + resultado core E consolidado, com escopo) e retiradas. É COMPOSIÇÃO
 * PURA sobre o `FinanceSnapshotAdapter` (que já deriva tudo e rotula `basis`/
 * `scope`/`source`) + o `default_rate` do registro executivo (F2). Não recalcula
 * nada, não persiste, zero tabela nova (§30 do PRD estava desatualizado — o
 * financeiro é o braço MAIS consolidado, não o menos).
 *
 * HONESTIDADE (RN-CEO-08/11): `basis`/`scope`/`source` do adapter fluem intactos —
 * fato≠hipótese (caixa é `fact`, previsão é `estimate`, DRE é `estimate`). Bloco
 * sem fonte → `available:false`/`null`, nunca 0. `caveats[]` carrega as notas de
 * ESCOPO do adapter (core × all_channels nunca somados; custo desconhecido →
 * margem não afirmável) pro Diretor narrar sem fingir precisão.
 *
 * DINHEIRO role-gated (§73/RN-CEO-13): `includeMoney:false` redige os valores em
 * BRL (mantém contagens/percentuais/dias — não são dinheiro); rota owner/admin.
 */

const money = (v: number | null, includeMoney: boolean) => (includeMoney ? v : null);

export interface ExecutiveFinance {
  generatedAt: string;
  period: string;
  available: boolean;
  statusGeral: string | null;
  liquidity: {
    cash: number | null;
    cashBasis: string;
    survivalDays: number | null;
    firstRupture: { weeksAhead: number; weekStart: string; endingBalance: number | null } | null;
  } | null;
  receivables: {
    total: number | null;
    overdue: number | null;
    overdueCount: number | null;
    defaultRatePct: number | null;
    defaultRateAvailability: string;
    basis: string;
  } | null;
  payables: { total: number | null; basis: string } | null;
  profitability: {
    available: boolean;
    netRevenue: number | null;
    grossMargin: number | null;
    marginPct: number | null;
    operatingResultCore: number | null;
    consolidatedResult: number | null;
    consolidatedPartial: boolean;
    scope: string;
    unknownCostRisk: boolean | null;
  } | null;
  withdrawals: { month: number | null; suggestedProLabore: number | null; pctOfResult: number | null; alert: any } | null;
  caveats: string[];
  redacted?: boolean;
}

export class ExecutiveFinanceService {
  /** Financeiro executivo — projeção read-only do FinanceSnapshotAdapter. Nunca recalcula. */
  static read(orgId: string, opts: { period?: string; includeMoney?: boolean } = {}): ExecutiveFinance {
    const includeMoney = opts.includeMoney !== false;
    const period = opts.period || new Date().toISOString().slice(0, 7);
    const fin = safe(() => FinanceSnapshotAdapter.build(orgId, period), { available: false } as any);
    const dr = safe(() => BusinessGoalService.measure(orgId, "default_rate"), null);

    const caveats: string[] = [];
    if (!fin || fin.available === false) {
      return {
        generatedAt: new Date().toISOString(), period, available: false, statusGeral: null,
        liquidity: null, receivables: null, payables: null, profitability: null, withdrawals: null,
        caveats: ["Financeiro indisponível (sem fonte lançada).".trim()],
      };
    }

    const dre = fin.dre && fin.dre.available !== false ? fin.dre : null;
    if (dre?.scopeNote) caveats.push(dre.scopeNote);
    if (dre?.costScopeNote) caveats.push(dre.costScopeNote);

    const liquidity = {
      cash: money(num(fin.caixa?.value), includeMoney),
      cashBasis: fin.caixa?.basis || "fact",
      survivalDays: fin.previsaoCaixa?.survivalDays ?? null,
      firstRupture: fin.previsaoCaixa?.primeiraRuptura
        ? {
            weeksAhead: fin.previsaoCaixa.primeiraRuptura.semanasAdiante,
            weekStart: fin.previsaoCaixa.primeiraRuptura.semana,
            endingBalance: money(num(fin.previsaoCaixa.primeiraRuptura.saldo), includeMoney),
          }
        : null,
    };

    const receivables = {
      total: money(num(fin.aReceber?.value), includeMoney),
      overdue: money(num(fin.aReceber?.vencido), includeMoney),
      overdueCount: fin.aReceber?.vencidoCount ?? null, // contagem — não é dinheiro
      defaultRatePct: dr && dr.availability === "available" ? dr.value : null, // % — não redige; honesto null s/ fonte
      defaultRateAvailability: dr?.availability || "unavailable",
      basis: fin.aReceber?.basis || "fact",
    };

    const payables = { total: money(num(fin.aPagar?.value), includeMoney), basis: fin.aPagar?.basis || "fact" };

    const profitability = dre
      ? {
          available: true,
          netRevenue: money(num(dre.receitaLiquida), includeMoney),
          grossMargin: money(num(dre.margemBruta), includeMoney),
          marginPct: dre.margemPct ?? null, // % — não é dinheiro
          operatingResultCore: money(num(dre.resultadoOperacional), includeMoney),
          consolidatedResult: money(num(dre.consolidated?.resultadoOperacional), includeMoney),
          consolidatedPartial: !!dre.consolidated?.partial,
          scope: dre.scope || "core",
          unknownCostRisk: dre.unknownCostRisk ?? null,
        }
      : { available: false, netRevenue: null, grossMargin: null, marginPct: null, operatingResultCore: null, consolidatedResult: null, consolidatedPartial: false, scope: "core", unknownCostRisk: null };

    const withdrawals = fin.retiradas && fin.retiradas.available !== false
      ? {
          month: money(num(fin.retiradas.mes), includeMoney),
          suggestedProLabore: money(num(fin.retiradas.proLaboreSugerido), includeMoney),
          pctOfResult: fin.retiradas.pctDoResultado ?? null, // % — não é dinheiro
          alert: fin.retiradas.alerta || null,
        }
      : null;

    return {
      generatedAt: new Date().toISOString(), period, available: true, statusGeral: fin.statusGeral ?? null,
      liquidity, receivables, payables, profitability, withdrawals, caveats,
      ...(includeMoney ? {} : { redacted: true }),
    };
  }
}

function num(v: any): number | null { const n = Number(v); return Number.isFinite(n) ? n : null; }
function safe<T>(fn: () => T, fallback: T): T { try { return fn(); } catch { return fallback; } }

export default ExecutiveFinanceService;
