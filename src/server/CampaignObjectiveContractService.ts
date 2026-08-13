import { randomUUID } from "node:crypto";
import db from "./db.js";
import { CAMPAIGN_OBJECTIVES } from "./StudioService.js";
import { BusinessGoalService } from "./BusinessGoalService.js";

/**
 * CampaignObjectiveContractService — Campaign Objective Contract (PRD 11 / ADR-168 F2).
 *
 * Hoje um "objetivo de campanha" (`CAMPAIGN_OBJECTIVES`) é só uma dica de TOM/CTA pra
 * legenda. F2 o transforma num CONTRATO: liga o objetivo a uma MÉTRICA DE META de negócio
 * (`BusinessGoalService`), com um `correlation_id` que o conteúdo produzido sob o contrato
 * carrega (fio ADR-158 → atribuição F9/F12). Assim a campanha nasce amarrada a um RESULTADO
 * DE NEGÓCIO mensurável, não a um like.
 *
 * É AQUI que `ENGAGEMENT ≠ BUSINESS VALUE` (RN-CG-01) começa a valer: objetivos de vaidade
 * (engajamento/alcance/educativo/data) ligam a `goalMetric = null` — o contrato é HONESTO
 * que aquele objetivo não tem métrica de negócio direta, em vez de fingir que engajamento é
 * resultado.
 *
 * Decisões (ADR-168):
 *  - D8 — a meta segue em `business_goals` (§37 — sem 2º modelo de meta); o contrato só a
 *    REFERENCIA por `goal_metric`. Não cria meta; se o dono não definiu alvo, o progresso é
 *    honesto (`goalDefined:false`) — nunca inventa alvo (RN-CG-09).
 *  - O `correlation_id` é o fio: publicações/experimentos futuros o carregam pra atribuir o
 *    resultado ao objetivo (F9/F12).
 *
 * Guardrails: RN-CG-01 (engajamento≠valor), RN-CG-09 (não inventa meta), convenção nº 1
 * (isolamento por org), vocabulário fechado de status (não inventa estado).
 */

// Sugestão de métrica de negócio por objetivo. Objetivos de vaidade → null (honesto).
const SUGGESTED_METRIC: Record<string, string | null> = {
  vendas: "revenue",
  promocao: "revenue",
  reativacao: "revenue",
  agendamento: "appointments",
  engajamento: null,   // vaidade — engajamento não é valor de negócio (RN-CG-01)
  alcance: null,       // vaidade
  educativo: null,     // sem métrica de negócio DIRETA
  data: null,          // vaidade
};

const STATUSES = ["active", "canceled", "achieved"] as const;
type ContractStatus = (typeof STATUSES)[number];

export interface CampaignObjectiveInfo {
  id: string; label: string; guidance: string;
  suggestedMetric: string | null;   // métrica de negócio sugerida (ou null p/ vaidade)
  metricLabel: string | null;
  hasBusinessMetric: boolean;        // false = objetivo de vaidade (RN-CG-01)
}

export interface CampaignObjectiveContract {
  id: string; objectiveId: string; objectiveLabel: string;
  goalMetric: string | null; metricLabel: string | null; hasBusinessMetric: boolean;
  correlationId: string; title: string | null; status: ContractStatus;
  createdBy: string | null; createdAt: string;
}

export class CampaignObjectiveContractService {
  /** Catálogo de objetivos enriquecido com a métrica de negócio sugerida (pra UI). */
  static objectives(): CampaignObjectiveInfo[] {
    const catalog = BusinessGoalService.catalog();
    const labelOf = (m: string | null) => (m ? (catalog.find((c) => c.metric === m)?.label ?? null) : null);
    return CAMPAIGN_OBJECTIVES.map((o) => {
      const suggested = SUGGESTED_METRIC[o.id] ?? null;
      return { id: o.id, label: o.label, guidance: o.guidance, suggestedMetric: suggested, metricLabel: labelOf(suggested), hasBusinessMetric: suggested !== null };
    });
  }

  private static isKnownObjective(objectiveId: string): boolean {
    return CAMPAIGN_OBJECTIVES.some((o) => o.id === objectiveId);
  }

  /**
   * Cria um contrato objetivo→meta. `goalMetric` é OPCIONAL:
   *  - omitido → usa a métrica sugerida do objetivo (que pode ser null = vaidade);
   *  - passado (métrica conhecida) → liga a essa métrica;
   *  - passado como null → força vaidade (sem métrica de negócio).
   * Nunca inventa métrica: valor desconhecido é rejeitado (RN-CG-09).
   */
  static create(orgId: string, actor: string | null, input: { objectiveId: string; goalMetric?: string | null; title?: string | null }): CampaignObjectiveContract {
    if (!orgId) throw new Error("orgId obrigatório");
    const objectiveId = String(input?.objectiveId || "").trim();
    if (!this.isKnownObjective(objectiveId)) throw new Error(`objetivo_desconhecido: ${objectiveId}`);

    let goalMetric: string | null;
    if (input.goalMetric === undefined) {
      goalMetric = SUGGESTED_METRIC[objectiveId] ?? null;
    } else if (input.goalMetric === null) {
      goalMetric = null;
    } else {
      const m = String(input.goalMetric).trim();
      if (!BusinessGoalService.isKnownMetric(m)) throw new Error(`metric_desconhecida: ${m}`);
      goalMetric = m;
    }

    const id = randomUUID();
    const correlationId = `campaign:${id}`;
    db.prepare(
      `INSERT INTO campaign_objective_contracts (id, organization_id, objective_id, goal_metric, correlation_id, title, status, created_by)
       VALUES (?, ?, ?, ?, ?, ?, 'active', ?)`
    ).run(id, orgId, objectiveId, goalMetric, correlationId, input.title ? String(input.title) : null, actor || null);
    return this.get(orgId, id)!;
  }

  private static toView(r: any): CampaignObjectiveContract {
    const obj = CAMPAIGN_OBJECTIVES.find((o) => o.id === r.objective_id);
    const catalog = BusinessGoalService.catalog();
    const metricLabel = r.goal_metric ? (catalog.find((c) => c.metric === r.goal_metric)?.label ?? null) : null;
    return {
      id: r.id, objectiveId: r.objective_id, objectiveLabel: obj?.label ?? r.objective_id,
      goalMetric: r.goal_metric ?? null, metricLabel, hasBusinessMetric: !!r.goal_metric,
      correlationId: r.correlation_id, title: r.title ?? null, status: (r.status || "active") as ContractStatus,
      createdBy: r.created_by ?? null, createdAt: r.created_at,
    };
  }

  static get(orgId: string, id: string): CampaignObjectiveContract | null {
    const r = db.prepare(`SELECT * FROM campaign_objective_contracts WHERE organization_id = ? AND id = ?`).get(orgId, id) as any;
    return r ? this.toView(r) : null;
  }

  static list(orgId: string, opts?: { status?: ContractStatus }): CampaignObjectiveContract[] {
    const rows = opts?.status
      ? db.prepare(`SELECT * FROM campaign_objective_contracts WHERE organization_id = ? AND status = ? ORDER BY created_at DESC`).all(orgId, opts.status)
      : db.prepare(`SELECT * FROM campaign_objective_contracts WHERE organization_id = ? ORDER BY created_at DESC`).all(orgId);
    return (rows as any[]).map((r) => this.toView(r));
  }

  /**
   * Progresso do contrato CONTRA a meta de negócio ligada (distância-à-meta reusando
   * `BusinessGoalService.progress`). Honesto:
   *  - objetivo de vaidade (sem métrica) → `hasBusinessMetric:false` (não há resultado de
   *    negócio a medir — RN-CG-01);
   *  - métrica ligada mas SEM alvo definido pelo dono → `goalDefined:false` (não inventa
   *    alvo — RN-CG-09);
   *  - com alvo → devolve o recorte da meta (target/current/remaining/pace).
   */
  static progress(orgId: string, id: string, opts?: { asOf?: string }): {
    contractId: string; objectiveId: string; goalMetric: string | null; hasBusinessMetric: boolean;
    goalDefined: boolean; goal: any | null; note: string;
  } | null {
    const c = this.get(orgId, id);
    if (!c) return null;
    if (!c.goalMetric) {
      return { contractId: c.id, objectiveId: c.objectiveId, goalMetric: null, hasBusinessMetric: false, goalDefined: false, goal: null, note: "Objetivo sem métrica de negócio direta (engajamento não é resultado)." };
    }
    const prog = BusinessGoalService.progress(orgId, { asOf: opts?.asOf, includeInactive: true });
    const goal = prog.goals.find((g: any) => g.metric === c.goalMetric) || null;
    if (!goal) {
      return { contractId: c.id, objectiveId: c.objectiveId, goalMetric: c.goalMetric, hasBusinessMetric: true, goalDefined: false, goal: null, note: `Meta de ${c.metricLabel || c.goalMetric} ainda não definida pelo dono.` };
    }
    return { contractId: c.id, objectiveId: c.objectiveId, goalMetric: c.goalMetric, hasBusinessMetric: true, goalDefined: true, goal, note: `Rastreando ${c.metricLabel || c.goalMetric}.` };
  }

  /** Cancela um contrato ativo (idempotente-ish: só muda se estava active). */
  static cancel(orgId: string, id: string): boolean {
    const r = db.prepare(`UPDATE campaign_objective_contracts SET status = 'canceled', updated_at = CURRENT_TIMESTAMP WHERE organization_id = ? AND id = ? AND status = 'active'`).run(orgId, id);
    return r.changes > 0;
  }
}

export default CampaignObjectiveContractService;
