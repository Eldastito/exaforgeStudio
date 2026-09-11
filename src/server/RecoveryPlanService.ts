import { RecoveryAssessmentService } from "./RecoveryAssessmentService.js";
import { RecoveryViabilityService } from "./RecoveryViabilityService.js";
import { DebtPriorityService } from "./DebtPriorityService.js";
import { SurvivalBudgetService } from "./SurvivalBudgetService.js";
import { MissionService } from "./MissionService.js";

/**
 * RecoveryPlanService — Plano de Recuperação consolidado + sugestão de Missão (Financial
 * Recovery OS, PRD-ZF-UNIFIED-GAP-CLOSURE-03 F3.13/F3.14 / PR-9). Read-only, determinístico,
 * sem tabela nova.
 *
 * COMPÕE (não recria) os read-models já entregues nas fatias anteriores:
 * - RecoveryAssessmentService (F3.2 — quadro financeiro + Mapa da Dívida)
 * - RecoveryViabilityService (F3.6/F3.7 — IRF + diagnóstico crise operacional×financeira)
 * - DebtPriorityService (F3.8 — matriz de priorização, NÃO ordem jurídica)
 * - SurvivalBudgetService (F3.5 — sugestão de corte A/B/C/D)
 * e monta um plano ORDENADO por seção (estancar saída → renegociar → recuperar recebíveis →
 * melhorar margem), cada uma com itens DERIVADOS e caveats. O diagnóstico de crise ordena as
 * seções (crise operacional prioriza margem/operação; financeira prioriza renegociação).
 *
 * MISSION (F3.14): suggestMission() devolve um RASCUNHO no mesmo shape que MissionService.create
 * aceita — SUGERE, NUNCA cria (espelha ExecutiveMissionBridgeService; RN-CEO-06/RN-FR). O alvo
 * NÃO é inventado: usa o limiar do PRÓPRIO modelo IRF (faixa "recuperável" = 65), rotulado.
 *
 * Dinheiro role-gated (§73) — herda a redação dos read-models compostos.
 * Escalonamento profissional completo (F3.17) e Data Room (F3.19) são a PR-10.
 */

const IRF_TARGET_RECUPERAVEL = 65; // limiar da faixa "recuperável" do RecoveryViabilityService (não é alvo inventado)

export interface RecoveryPlanSection {
  key: string;
  title: string;
  rationale: string;
  items: any[];
  caveats: string[];
}

function safe<T>(fn: () => T, fallback: T): T { try { return fn(); } catch { return fallback; } }

export class RecoveryPlanService {
  /**
   * Plano de Recuperação consolidado. Read-only. `includeMoney:false` herda a redação de R$
   * dos read-models compostos.
   */
  static plan(orgId: string, opts: { includeMoney?: boolean; period?: string } = {}): any {
    const includeMoney = opts.includeMoney !== false;
    const assessment = safe(() => RecoveryAssessmentService.assess(orgId, { includeMoney, period: opts.period }), null as any);
    const viability = safe(() => RecoveryViabilityService.viability(orgId, { period: opts.period }), null as any);
    const priority = safe(() => DebtPriorityService.prioritize(orgId), { items: [], caveats: [] } as any);
    const budget = safe(() => SurvivalBudgetService.suggest(orgId, { includeMoney }), { items: [], summary: [], caveats: [] } as any);

    const crisis = viability?.crisis?.shape || "undetermined";
    const caveats: string[] = [];
    if (!assessment || assessment.available === false) caveats.push("Quadro financeiro parcial — plano incompleto (lance caixa/contas).");

    // Seções derivadas.
    const cutItems = (budget.items || []).filter((i: any) => i.tier === "C" || i.tier === "D");
    const estancar: RecoveryPlanSection = {
      key: "estancar_saida", title: "Estancar a saída de caixa",
      rationale: "Reduzir/adiar despesas adiáveis (C) e cortáveis (D) — a IA sugere, o humano confirma; nada é cancelado automaticamente.",
      items: cutItems, caveats: ["Sugestão — corte/adiamento é decisão humana (F3.5)."],
    };
    const renegociar: RecoveryPlanSection = {
      key: "renegociar_dividas", title: "Renegociar/priorizar dívidas",
      rationale: "Priorização por 4 eixos (jurídico/operacional/custo/negociabilidade) — NÃO é ordem jurídica de pagamento; risco jurídico exige validação profissional.",
      items: (priority.items || []).slice(0, 5), caveats: priority.caveats || [],
    };
    const overdue = assessment?.finance?.receivablesOverdue;
    const recuperarReceber: RecoveryPlanSection = {
      key: "recuperar_recebiveis", title: "Recuperar recebíveis vencidos",
      rationale: "Recebíveis já vencidos são caixa a recuperar (fato). Acionar a Cobrança sobre o que venceu.",
      items: overdue == null ? [] : [{ overdue, basis: "fact", lever: "collection" }],
      caveats: overdue == null ? ["Sem recebível vencido informado."] : [],
    };
    const margem: RecoveryPlanSection = {
      key: "melhorar_margem", title: "Melhorar margem / operação",
      rationale: crisis === "operational" || crisis === "mixed"
        ? "A operação perde dinheiro antes da dívida — corrigir margem/preço/custo é prioridade (diagnóstico de crise)."
        : "Reforço de margem como alavanca complementar de geração de caixa.",
      items: [], caveats: ["Alavanca estrutural — detalhamento com Pricing/Cost Intelligence (fatia futura)."],
    };

    // Ordem pelo diagnóstico: crise operacional → margem primeiro; financeira → renegociar primeiro.
    let sections: RecoveryPlanSection[];
    if (crisis === "operational") sections = [margem, estancar, recuperarReceber, renegociar];
    else if (crisis === "financial") sections = [renegociar, recuperarReceber, estancar, margem];
    else sections = [estancar, renegociar, recuperarReceber, margem];

    const professionalReviewRecommended = crisis === "mixed" ||
      (priority.items || []).some((i: any) => i.axes?.legalRisk?.band === "high");

    return {
      generatedAt: new Date().toISOString(),
      objective: "Restaurar o equilíbrio financeiro com base nos dados disponíveis.",
      crisis: viability?.crisis || { shape: "undetermined", reason: "" },
      irf: viability ? { score: viability.irf, faixa: viability.faixa } : null,
      runway: assessment?.finance ? { survivalDays: assessment.finance.survivalDays, firstRupture: assessment.finance.firstRupture } : null,
      sections,
      professionalReviewRecommended,
      caveats: [...caveats, ...(viability?.caveats || [])],
      disclaimer: viability?.disclaimer || "Plano orientativo — não é parecer contábil/jurídico.",
      ...(includeMoney ? {} : { redacted: true }),
    };
  }

  /**
   * SUGERE uma missão de recuperação (F3.14) — RASCUNHO no shape de MissionService.create.
   * NUNCA cria (RN-CEO-06). Alvo = limiar do próprio IRF (faixa recuperável), não inventado.
   */
  static suggestMission(orgId: string): any {
    const missionLayerEnabled = safe(() => MissionService.isEnabled(orgId), false);
    const viability = safe(() => RecoveryViabilityService.viability(orgId), null as any);

    // Dedupe: missão viva já mirando o IRF/recuperação não é re-sugerida.
    const TERMINAL = new Set(["achieved", "failed", "cancelled"]);
    const alreadyCovered = safe(() => MissionService.list(orgId), [] as any[])
      .some((m: any) => m.targetMetric === "irf" && !TERMINAL.has(m.status));

    const currentIrf = viability?.irf ?? null;
    const draft = {
      title: "Restaurar equilíbrio financeiro",
      description: `Levar o Índice de Recuperabilidade Financeira (IRF) à faixa "recuperável" (≥ ${IRF_TARGET_RECUPERAVEL})${currentIrf != null ? `; hoje em ${currentIrf}` : ""}. Executar o Plano de Recuperação (estancar saída, renegociar, recuperar recebíveis, melhorar margem).`,
      targetMetric: "irf",
      targetValue: IRF_TARGET_RECUPERAVEL,
      targetUnit: "pts",
      source: "system_proposed",
      confidence: null,
    };

    return {
      generatedAt: new Date().toISOString(),
      missionLayerEnabled,
      alreadyCovered,
      basis: "hypothesis",
      draft: alreadyCovered ? null : draft,
      note: "Sugestão (hipótese). O dono confirma pra virar missão — o ZapFlow nunca cria a missão sozinho (RN-CEO-06). O acompanhamento reusa o checkpoint/replan do Mission OS.",
    };
  }
}

export default RecoveryPlanService;
