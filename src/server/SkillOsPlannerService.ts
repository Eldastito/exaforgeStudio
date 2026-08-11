import { randomUUID } from "crypto";
import {
  ExecutionPlan,
  ExecutionPlanStep,
  RiskLevel,
  maxRisk,
  deepestProfile,
  validatePlanDeps,
  topoSortSteps,
} from "./skillosModel.js";
import { SkillOsResolverService } from "./SkillOsResolverService.js";

/**
 * SkillOsPlannerService — PRD 4 F7 (§12/§13): o PLANNER.
 *
 * Transforma um objetivo + um conjunto de Capabilities num `ExecutionPlan`: para
 * cada passo, RESOLVE a Capability numa Skill (F3, `SkillOsResolverService`),
 * agrega risco/perfil de contexto e valida as dependências. NÃO EXECUTA (§12) —
 * planeja. O plano é ADVISÓRIO: o gate real (política/aprovação) e a execução são
 * o Execution Bridge (F8), reusando o Execution Runtime/`ProcessRuntimeService`
 * (a projeção `toPlaybook` mostra a ponte, sem persistir).
 *
 * SÍNTESE CONSERVADORA (esta fatia): o caller declara os passos (as Capabilities
 * necessárias + dependências). Decompor um objetivo ABERTO em Capabilities por IA é
 * fatia posterior — aqui é determinístico e reproduzível, como o Resolver começou.
 *
 * GUARDRAILS (testados):
 *   - RN-PLN-1 NÃO EXECUTA (§12): só produz o plano; zero efeito externo.
 *   - RN-PLN-2 RESOLVE POR REGRA: cada passo usa o Resolver (F3), sem IA.
 *   - RN-PLN-3 SEM SILÊNCIO (§65): capability sem skill → passo unresolved + plano
 *     `blocked` + `unresolvedCapabilities` (→ escalada §45), nunca some.
 *   - RN-PLN-4 DEPS VÁLIDAS: dep inexistente / ciclo → `issues` + plano `blocked`.
 *   - RN-PLN-5 FIO (ADR-158): todo plano carrega `correlationId`.
 */

export interface PlanStepInput {
  capabilityId: string;
  dependsOn?: string[];         // stepIds (ver `stepId` gerado: s1, s2, …) OU capabilityId
  stepId?: string;              // opcional; default s{i}
}

export interface PlanInput {
  goal: string;
  intent?: string | null;
  vertical?: string | null;
  correlationId?: string | null;
  maxRisk?: RiskLevel | null;   // teto de risco propagado ao Resolver
  steps: PlanStepInput[];
}

export class SkillOsPlannerService {
  /** Monta o `ExecutionPlan` resolvendo cada Capability e agregando. Determinístico. */
  static plan(orgId: string, user: any, input: PlanInput): ExecutionPlan {
    const goal = String(input?.goal || "").trim();
    const rawSteps = Array.isArray(input?.steps) ? input.steps : [];
    // stepIds determinísticos (s1..sN) quando não informados.
    const idFor = (s: PlanStepInput, i: number) => s.stepId || `s${i + 1}`;
    const idByCap = new Map<string, string>();
    rawSteps.forEach((s, i) => { if (!idByCap.has(s.capabilityId)) idByCap.set(s.capabilityId, idFor(s, i)); });

    const steps: ExecutionPlanStep[] = rawSteps.map((s, i) => {
      const stepId = idFor(s, i);
      // deps podem vir como stepId OU como capabilityId (conveniência) — normaliza.
      const dependsOn = (s.dependsOn || []).map((d) => idByCap.get(d) || d);
      const res = SkillOsResolverService.resolve(orgId, user, { capabilityId: s.capabilityId, vertical: input.vertical, maxRisk: input.maxRisk });
      return {
        stepId,
        capabilityId: s.capabilityId,
        dependsOn,
        resolvedSkillId: res.resolved ? res.skill!.skillId : null,
        resolution: res.resolved ? "resolved" : "unresolved",
        reason: res.reason,
        riskLevel: res.resolved ? (res.skill!.riskLevel as RiskLevel) : null,
        requiredContextProfile: res.resolved ? (res.skill!.requiredContextProfile ?? null) : null,
      };
    });

    const issues = validatePlanDeps(steps);
    const unresolvedCapabilities = steps.filter((s) => s.resolution === "unresolved").map((s) => s.capabilityId);
    const status = unresolvedCapabilities.length === 0 && issues.length === 0 ? "ready" : "blocked";

    return {
      planId: randomUUID(),
      correlationId: input.correlationId || randomUUID(),
      goal,
      intent: input.intent ?? null,
      steps,
      riskLevel: maxRisk(steps.map((s) => s.riskLevel)),
      requiredContextProfile: deepestProfile(steps.map((s) => s.requiredContextProfile)),
      status,
      unresolvedCapabilities,
      issues,
    };
  }

  /**
   * Projeta o plano na forma do `PlaybookEngine`/`ProcessRuntime` (a PONTE de
   * reuso pro F8): passos em ordem topológica, encadeados por `next`, cada um um
   * `command_type` `skillos:{skillId}` que o CommandExecutor resolverá. NÃO persiste
   * nem executa — só mostra o mapeamento. Plano com passo unresolved não é projetável.
   */
  static toPlaybook(plan: ExecutionPlan): { startStep: string | null; steps: Array<{ id: string; commandType: string; onFailure: string; next: string }> } {
    const ordered = topoSortSteps(plan.steps);
    const steps = ordered.map((s, i) => ({
      id: s.stepId,
      commandType: s.resolvedSkillId ? `skillos:${s.resolvedSkillId}` : `unresolved:${s.capabilityId}`,
      onFailure: "escalate",
      next: i < ordered.length - 1 ? ordered[i + 1].stepId : "$end",
    }));
    return { startStep: steps.length ? steps[0].id : null, steps };
  }
}

export default SkillOsPlannerService;
