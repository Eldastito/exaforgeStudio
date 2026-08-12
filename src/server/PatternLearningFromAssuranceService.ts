/**
 * PatternLearningFromAssuranceService — PRD 9 / ADR-166 F1 (§9, RN-EL-1..4).
 *
 * A PRIMEIRA ligação real do ciclo do PRD 9: o resultado ASSEGURADO do PRD 8
 * (`OutcomeAssuranceService`) realimenta o motor de aprendizado único
 * (`PatternMemoryService`). Antes esse fio não existia (grep zero na auditoria F0):
 * o `recordOutcome` só era chamado à mão, e aprendia de qualquer `DONE`.
 *
 * TESE (RN-EL-1 / §9 / CA2): **DONE ≠ EXEMPLO DE SUCESSO.** Só uma ação que subiu a
 * escada até `assured` (efeito confirmado E impacto medido) vira aprendizado FORTE.
 * `executed`/`done_without_outcome`/`impact_measured`-sem-confirmação NÃO ensinam —
 * ficam de fora (no máximo viram candidato fraco no futuro, nunca aqui).
 *
 * COMO liga (sem inventar vínculo): a cadeia canônica já existe —
 *   business_pattern → business_signal (source_entity_type='business_pattern',
 *   source_entity_id = pattern.id, via PatternMemoryService.publishSignals)
 *   → decision_action (signal_id) → action_outcome (realized_value).
 * Este serviço percorre esse fio de trás pra frente: dada uma ação `assured`, acha o
 * sinal de origem; se ele nasceu de um padrão, registra o desfecho NO padrão.
 *
 * GUARDRAILS (RN-EL):
 *   - RN-EL-1 — só `assured` aprende forte (DONE ≠ sucesso).
 *   - RN-EL-3 — determinístico: o desfecho (worked/backfired) sai do valor MEDIDO
 *     (fato), nunca de LLM. Impacto medido < 0 → `backfired`; caso contrário `worked`.
 *   - RN-EL-4 — idempotência: `eventKey='assured:'+actionId` faz reprocessar o mesmo
 *     assured ser no-op (não dobra `acted`). Sweeps repetidos são seguros.
 *   - RN-EL-7 — isolado por `organization_id`; nunca cross-tenant.
 *   - Read-only sobre a FSM do PRD 8 (herda RN-OA-3): NÃO muda estado de ação/processo,
 *     só GRAVA o aprendizado no motor de padrões.
 */
import db from "./db.js";
import { OutcomeAssuranceService } from "./OutcomeAssuranceService.js";
import { PatternMemoryService } from "./PatternMemoryService.js";

export class PatternLearningFromAssuranceService {
  /**
   * Aprende de UMA ação, se (e só se) ela estiver `assured` e tiver nascido de um
   * padrão. Idempotente por `assured:<actionId>`.
   */
  static learnFromAction(orgId: string, actionId: string, actorId?: string): {
    ok: boolean; learned: boolean; idempotent?: boolean; reason?: string;
    assuranceState?: string; patternId?: string; outcome?: string; realizedImpact?: number;
  } {
    if (!orgId || !actionId) return { ok: false, learned: false, reason: "args_invalidos" };

    // 1. Estado de garantia (read-only). Só `assured` ensina forte (RN-EL-1).
    const assess = OutcomeAssuranceService.assessAction(orgId, actionId);
    if (!assess.found) return { ok: true, learned: false, reason: "acao_nao_encontrada" };
    if (assess.assuranceState !== "assured") {
      return { ok: true, learned: false, reason: "nao_assured", assuranceState: assess.assuranceState };
    }

    // 2. Origem: a ação nasceu de um sinal? O sinal nasceu de um padrão?
    const action = db.prepare("SELECT id, signal_id, correlation_id FROM decision_actions WHERE id = ? AND organization_id = ?").get(actionId, orgId) as any;
    if (!action?.signal_id) return { ok: true, learned: false, reason: "sem_sinal_de_origem", assuranceState: "assured" };
    const signal = db.prepare("SELECT source_entity_type, source_entity_id FROM business_signals WHERE id = ? AND organization_id = ?").get(action.signal_id, orgId) as any;
    if (!signal || signal.source_entity_type !== "business_pattern" || !signal.source_entity_id) {
      return { ok: true, learned: false, reason: "sinal_nao_veio_de_padrao", assuranceState: "assured" };
    }
    const patternId: string = signal.source_entity_id;
    const pattern = db.prepare("SELECT id FROM business_patterns WHERE id = ? AND organization_id = ?").get(patternId, orgId) as any;
    if (!pattern) return { ok: true, learned: false, reason: "padrao_ausente", assuranceState: "assured", patternId };

    // 3. Desfecho DETERMINÍSTICO a partir do valor MEDIDO (fato) — nunca LLM (RN-EL-3).
    // Somamos só os outcomes de base `fact` (o assegurado); estimate/influenced não contam
    // como prova de valor realizado (RN-EL-6 fact/estimate/influenced nunca somados aqui).
    const facts = db.prepare("SELECT realized_value FROM action_outcomes WHERE organization_id = ? AND action_id = ? AND basis = 'fact'").all(orgId, actionId) as any[];
    const realizedImpact = facts.reduce((s, r) => s + (Number(r.realized_value) || 0), 0);
    const outcome = realizedImpact < 0 ? "backfired" : "worked";

    // 4. Grava no motor único, com procedência 'assured' e idempotência por ação.
    const res = PatternMemoryService.recordOutcome(orgId, patternId, {
      outcome, realizedImpact, source: "assured",
      eventKey: `assured:${actionId}`,
      correlationId: action.correlation_id ?? null, actionId,
      note: "aprendizado forte a partir de outcome assured (PRD 8 → PRD 9 F1)",
    }, actorId || "system:assurance");

    if (!res.ok) return { ok: false, learned: false, reason: res.error, assuranceState: "assured", patternId };
    return { ok: true, learned: !res.idempotent, idempotent: !!res.idempotent, reason: res.idempotent ? "ja_aprendido" : "aprendido", assuranceState: "assured", patternId, outcome, realizedImpact };
  }

  /** Orgs com o motor de padrões habilitado (o aprendizado só faz sentido nelas). */
  static orgsToLearn(): string[] {
    try {
      return (db.prepare("SELECT organization_id FROM organization_settings WHERE pattern_memory = 1").all() as any[]).map((r) => r.organization_id);
    } catch { return []; }
  }

  /**
   * Varre as ações `done` que nasceram de padrão e têm medição, aprendendo das que
   * estão `assured`. Idempotente (RN-EL-4) — pode rodar em todo passe do Scheduler.
   */
  static sweep(orgId: string, opts: { lookbackDays?: number; limit?: number } = {}): {
    scanned: number; assured: number; learned: number; idempotent: number; skipped: number;
  } {
    const limit = Math.max(1, Math.min(1000, Number(opts.limit) || 200));
    const params: any[] = [orgId];
    let sinceClause = "";
    if (opts.lookbackDays && Number(opts.lookbackDays) > 0) {
      sinceClause = " AND da.completed_at >= datetime('now', ?)";
      params.push(`-${Math.floor(Number(opts.lookbackDays))} days`);
    }
    const rows = db.prepare(
      `SELECT da.id
         FROM decision_actions da
         JOIN business_signals bs ON bs.id = da.signal_id AND bs.organization_id = da.organization_id
        WHERE da.organization_id = ?
          AND da.status = 'done'
          AND bs.source_entity_type = 'business_pattern'
          AND EXISTS (SELECT 1 FROM action_outcomes ao WHERE ao.organization_id = da.organization_id AND ao.action_id = da.id)
          ${sinceClause}
        ORDER BY da.completed_at DESC, da.id ASC
        LIMIT ${limit}`
    ).all(...params) as any[];

    let assured = 0, learned = 0, idempotent = 0, skipped = 0;
    for (const r of rows) {
      const res = this.learnFromAction(orgId, r.id);
      if (res.assuranceState === "assured") assured++;
      if (res.learned) learned++;
      else if (res.idempotent) idempotent++;
      else skipped++;
    }
    return { scanned: rows.length, assured, learned, idempotent, skipped };
  }
}

export default PatternLearningFromAssuranceService;
