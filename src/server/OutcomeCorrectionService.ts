/**
 * OutcomeCorrectionService — PRD 8 / ADR-165 F10 (§13, D6, RN-OA-9): correção GOVERNADA.
 *
 * Quando a garantia acusa um gap (F6 done-sem-outcome, F7 confirmação estourada), a
 * correção NÃO pode ser um efeito colateral solto: ela passa pela mesma governança de
 * qualquer ação — `DecisionActionService.propose` → `ApprovalPolicyService` (Autonomy
 * Contract) → (quando executar) `CommandExecutorService` (G1/G2/G3). Este serviço só
 * PROPÕE a ação corretiva; NUNCA executa (RN-OA-9). O humano/política decide.
 *
 * Fonte dos gaps: os `business_signals` abertos do domínio `outcome_assurance` (publicados
 * por F6/F7) — não reinventa detecção. Cada gap vira UMA ação corretiva proposta, idempotente
 * (não duplica correção pra a mesma correlação+tipo).
 *
 * GUARDRAILS (RN-OA):
 *   - RN-OA-9 — correção governada: só `propose` (status `awaiting_approval`, salvo auto-allow
 *     configurado pelo dono — e mesmo aí o efeito externo passa pelos guardas do executor).
 *     NUNCA dispara comando direto.
 *   - Idempotente; determinístico; isolado por `organization_id`.
 */
import db from "./db.js";
import { DecisionActionService } from "./DecisionActionService.js";

// Mapa gap → forma da ação corretiva. actionType prefixado `outcome_correction:` pra o
// Reconciler (F6) NÃO tratar a própria correção como novo gap (anti-recursão).
const CORRECTIONS: Record<string, { actionType: string; title: (t: string) => string; description: string }> = {
  done_without_outcome: {
    actionType: "outcome_correction:measure_outcome",
    title: (t) => `Registrar resultado de: ${t || "ação concluída sem medição"}`,
    description: "A ação foi concluída mas não teve outcome medido (gap done_without_outcome). Confirmar o resultado real e registrar a medição.",
  },
  confirmation_timed_out: {
    actionType: "outcome_correction:reconfirm_or_escalate",
    title: (t) => `Reconfirmar ou escalar: ${t || "confirmação vencida"}`,
    description: "O SLA de confirmação estourou (gap confirmation_timed_out). Reconfirmar o efeito com a contraparte ou escalar.",
  },
};

export class OutcomeCorrectionService {
  /**
   * Propõe correções GOVERNADAS para os gaps de garantia abertos. Retorna as ações
   * propostas + quantas foram puladas por já existir correção aberta (idempotência).
   */
  static proposeCorrections(orgId: string, opts: { limit?: number; actorId?: string } = {}): { proposed: any[]; skipped: number } {
    if (!orgId) return { proposed: [], skipped: 0 };
    const limit = Math.min(Math.max(Number(opts.limit) || 100, 1), 500);
    const gaps = db.prepare(
      `SELECT s.id AS signal_id, s.signal_type, s.correlation_id, s.evidence_json,
              a.domain AS action_domain
         FROM business_signals s
         LEFT JOIN decision_actions a ON a.id = s.source_entity_id AND a.organization_id = s.organization_id
        WHERE s.organization_id = ? AND s.domain = 'outcome_assurance' AND s.status = 'open'
        ORDER BY s.detected_at ASC LIMIT ?`
    ).all(orgId, limit) as any[];

    const proposed: any[] = [];
    let skipped = 0;
    for (const g of gaps) {
      const spec = CORRECTIONS[g.signal_type];
      if (!spec) { skipped++; continue; }
      const domain = g.action_domain || "operations";
      const correlationId = g.correlation_id || null;

      // Idempotência: já existe uma correção viva pra esta correlação+tipo? Não duplica.
      if (correlationId) {
        const exists = db.prepare(
          `SELECT 1 FROM decision_actions WHERE organization_id = ? AND correlation_id = ? AND action_type = ? AND status IN ('proposed','awaiting_approval','approved') LIMIT 1`
        ).get(orgId, correlationId, spec.actionType);
        if (exists) { skipped++; continue; }
      }

      const ev = safeParse(g.evidence_json) || {};
      try {
        const action = DecisionActionService.propose(orgId, {
          domain,
          actionType: spec.actionType,
          title: spec.title(ev.title || ""),
          description: spec.description,
          signalId: g.signal_id,
          correlationId: correlationId || undefined,
          basis: "fact",
          createdBy: "rule",
          // SEM commandType: a correção nasce como decisão/tarefa governada; nenhum efeito
          // externo é disparado aqui (RN-OA-9). Se virar comando, é numa fatia própria.
        });
        proposed.push(action);
      } catch { skipped++; /* Autonomy Contract pode negar (deny) — respeitamos a governança */ }
    }
    return { proposed, skipped };
  }
}

function safeParse(s: any): any { try { return JSON.parse(s); } catch { return null; } }

export default OutcomeCorrectionService;
