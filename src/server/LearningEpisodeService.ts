/**
 * LearningEpisodeService — PRD 9 / ADR-166 F3 (§9, D5, RN-EL-1..8).
 *
 * Um "Learning Episode" é o FIO do aprendizado observável ponta-a-ponta: um padrão,
 * os desfechos que o ensinaram (o ledger `business_pattern_outcomes` da F1) e o
 * ESTADO DE APRENDIZADO derivado disso. Responde à pergunta que a auditoria F0 deixou
 * em aberto: "o que este padrão aprendeu, e com que prova?".
 *
 * É um READ MODEL 100% DERIVADO por query (RN-004): NÃO cria tabela, NÃO escreve, NÃO
 * muda a FSM nem o `status` do padrão (D5 — estado derivado, não persistido). Compõe o
 * que já existe: `business_patterns` + `business_pattern_type_stats` (misto) +
 * `PatternMemoryService.assuredStats` (recorte assured, F2) + o ledger por-evento (F1).
 *
 * GUARDRAILS:
 *   - RN-EL-1 — só o recorte `assured` define aprendizado FORTE; o misto é contexto.
 *   - RN-EL-3 — `learningState` é DETERMINÍSTICO (limiar sobre a eficácia assegurada),
 *     nunca LLM.
 *   - RN-EL-5 — sem prova assegurada → `unproven` (null ≠ zero; DONE ≠ exemplo). Nunca
 *     declara sucesso/fracasso sem evidência.
 *   - RN-EL-2 — `suggestedRefutation` é HIPÓTESE/EVIDÊNCIA (fecha o achado (c): o estado
 *     `refuted` existe no schema mas nunca é atribuído). Aqui SUGERE quando a prova
 *     assegurada contradiz; NÃO escreve `refuted` — isso seria ordem, não evidência.
 *   - RN-EL-7 — isolado por `organization_id`.
 */
import db from "./db.js";
import { PatternMemoryService } from "./PatternMemoryService.js";

// Limiares DETERMINÍSTICOS do estado de aprendizado (sobre a eficácia ASSEGURADA).
const REINFORCED_AT = 0.66;   // assured effectiveness alta → reforçado
const WEAKENED_AT = 0.34;     // assured effectiveness baixa → enfraquecido
const MIN_ASSURED_FOR_REFUTE = 2; // nº mínimo de desfechos assured p/ sugerir refutação

export class LearningEpisodeService {
  /**
   * Episódio de UM padrão: pattern + prova (misto × assured) + desfechos + estado
   * derivado. Read-only.
   */
  static episode(orgId: string, patternId: string, opts: { outcomesLimit?: number } = {}): any {
    if (!orgId || !patternId) return { found: false };
    const p = db.prepare("SELECT * FROM business_patterns WHERE id = ? AND organization_id = ?").get(patternId, orgId) as any;
    if (!p) return { found: false, patternId };

    const mixed = PatternMemoryService.typeStats(orgId, p.domain, p.pattern_type); // pode ser null (nunca agiu)
    const assured = PatternMemoryService.assuredStats(orgId, p.domain, p.pattern_type);

    const limit = Math.max(1, Math.min(200, Number(opts.outcomesLimit) || 50));
    const outcomes = (db.prepare(
      `SELECT id, outcome, realized_impact, source, correlation_id, action_id, note, created_at
         FROM business_pattern_outcomes WHERE organization_id = ? AND pattern_id = ?
        ORDER BY created_at DESC, id ASC LIMIT ${limit}`
    ).all(orgId, patternId) as any[]).map((o) => ({
      id: o.id, outcome: o.outcome, realizedImpact: Number(o.realized_impact) || 0,
      source: o.source, correlationId: o.correlation_id ?? null, actionId: o.action_id ?? null,
      note: o.note ?? null, at: o.created_at,
    }));

    const derived = this.deriveState(assured);

    return {
      found: true,
      pattern: {
        id: p.id, domain: p.domain, patternType: p.pattern_type, patternKey: p.pattern_key,
        description: p.description, confidence: Number(p.confidence), status: p.status,
        occurrences: Number(p.occurrences), firstSeen: p.first_seen_date, lastSeen: p.last_seen_date,
      },
      learning: {
        mixed: mixed ? { acted: mixed.acted, worked: mixed.worked, no_effect: mixed.no_effect, backfired: mixed.backfired, effectiveness: mixed.effectiveness } : null,
        assured: { assuredActed: assured.assuredActed, worked: assured.worked, no_effect: assured.no_effect, backfired: assured.backfired, netImpact: assured.netImpact, assuredEffectiveness: assured.assuredEffectiveness, workedRate: assured.workedRate, interval: assured.interval, confidence: assured.confidence },
        hasAssuredEvidence: assured.assuredActed > 0,
      },
      outcomes,
      derived,
      note: "Read model DERIVADO (RN-004/D5): não muda status/FSM. Aprendizado forte = recorte assured (RN-EL-1). suggestedRefutation é evidência, não ordem (RN-EL-2).",
    };
  }

  /**
   * Estado de aprendizado DETERMINÍSTICO a partir do recorte ASSEGURADO:
   *   - assuredActed 0            → 'unproven'  (sem prova; DONE ≠ exemplo — RN-EL-5)
   *   - assuredEffectiveness alta → 'reinforced'
   *   - baixa                     → 'weakened'  (e sugere refutação se backfired domina)
   *   - intermediária             → 'contested'
   */
  private static deriveState(assured: { assuredActed: number; worked: number; backfired: number; assuredEffectiveness: number | null }): any {
    if (assured.assuredActed === 0) {
      return { learningState: "unproven", suggestedRefutation: false, rationale: "Sem desfecho assegurado — nenhuma prova forte de que funciona (DONE ≠ exemplo)." };
    }
    const eff = assured.assuredEffectiveness ?? 0;
    let learningState: string;
    if (eff >= REINFORCED_AT) learningState = "reinforced";
    else if (eff <= WEAKENED_AT) learningState = "weakened";
    else learningState = "contested";
    // Achado (c): sugere 'refuted' quando a prova assegurada CONTRADIZ (backfired domina).
    // É SUGESTÃO (evidência), não escrita — RN-EL-2. A promoção a refuted, se houver, é
    // decisão governada, nunca automática aqui.
    const suggestedRefutation = assured.assuredActed >= MIN_ASSURED_FOR_REFUTE && assured.backfired > assured.worked;
    const rationale = suggestedRefutation
      ? `Prova assegurada contradiz o padrão (backfired ${assured.backfired} > worked ${assured.worked} em ${assured.assuredActed} desfechos) — sugere revisão/refutação.`
      : `Eficácia assegurada ${eff} sobre ${assured.assuredActed} desfecho(s) → ${learningState}.`;
    return { learningState, suggestedRefutation, rationale };
  }

  /**
   * Lista episódios (resumo) dos padrões da org. Filtra por domínio/status; `onlyAssured`
   * restringe aos que já têm prova assegurada (aprendizado forte). Read-only.
   */
  static episodes(orgId: string, opts: { domain?: string; status?: string; onlyAssured?: boolean; limit?: number } = {}): any {
    if (!orgId) return { episodes: [] };
    const patterns = PatternMemoryService.list(orgId, { domain: opts.domain, status: opts.status });
    const limit = Math.max(1, Math.min(500, Number(opts.limit) || 100));
    const out: any[] = [];
    for (const p of patterns) {
      const assured = PatternMemoryService.assuredStats(orgId, p.domain, p.pattern_type);
      if (opts.onlyAssured && assured.assuredActed === 0) continue;
      const derived = this.deriveState(assured);
      out.push({
        patternId: p.id, domain: p.domain, patternType: p.pattern_type,
        description: p.description, confidence: Number(p.confidence), status: p.status,
        assuredEffectiveness: assured.assuredEffectiveness, assuredActed: assured.assuredActed,
        learningState: derived.learningState, suggestedRefutation: derived.suggestedRefutation,
      });
      if (out.length >= limit) break;
    }
    // Ordena: refutação sugerida primeiro (mais urgente de revisar), depois com mais prova.
    out.sort((a, b) => (Number(b.suggestedRefutation) - Number(a.suggestedRefutation)) || (b.assuredActed - a.assuredActed));
    return { count: out.length, episodes: out, note: "Read model derivado (RN-004). onlyAssured filtra os com prova forte." };
  }
}

export default LearningEpisodeService;
