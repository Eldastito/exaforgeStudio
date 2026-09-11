import db from "./db.js";
import { ExecutiveFinanceService } from "./ExecutiveFinanceService.js";
import { RecoveryDebtService } from "./RecoveryDebtService.js";

/**
 * RecoveryAssessmentService — quadro de Recuperação Financeira (Financial Recovery OS,
 * PRD-ZF-UNIFIED-GAP-CLOSURE-03 F3.1/F3.2 / PR-5). É a FACE do módulo + o read-model
 * de diagnóstico.
 *
 * COMPOSIÇÃO PURA (não recalcula, não persiste, zero número novo de caixa/DRE):
 * - lado financeiro: `ExecutiveFinanceService.read` (que por sua vez compõe o
 *   FinanceSnapshotAdapter) — caixa/sobrevivência/recebíveis/pagáveis/rentabilidade, já
 *   com `basis` (fact/estimate) e dinheiro role-gated (§73);
 * - lado dívida: `RecoveryDebtService.summary` — o Mapa da Dívida cadastrado (F3.3).
 *
 * NÃO faz aqui (fatias seguintes, para não inventar escopo — PRD §23):
 * - IRF / índice de recuperabilidade → PR-6 (ESTENDE `survival_index`, não cria índice novo);
 * - classificação crise operacional×financeira → PR-6;
 * - Debt Priority Matrix → PR-7; Scenario/Negotiation → PR-8.
 * Esta fatia só CONSOLIDA o que existe + o Mapa da Dívida, honestamente.
 *
 * Guardrails: RN-FR-6 dinheiro role-gated; RN-FR-7 read-only (não muda FSM/caixa/DRE);
 * RN-FR-8 fact≠estimate (basis do adapter flui intacto; dívida carrega `dataCompleteness`);
 * null≠0 (sem fonte → available:false/null). Isolamento por org.
 */

const FLAG = "financial_recovery_enabled";

export interface RecoveryAssessment {
  generatedAt: string;
  available: boolean;
  finance: {
    cash: number | null;
    cashBasis: string;
    survivalDays: number | null;
    firstRupture: { weeksAhead: number; weekStart: string; endingBalance: number | null } | null;
    receivablesTotal: number | null;
    receivablesOverdue: number | null;
    payablesTotal: number | null;
    resultCore: number | null;
    statusGeral: string | null;
    financeBasis: string; // "estimate" (previsão) coexiste com fact; ver caveats
  } | null;
  debt: {
    itemsCount: number;
    totalKnown: number | null;
    totalOverdue: number | null;
    monthlyServiceKnown: number | null;
    monthlyServiceMissingCount: number;
    byCategory: { category: string; count: number; total: number | null }[];
    dataCompleteness: "empty" | "partial" | "ok";
  };
  caveats: string[];
  redacted?: boolean;
}

const money = (v: number | null, includeMoney: boolean) => (includeMoney ? v : null);

export class RecoveryAssessmentService {
  /** Módulo opt-in (esconder botão não é segurança — gate server-side). */
  static isEnabled(orgId: string): boolean {
    const r = db.prepare(`SELECT ${FLAG} AS v FROM organization_settings WHERE organization_id = ?`).get(orgId) as any;
    return !!(r && Number(r.v) === 1);
  }

  static setEnabled(orgId: string, enabled: boolean): { enabled: boolean } {
    db.prepare(`UPDATE organization_settings SET ${FLAG} = ? WHERE organization_id = ?`).run(enabled ? 1 : 0, orgId);
    return { enabled: this.isEnabled(orgId) };
  }

  static settings(orgId: string): { enabled: boolean; debtItems: number } {
    return { enabled: this.isEnabled(orgId), debtItems: RecoveryDebtService.list(orgId).length };
  }

  /**
   * Quadro consolidado de recuperação (read-only). Compõe o financeiro executivo + o Mapa
   * da Dívida. `includeMoney:false` redige BRL (mantém contagens/dias/percentuais).
   */
  static assess(orgId: string, opts: { includeMoney?: boolean; period?: string } = {}): RecoveryAssessment {
    const includeMoney = opts.includeMoney !== false;
    const caveats: string[] = [];

    const fin = safe(() => ExecutiveFinanceService.read(orgId, { includeMoney, period: opts.period }), null as any);
    let finance: RecoveryAssessment["finance"] = null;
    if (fin && fin.available) {
      caveats.push(...(fin.caveats || []));
      finance = {
        cash: fin.liquidity?.cash ?? null,
        cashBasis: fin.liquidity?.cashBasis || "fact",
        survivalDays: fin.liquidity?.survivalDays ?? null,
        firstRupture: fin.liquidity?.firstRupture ?? null,
        receivablesTotal: fin.receivables?.total ?? null,
        receivablesOverdue: fin.receivables?.overdue ?? null,
        payablesTotal: fin.payables?.total ?? null,
        resultCore: fin.profitability?.operatingResultCore ?? null,
        statusGeral: fin.statusGeral ?? null,
        financeBasis: "estimate", // a projeção de sobrevivência é estimate; caixa/AR/AP são fact (ver caveats)
      };
    } else {
      caveats.push("Financeiro indisponível (sem fonte lançada) — quadro parcial.");
    }

    const s = RecoveryDebtService.summary(orgId);
    if (s.dataCompleteness === "empty") caveats.push("Nenhuma dívida cadastrada no Mapa da Dívida — o quadro de obrigações está incompleto.");
    else if (s.dataCompleteness === "partial") caveats.push(`${s.monthlyServiceMissingCount} dívida(s) sem parcela mensal informada — serviço mensal da dívida subestimado.`);

    const debt = {
      itemsCount: s.itemsCount,
      totalKnown: money(s.totalKnown, includeMoney),
      totalOverdue: money(s.totalOverdue, includeMoney),
      monthlyServiceKnown: money(s.monthlyServiceKnown, includeMoney),
      monthlyServiceMissingCount: s.monthlyServiceMissingCount, // contagem — não é dinheiro
      byCategory: s.byCategory.map((c) => ({ category: c.category, count: c.count, total: money(c.total, includeMoney) })),
      dataCompleteness: s.dataCompleteness,
    };

    return {
      generatedAt: new Date().toISOString(),
      available: !!finance || s.itemsCount > 0,
      finance,
      debt,
      caveats,
      ...(includeMoney ? {} : { redacted: true }),
    };
  }
}

function safe<T>(fn: () => T, fallback: T): T { try { return fn(); } catch { return fallback; } }

export default RecoveryAssessmentService;
