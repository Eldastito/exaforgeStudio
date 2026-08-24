import db from "./db.js";
import { MissionService, Mission } from "./MissionService.js";
import { DecisionActionService } from "./DecisionActionService.js";

/**
 * MissionRuntimeService — ADR-189 F5 (Mission OS): a PONTE missão → execução GOVERNADA.
 *
 * O elo mais sensível. A regra é ABSOLUTA (D2/§71/ADR-159): uma missão NUNCA executa um efeito
 * empresarial direto. O efeito vira uma AÇÃO PROPOSTA (`DecisionActionService.propose`, que resolve
 * a política de aprovação + Autonomy Contract) e só roda pelo CHOKE-POINT ÚNICO já existente
 * (`CommandExecutorService`, com as guardas). Este serviço NÃO tem sink próprio — ele APENAS
 * encaminha pro caminho que já existe (espelha o `SkillOsExecutionBridge`). Um executor de missão
 * paralelo reabriria o buraco que a ADR-159 fechou.
 *
 * Liga a ação à missão por `correlation_id = 'mission:<id>'` (aditivo, sem coluna nova). Move o
 * status da missão conforme a governança (waiting_approval × running). RESULTADO ≠ EXECUÇÃO (D7):
 * propor/executar NUNCA marca a missão como `achieved` — isso é do outcome confirmado (F6+).
 *
 * Guardrails RN-MOL: 6 (governança intacta — todo efeito via propose→policy→executor) ·
 * 4 (shadow-first: missão off/shadow NÃO propõe efeito) · 7 (reusa; sem executor paralelo) ·
 * isolamento por org; determinístico; nunca inventa.
 */

const missionCorrelation = (missionId: string) => `mission:${missionId}`;

export interface MissionEffectInput {
  domain: string;
  actionType: string;
  title: string;
  description?: string | null;
  commandType?: string | null;
  commandPayload?: any;
  expectedImpact?: number | null;
  impactUnit?: string | null;
  basis?: string;
  confidence?: number | null;
}

export interface MissionActionRef { id: string; domain: string; actionType: string; title: string; status: string; correlationId: string | null }

export class MissionRuntimeService {
  /**
   * Propõe um efeito da missão como AÇÃO GOVERNADA. Nunca executa (nasce awaiting_approval, ou
   * approved se o Autonomy Contract do dono já permitir — mas o efeito externo ainda passa pelos
   * guardas do executor). Missão em `off` NÃO propõe (shadow-first, RN-MOL-4).
   */
  static proposeAction(orgId: string, missionId: string, effect: MissionEffectInput, actor?: string): { mission: Mission; action: MissionActionRef } {
    const mission = MissionService.get(orgId, missionId);
    if (!mission) throw new Error("Missão não encontrada.");
    if (mission.autonomyLevel === "off") throw new Error("Missão em autonomia 'off' não propõe ações — ligue ao menos 'shadow'/'suggest' primeiro.");
    if (!effect?.domain || !effect?.actionType || !String(effect?.title || "").trim()) throw new Error("Efeito exige domain, actionType e title.");

    const proposed = DecisionActionService.propose(orgId, {
      domain: effect.domain,
      actionType: effect.actionType,
      title: String(effect.title).trim(),
      description: effect.description || null,
      commandType: effect.commandType || null,
      commandPayload: effect.commandPayload,
      expectedImpact: effect.expectedImpact ?? null,
      impactUnit: effect.impactUnit || null,
      basis: effect.basis || "hypothesis",
      confidence: effect.confidence ?? null,
      correlationId: missionCorrelation(missionId),   // liga a ação à missão (ADR-158)
    });

    // Governança manda no status da missão: aguardando aprovação × em andamento.
    const awaiting = proposed.status === "awaiting_approval";
    if (mission.status === "draft" || mission.status === "planning" || mission.status === "ready" || mission.status === "waiting_approval" || mission.status === "running") {
      MissionService.setStatus(orgId, missionId, awaiting ? "waiting_approval" : "running", actor);
    }

    const action: MissionActionRef = { id: proposed.id, domain: proposed.domain, actionType: proposed.action_type, title: proposed.title, status: proposed.status, correlationId: proposed.correlation_id };
    return { mission: MissionService.get(orgId, missionId)!, action };
  }

  /** Ações governadas ligadas à missão (por correlation_id). Read-only. */
  static actions(orgId: string, missionId: string): MissionActionRef[] {
    try {
      const rows = db.prepare(`
        SELECT id, domain, action_type, title, status, correlation_id
        FROM decision_actions WHERE organization_id = ? AND correlation_id = ?
        ORDER BY created_at DESC
      `).all(orgId, missionCorrelation(missionId)) as any[];
      return rows.map((r) => ({ id: r.id, domain: r.domain, actionType: r.action_type, title: r.title, status: r.status, correlationId: r.correlation_id }));
    } catch { return []; }
  }

  /** Visão de execução da missão (contagens derivadas). RESULTADO ≠ EXECUÇÃO: não infere achieved. */
  static runtime(orgId: string, missionId: string): { missionId: string; status: string; humanStatus: string; actions: MissionActionRef[]; counts: { proposed: number; awaitingApproval: number; approved: number; done: number } } {
    const mission = MissionService.get(orgId, missionId);
    if (!mission) throw new Error("Missão não encontrada.");
    const actions = this.actions(orgId, missionId);
    const counts = {
      proposed: actions.length,
      awaitingApproval: actions.filter((a) => a.status === "awaiting_approval").length,
      approved: actions.filter((a) => a.status === "approved").length,
      done: actions.filter((a) => a.status === "done").length,
    };
    return { missionId, status: mission.status, humanStatus: mission.humanStatus, actions, counts };
  }
}

export default MissionRuntimeService;
