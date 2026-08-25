import { MissionService, Mission } from "./MissionService.js";
import { MissionReversePlanner, ReversePlanOpts } from "./MissionReversePlanner.js";
import { MissionRuntimeService, MissionActionRef } from "./MissionRuntimeService.js";
import { CommandExecutorService } from "./CommandExecutorService.js";
import { BusinessGoalService } from "./BusinessGoalService.js";

/**
 * MissionNextStepService — ADR-189 F15 (Mission OS): a PONTE que faltava entre PLANO e RUNTIME.
 *
 * O plano reverso (F3) acha o GARGALO (caminho crítico); o runtime (F5) propõe uma ação GOVERNADA
 * DADO um efeito (domain/actionType/commandType). O elo ausente era quem TRADUZ o gargalo num
 * próximo passo concreto — hoje o operador ainda precisava saber qual `commandType` disparar. É
 * exatamente o norte do PRD (CA-01: "identifica gap e caminho crítico, executa pelo Runtime
 * existente"). Esta camada deriva do gargalo um PRÓXIMO PASSO sugerido e o encaminha SEMPRE pelo
 * caminho governado que já existe.
 *
 * Composição pura (RN-MOL-1/§184 — nenhum motor novo):
 *   - GARGALO           → `MissionReversePlanner.plan` (reusa; não recalcula)
 *   - ALAVANCA REAL     → `CommandExecutorService.canHandle` (grounding: só sugere comando que
 *                          EXISTE de fato; sem handler → honesto "sem ação automatizável")
 *   - IMPACTO restante  → `BusinessGoalService.currentValue` (alvo − atual; NUNCA inventa dinheiro)
 *   - PROPOR            → `MissionRuntimeService.proposeAction` (o choke-point único; honra autonomia)
 *
 * Guardrails RN-MOL: 3 (determinístico — mapa estágio→alavanca + aritmética; LLM fora) ·
 * 1/7 (composição, sem executor/planner paralelo) · 4 (shadow-first: `suggest` é read-only e NÃO
 * escreve nada; `propose` delega ao caminho governado que RECUSA missão em `off`) · 6 (governança
 * intacta — todo efeito via propose→policy→executor) · 5 (RESULTADO ≠ EXECUÇÃO: nunca marca
 * achieved) · nunca inventa (impacto só do alvo conhecido; alavanca só se registrada); isolado por org.
 *
 * HONESTIDADE do mapa: quando o gargalo é uma PREMISSA FALTANTE (ticket/conversão desconhecidos),
 * o próximo passo NÃO é disparar campanha no escuro — é FECHAR a lacuna de conhecimento (uma tarefa
 * governada). Só quando a cadeia fecha com gap quantitativo real a alavanca vira geração de demanda.
 */

const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

export interface MissionNextStepLever {
  commandType: string;
  domain: string;
  actionType: string;
  title: string;
  description: string;
  expectedImpact: number | null;
  impactUnit: "BRL" | "count" | null;
  basis: "hypothesis";
  rationale: string;
  commandPayload: Record<string, any>;
}

export interface MissionNextStep {
  missionId: string;
  suggestable: boolean;
  criticalStage: string | null;
  planNote: string;
  reason: string;
  autonomyReady: boolean;              // a missão já pode PROPOR agora (autonomia ≠ off)?
  lever: MissionNextStepLever | null;
}

// Rótulo humano dos estágios da cadeia (espelha o planner; sem duplicar lógica).
const STAGE_LABEL: Record<string, string> = {
  revenue: "receita",
  sales: "vendas",
  opportunities: "oportunidades",
  contacts: "contatos/base",
};

export class MissionNextStepService {
  /**
   * SHADOW — deriva o próximo passo governado do gargalo, aterrado no que EXISTE. Read-only:
   * não escreve nada, não move a missão. É o "o que eu faço agora?" explicável.
   */
  static suggest(orgId: string, missionId: string, opts: ReversePlanOpts = {}): MissionNextStep {
    const mission = MissionService.get(orgId, missionId);
    if (!mission) throw new Error("Missão não encontrada.");

    const plan = MissionReversePlanner.plan(orgId, missionId, opts);
    const autonomyReady = mission.autonomyLevel !== "off";
    const base = (extra: Partial<MissionNextStep> = {}): MissionNextStep => ({
      missionId, suggestable: false, criticalStage: plan.criticalStage, planNote: plan.note,
      reason: "", autonomyReady, lever: null, ...extra,
    });

    // Sem cadeia numérica (qualitativa / sem alvo) → acompanhamento por marcos, não alavanca automática.
    if (!plan.applicable) {
      return base({ reason: plan.targetMetric === "revenue"
        ? "Defina o valor-alvo (R$) para que o próximo passo possa ser derivado."
        : "Missão sem cadeia numérica — acompanhe por marcos; sem próximo passo automatizável." });
    }

    // Estágio de foco: o gargalo, ou (base já comporta a meta) a ativação da base para converter.
    const stage = plan.criticalStage || (plan.gap && plan.gap.missing === 0 ? "contacts" : null);
    if (!stage) {
      return base({ reason: "Faltam premissas para fechar a cadeia — informe ticket médio e taxas de conversão." });
    }

    // O gargalo é uma PREMISSA FALTANTE? → o próximo passo é FECHAR a lacuna (tarefa governada),
    // nunca disparar campanha no escuro (honestidade do mapa).
    const chainStage = plan.chain.find((s) => s.stage === stage);
    const premiseMissing = chainStage?.basis === "unknown";

    let lever: MissionNextStepLever;
    if (premiseMissing) {
      const commandType = "create_task";
      if (!CommandExecutorService.canHandle(commandType)) {
        return base({ reason: `Registre a premissa faltante (${chainStage?.assumption || STAGE_LABEL[stage] || stage}) para destravar o plano.` });
      }
      lever = {
        commandType, domain: "ops", actionType: "mission_prerequisite",
        title: `Definir premissa do plano: ${STAGE_LABEL[stage] || stage}`,
        description: chainStage?.assumption ? `Registrar ${chainStage.assumption} para completar o planejamento reverso.` : "Registrar a premissa faltante do planejamento reverso.",
        expectedImpact: null, impactUnit: null, basis: "hypothesis",
        rationale: plan.note,
        commandPayload: { missionId, stage, description: chainStage?.assumption || null },
      };
    } else {
      // Gap quantitativo real → alavanca de geração de demanda / conversão (campanha governada).
      const commandType = "prepare_campaign";
      if (!CommandExecutorService.canHandle(commandType)) {
        return base({ reason: "Nenhum comando de campanha registrado — gere demanda manualmente a partir do plano." });
      }
      // Impacto = o que FALTA para a meta (alvo − atual). NUNCA inventa: só com alvo+métrica conhecidos.
      let expectedImpact: number | null = null;
      let impactUnit: "BRL" | "count" | null = null;
      if (mission.targetMetric && mission.targetValue != null) {
        const cur = BusinessGoalService.currentValue(orgId, mission.targetMetric);
        expectedImpact = round2(Math.max(0, mission.targetValue - (cur ?? 0)));
        impactUnit = mission.targetUnit === "count" ? "count" : (mission.targetMetric === "appointments" || mission.targetMetric === "content_leads" ? "count" : "BRL");
      }
      lever = {
        commandType, domain: "commercial", actionType: "mission_campaign",
        title: `Campanha para destravar ${STAGE_LABEL[stage] || stage}`,
        description: `Gerar demanda/conversão no gargalo (${STAGE_LABEL[stage] || stage}) para aproximar a meta.`,
        expectedImpact, impactUnit, basis: "hypothesis",
        rationale: plan.note,
        commandPayload: { missionId, stage, goal: expectedImpact, channel: "whatsapp" },
      };
    }

    return {
      missionId, suggestable: true, criticalStage: stage, planNote: plan.note,
      reason: `Próximo passo derivado do gargalo (${STAGE_LABEL[stage] || stage}).`,
      autonomyReady, lever,
    };
  }

  /**
   * Encaminha o próximo passo sugerido pelo CAMINHO GOVERNADO existente (propose→policy→executor).
   * NÃO escreve `decision_actions` por conta própria — delega ao runtime (que RECUSA missão `off`).
   * Nunca executa efeito externo aqui; nasce awaiting_approval (ou approved pela política).
   */
  static propose(orgId: string, missionId: string, opts: ReversePlanOpts = {}, actor?: string): { mission: Mission; action: MissionActionRef; step: MissionNextStep } {
    const step = this.suggest(orgId, missionId, opts);
    if (!step.suggestable || !step.lever) throw new Error(step.reason || "Sem próximo passo automatizável para esta missão.");
    const l = step.lever;
    const proposed = MissionRuntimeService.proposeAction(orgId, missionId, {
      domain: l.domain, actionType: l.actionType, title: l.title, description: l.description,
      commandType: l.commandType, commandPayload: l.commandPayload,
      expectedImpact: l.expectedImpact, impactUnit: l.impactUnit, basis: l.basis,
    }, actor);
    return { mission: proposed.mission, action: proposed.action, step };
  }
}

export default MissionNextStepService;
