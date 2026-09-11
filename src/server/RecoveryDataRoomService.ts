import { RecoveryAssessmentService } from "./RecoveryAssessmentService.js";
import { RecoveryViabilityService } from "./RecoveryViabilityService.js";
import { RecoveryDebtService } from "./RecoveryDebtService.js";
import { DebtPriorityService } from "./DebtPriorityService.js";
import { SurvivalBudgetService } from "./SurvivalBudgetService.js";
import { RecoveryPlanService } from "./RecoveryPlanService.js";
import { ProfessionalEscalationService } from "./ProfessionalEscalationService.js";
import { CashForecastService } from "./CashForecastService.js";

/**
 * RecoveryDataRoomService — Data Room de Recuperação (Financial Recovery OS,
 * PRD-ZF-UNIFIED-GAP-CLOSURE-03 F3.19 / PR-10). Read-only, determinístico, sem tabela nova
 * e SEM storage paralelo (o PRD é explícito: reusar a infra de documento/OCR existente para
 * exportar; esta fatia MONTA o pacote estruturado — a geração de PDF/arquivo fica pra quando
 * ligar a infra de export, sem duplicar armazenamento).
 *
 * COMPÕE (não recria) todos os read-models de recuperação num único pacote organizado para
 * contador/advogado/banco/credor/investidor/sócios: quadro financeiro, IRF+crise, mapa e
 * priorização da dívida, orçamento de sobrevivência, caixa 13 semanas, plano e escalonamento.
 *
 * Dinheiro role-gated (§73) — herda a redação dos read-models compostos. O caixa de 13
 * semanas é redigido aqui quando `includeMoney:false`.
 */

const money = (v: any, includeMoney: boolean) => (includeMoney ? v : null);
function safe<T>(fn: () => T, fallback: T): T { try { return fn(); } catch { return fallback; } }

export class RecoveryDataRoomService {
  /** Monta o Data Room completo (read-only). `includeMoney:false` redige R$. */
  static assemble(orgId: string, opts: { includeMoney?: boolean; period?: string } = {}): any {
    const includeMoney = opts.includeMoney !== false;
    const period = opts.period;

    // Caixa 13 semanas (reusa CashForecastService) — semanas redigidas quando sem dinheiro.
    const forecast = safe(() => CashForecastService.forecast(orgId, { minCash: 0 }), null as any);
    const cash13Weeks = forecast
      ? {
          firstRisk: forecast.firstRisk,
          survivalDays: forecast.survivalDays,
          confidence: forecast.confidence,
          assumptions: forecast.assumptions,
          weeks: includeMoney ? forecast.weeks : (forecast.weeks || []).map((w: any) => ({ weekStart: w.weekStart, risk: w.risk })),
        }
      : null;

    return {
      generatedAt: new Date().toISOString(),
      audience: ["contador", "advogado", "banco", "credor", "investidor", "socios"],
      sections: {
        financial: safe(() => RecoveryAssessmentService.assess(orgId, { includeMoney, period }), null),
        viability: safe(() => RecoveryViabilityService.viability(orgId, { period }), null),
        debtMap: {
          items: safe(() => {
            const rows = RecoveryDebtService.list(orgId);
            if (includeMoney) return rows;
            // Redige os valores em R$ (mantém credor/categoria/status/bands/datas).
            return rows.map((d: any) => ({ ...d, amount_total: null, amount_overdue: null, monthly_payment: null }));
          }, []),
          summary: safe(() => { const s = RecoveryDebtService.summary(orgId); return includeMoney ? s : { ...s, totalKnown: null, totalOverdue: null, monthlyServiceKnown: null, byCategory: s.byCategory.map((c) => ({ category: c.category, count: c.count, total: null })) }; }, null),
        },
        debtPriority: safe(() => DebtPriorityService.prioritize(orgId), null),
        survivalBudget: safe(() => SurvivalBudgetService.suggest(orgId, { includeMoney }), null),
        cash13Weeks,
        plan: safe(() => RecoveryPlanService.plan(orgId, { includeMoney, period }), null),
        escalation: safe(() => ProfessionalEscalationService.assess(orgId), null),
      },
      disclaimer: "Pacote organizado a partir dos dados do sistema, orientativo — não é laudo contábil/jurídico. Confirme com profissional habilitado antes de decisões relevantes.",
      exportNote: "Exportação para PDF/arquivo reusa a infra de documento existente (não implementada nesta fatia).",
      ...(includeMoney ? {} : { redacted: true }),
    };
  }
}

export default RecoveryDataRoomService;
