import { DecisionActionService } from "./DecisionActionService.js";
import { CommandExecutorService } from "./CommandExecutorService.js";
import { ExecutionPlan, ExecutionPlanStep } from "./skillosModel.js";

/**
 * SkillOsExecutionBridge — PRD 4 F8 (§67): a PONTE Skill/Plano → Execução GOVERNADA.
 *
 * Este é o ponto mais sensível do SkillOS. A regra é ABSOLUTA (ADR-159 / §67): uma
 * Skill NUNCA executa um efeito empresarial diretamente. O efeito vira uma AÇÃO
 * PROPOSTA (`DecisionActionService.propose` — que resolve a política de aprovação)
 * e só roda pelo CHOKE-POINT ÚNICO (`CommandExecutorService.execute`, com as guardas
 * G1 autonomia + G2 execution_mode + G3 aprovado). A ponte NÃO tem sink próprio: ela
 * apenas ENCAMINHA pros serviços que já existem. Um executor de skill paralelo
 * reabriria exatamente o buraco que a ADR-159 fechou (RISK-1 da auditoria).
 *
 * Aditiva/inerte: nenhuma skill real é ligada ainda (fase de onboarding de skills).
 * → 0 mudança de comportamento.
 *
 * GUARDRAILS (testados):
 *   - RN-BR-1 SEM BYPASS (§67/ADR-159): efeito só via propose → (aprovação) →
 *     CommandExecutor. A ponte não executa nada por conta própria.
 *   - RN-BR-2 REUSA: DecisionActionService (propor/aprovar) + ApprovalPolicyService
 *     (política, dentro do propose) + CommandExecutorService (guardas) — nada paralelo.
 *   - RN-BR-3 SÓ PLANO PRONTO: passo unresolved / plano blocked NÃO propõe efeito.
 *   - RN-BR-4 FIO (ADR-158): `correlationId` propaga do plano/skill à ação.
 */

export interface SkillEffectInput {
  skillId?: string | null;
  capabilityId?: string | null;
  domain: string;
  actionType: string;
  commandType: string;            // o command_type do CommandExecutor (o efeito real)
  commandPayload?: any;
  title: string;
  description?: string | null;
  expectedImpact?: number | null;
  impactUnit?: string | null;
  confidence?: number | null;
  correlationId?: string | null;
  createdBy?: string;
}

export class SkillOsExecutionBridge {
  /**
   * PROPÕE o efeito de uma skill como `decision_action` (reusa DecisionActionService,
   * que aplica a ApprovalPolicy). NÃO executa — a skill nunca dispara efeito direto.
   * Retorna a ação (com o status conforme a política: approved | awaiting_approval).
   */
  static propose(orgId: string, input: SkillEffectInput): any {
    if (!input?.commandType) throw new Error("Efeito de skill exige commandType (o efeito real é um comando governado).");
    return DecisionActionService.propose(orgId, {
      signalId: null,
      domain: input.domain,
      actionType: input.actionType,
      title: input.title,
      description: input.description ?? null,
      commandType: input.commandType,
      commandPayload: input.commandPayload,
      expectedImpact: input.expectedImpact ?? null,
      impactUnit: input.impactUnit ?? null,
      confidence: input.confidence ?? undefined,
      basis: "estimate",
      createdBy: input.createdBy || "skillos",
      // Fio ADR-158: liga a ação à cadeia do plano/skill/AI Run (que carrega skill_id).
      correlationId: input.correlationId ?? null,
    });
  }

  /**
   * EXECUTA uma ação aprovada pelo CHOKE-POINT ÚNICO. É um passthrough puro pro
   * `CommandExecutorService.execute` — as guardas G1/G2/G3 vivem lá. A ponte não as
   * reimplementa (seria um 2º caminho de política = violação da ADR-159).
   */
  static execute(orgId: string, actionId: string): Promise<any> {
    return CommandExecutorService.execute(orgId, actionId);
  }

  /**
   * Conveniência: propõe o efeito de um PASSO de plano (F7) já resolvido. Passo
   * unresolved / plano não-`ready` → não propõe (RN-BR-3), devolve null. Propaga o
   * `correlationId` do plano (RN-BR-4). O mapeamento passo→(domain/actionType/
   * commandType/payload) é do caller (o efeito concreto da skill).
   */
  static proposePlanStep(orgId: string, actor: string | undefined, plan: ExecutionPlan, step: ExecutionPlanStep, effect: Omit<SkillEffectInput, "correlationId" | "createdBy" | "skillId" | "capabilityId">): any | null {
    if (plan.status !== "ready" || step.resolution !== "resolved") return null;
    return this.propose(orgId, {
      ...effect,
      skillId: step.resolvedSkillId,
      capabilityId: step.capabilityId,
      correlationId: plan.correlationId,
      createdBy: actor,
    });
  }
}

export default SkillOsExecutionBridge;
