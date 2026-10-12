/**
 * ADR-206 F5.9 — NEXT BEST ACTION formal (COMPÕE `ImpactPrioritizationService` + `ProductAttributeIntelligenceService` — sem motor novo, RN-F5-12).
 *
 * "O que eu faço agora?" em NO MÁXIMO 3 ações, cada uma com o porquê, a evidência, quem aprova e como se mede. Não há ranking novo: a
 * ordem é a da priorização de impacto (Pareto) JÁ com a política estratégica do dono (F5.8) e as metas atrasadas — o NBA só dá a forma
 * de decisão em cima dela e acrescenta o que ela não tinha (o que está sendo inclinado pela política, aprovação, medição).
 *
 * Regras: no máximo 3 (RN: "máx. 3 prioridades"); NÃO executa nem propõe ação governada (read-only — executar continua no
 * DecisionAction→ApprovalPolicy→CommandExecutor); sem sinal aberto → lista vazia, sem enchimento; ação que precisa de aprovação
 * de pessoa só é MOSTRADA como tal; dinheiro é do gestor (§73) — sem `includeMoney` o valor sai. As dicas de produto (cor/tamanho) vêm
 * SEPARADAS em "para investigar" (hipótese, máx. 3) e NUNCA entram na ordem das ações, porque são escalas diferentes. Isolado por organização.
 */
import { ImpactPrioritizationService } from "./ImpactPrioritizationService.js";
import { ProductAttributeIntelligenceService } from "./ProductAttributeIntelligenceService.js";

export const NBA_MAX = 3;

export class NextBestActionService {
  static top(orgId: string, opts: { includeMoney?: boolean; asOf?: string } = {}): any {
    const money = opts.includeMoney === true;
    const pri = ImpactPrioritizationService.prioritize(orgId, { globalLimit: 12 });
    const seen = new Set<string>(); const actions: any[] = [];
    for (const p of pri.global || []) {
      const key = `${p.domain}:${p.recommendedActionType || ""}:${p.recommendedAction}`;
      if (seen.has(key)) continue; seen.add(key);
      const c = p.components || {};
      const bits: string[] = [];
      if (p.override) bits.push("evento crítico de segurança/conformidade");
      if (p.affectedGoal) bits.push(`ameaça a meta "${p.affectedGoal.label}" (${p.affectedGoal.gapPct}% abaixo do ritmo)`);
      if (c.slaPressure > 0) bits.push("o prazo está apertando");
      if (c.irreversibility > 0) bits.push("a janela para agir está fechando");
      if (c.policyFactor && c.policyFactor !== 1) bits.push(c.policyFactor > 1 ? "é prioridade na sua política estratégica" : "está abaixo na sua política estratégica");
      actions.push({
        rank: actions.length + 1,
        action: p.recommendedAction, actionType: p.recommendedActionType || null, domain: p.domain, signalType: p.signalType, signalId: p.signalId,
        whyNow: [p.reason, bits.length ? `Pesou: ${bits.join("; ")}.` : null].filter(Boolean).join(" "),
        evidence: {
          basis: p.basis, confidence: p.confidence, impactLevel: p.impactLevel,
          impact: p.impact ? (money || p.impact.unit !== "BRL" ? p.impact : { amount: null, unit: "BRL", hidden: true }) : null,
          groupedSignals: p.groupedCount || 1,
        },
        approval: p.approvalNeeded || null,
        suggestedOwner: p.suggestedOwner, due: p.dueHint,
        howMeasured: p.howMeasured,
        policy: c.policyObjective ? { objective: c.policyObjective, factor: c.policyFactor } : null,
        presentation: p.presentation || null,
      });
      if (actions.length >= NBA_MAX) break;
    }
    let toInvestigate: any[] = [];
    try { toInvestigate = ProductAttributeIntelligenceService.performance(orgId, { includeMoney: false, asOf: opts.asOf }).hints || []; } catch { /* sem dado de varejo: sem dica */ }
    return {
      limit: NBA_MAX, actions, toInvestigate: toInvestigate.slice(0, NBA_MAX),
      empty: actions.length === 0,
      message: actions.length === 0 ? "Nada pede atenção agora." : null,
      notes: ["A ordem é a da priorização de impacto, já com a sua política estratégica e as metas atrasadas.", "Mostrar uma ação não a executa nem a aprova; quem precisa aprovar está indicado em cada uma.", "As dicas de produto são hipóteses para conferir e ficam fora da ordem das ações."],
      generatedAt: new Date().toISOString(),
    };
  }
}

export default NextBestActionService;
