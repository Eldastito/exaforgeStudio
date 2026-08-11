import db from "./db.js";
import { randomUUID } from "crypto";
import {
  EvalCase, EvalCaseScore, EvalResult, EVAL_SCORERS, EvalScorer,
  scoreEvalCase, aggregateEval, detectRegression,
} from "./skillosModel.js";

/**
 * SkillOsEvalService — PRD 4 F11 (§59 Evals + Shadow). O HARNESS de avaliação
 * DETERMINÍSTICO do SkillOS: casos de eval por skill + scorer puro (P7) + gate de
 * regressão simples + shadow (candidata×atual, SEM efeito). CRIAR só o scorer —
 * "sem plataforma de ML" (auditoria). ESTENDE a convenção `scripts/test-*` (o eval
 * roda na CI sem chave de IA) reusando `firstGoldenDiff`/golden do PRD 3.
 *
 * Determinismo (por que roda na CI): o candidato de cada caso vem GRAVADO
 * (`recordedOutput`, replay golden) OU de um `invoke` injetado (mesma técnica
 * testável do Kernel F4) — NUNCA um provider real embutido. Um eval "ao vivo" contra
 * modelo real é opt-in futuro (custa dinheiro + chave); o núcleo aqui é puro.
 *
 * Escopo de PLATAFORMA (§49): `skillos_eval_cases`/`skillos_eval_runs` NÃO têm
 * organization_id — "o que é uma boa saída da skill X" é config da skill (global
 * desde a F2), não de tenant. Por isso a regressão NÃO vira `business_signals` (que
 * é por-org e de OPERAÇÃO do tenant, convenção #12): um skill que regride é evento
 * de PLATAFORMA — fica no `skillos_eval_runs.regressed` + rota de admin. Forçar num
 * ledger por-org seria violar a própria convenção.
 *
 * GUARDRAILS (testados):
 *   - RN-EV-1 DETERMINÍSTICO (P7): scorer puro; sem LLM-juiz; roda sem chave.
 *   - RN-EV-2 GATE simples: regrediu = passRate caiu OU caso que passava falhou.
 *   - RN-EV-3 SHADOW SEM EFEITO: compara notas; nunca chama CommandExecutor/propose.
 *   - RN-EV-4 SEM SINAL POR-ORG: regressão é de plataforma; não polui business_signals.
 */

export type SkillInvoke = (input: any) => any | Promise<any>;

function rowToCase(r: any): EvalCase {
  return {
    caseId: r.case_id,
    skillId: r.skill_id,
    name: r.name,
    scorer: r.scorer,
    input: safeParse(r.input_json, null),
    expected: r.expected_json != null ? safeParse(r.expected_json, undefined) : undefined,
    fieldPath: r.field_path ?? undefined,
    recordedOutput: r.recorded_output_json != null ? safeParse(r.recorded_output_json, undefined) : undefined,
    weight: r.weight ?? 1,
  };
}
function safeParse(s: any, dflt: any) { try { return s == null ? dflt : JSON.parse(s); } catch { return dflt; } }

export class SkillOsEvalService {
  // ═══════════════ registro de casos ═══════════════
  /** Upsert idempotente de um caso de eval (validado). Retorna o caso canônico. */
  static registerCase(input: {
    caseId?: string; skillId: string; name: string; scorer: EvalScorer;
    input?: any; expected?: any; fieldPath?: string; recordedOutput?: any; weight?: number;
  }): EvalCase {
    if (!input?.skillId) throw new Error("eval case exige skillId.");
    if (!input?.name) throw new Error("eval case exige name.");
    if (!EVAL_SCORERS.includes(input.scorer)) throw new Error(`scorer inválido: ${input.scorer}`);
    if ((input.scorer === "exact" || input.scorer === "json_subset" || input.scorer === "field_equals") && input.expected === undefined) {
      throw new Error(`scorer '${input.scorer}' exige 'expected'.`);
    }
    if (input.scorer === "field_equals" && !input.fieldPath) throw new Error("scorer 'field_equals' exige 'fieldPath'.");

    const caseId = input.caseId || `evc_${randomUUID().slice(0, 12)}`;
    const weight = input.weight && input.weight > 0 ? input.weight : 1;
    db.prepare(`
      INSERT INTO skillos_eval_cases (case_id, skill_id, name, scorer, input_json, expected_json, field_path, recorded_output_json, weight, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(case_id) DO UPDATE SET
        skill_id=excluded.skill_id, name=excluded.name, scorer=excluded.scorer, input_json=excluded.input_json,
        expected_json=excluded.expected_json, field_path=excluded.field_path,
        recorded_output_json=excluded.recorded_output_json, weight=excluded.weight, updated_at=CURRENT_TIMESTAMP
    `).run(
      caseId, input.skillId, input.name, input.scorer,
      JSON.stringify(input.input ?? null),
      input.expected === undefined ? null : JSON.stringify(input.expected),
      input.fieldPath ?? null,
      input.recordedOutput === undefined ? null : JSON.stringify(input.recordedOutput),
      weight,
    );
    return this.getCase(caseId)!;
  }

  static getCase(caseId: string): EvalCase | null {
    const r = db.prepare(`SELECT * FROM skillos_eval_cases WHERE case_id = ?`).get(caseId) as any;
    return r ? rowToCase(r) : null;
  }

  static listCases(skillId: string, opts: { includeDisabled?: boolean } = {}): EvalCase[] {
    const sql = opts.includeDisabled
      ? `SELECT * FROM skillos_eval_cases WHERE skill_id = ? ORDER BY name ASC`
      : `SELECT * FROM skillos_eval_cases WHERE skill_id = ? AND status = 'active' ORDER BY name ASC`;
    return (db.prepare(sql).all(skillId) as any[]).map(rowToCase);
  }

  static setCaseStatus(caseId: string, status: "active" | "disabled"): { ok: boolean } {
    const r = db.prepare(`UPDATE skillos_eval_cases SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE case_id = ?`).run(status, caseId);
    return { ok: r.changes > 0 };
  }

  // ═══════════════ execução do eval ═══════════════
  /**
   * Baseline = último run de EVAL registrado pra skill (passRate + ids que passaram).
   * rowid DESC desempata runs do mesmo segundo (created_at tem precisão de segundo).
   */
  static baselineFor(skillId: string): { passRate: number; passedCaseIds: string[] } | null {
    const r = db.prepare(
      `SELECT pass_rate, passed_case_ids_json FROM skillos_eval_runs
       WHERE skill_id = ? AND mode = 'eval' ORDER BY rowid DESC LIMIT 1`
    ).get(skillId) as any;
    if (!r) return null;
    return { passRate: Number(r.pass_rate) || 0, passedCaseIds: safeParse(r.passed_case_ids_json, []) };
  }

  /** Resolve o candidato de um caso: recordedOutput (replay) OU invoke injetado. */
  private static async candidateFor(c: EvalCase, invoke?: SkillInvoke): Promise<any> {
    if (c.recordedOutput !== undefined) return c.recordedOutput;
    if (invoke) return await invoke(c.input);
    return undefined;                    // scoreEvalCase marca "sem candidato" → falha
  }

  private static async scoreCases(cases: EvalCase[], invoke?: SkillInvoke, predicate?: (candidate: any, c: EvalCase) => boolean): Promise<EvalCaseScore[]> {
    const scores: EvalCaseScore[] = [];
    for (const c of cases) scores.push(scoreEvalCase(c, await this.candidateFor(c, invoke), predicate));
    return scores;
  }

  /**
   * Roda o eval dos casos ATIVOS da skill, agrega, compara ao baseline, PERSISTE o run
   * e devolve o resultado com `regressed`. Determinístico quando os casos têm
   * `recordedOutput` (ou o `invoke` injetado é determinístico).
   */
  static async run(skillId: string, opts: { invoke?: SkillInvoke; promptVersion?: string | null; predicate?: (candidate: any, c: EvalCase) => boolean } = {}): Promise<EvalResult> {
    const cases = this.listCases(skillId);
    const scores = await this.scoreCases(cases, opts.invoke, opts.predicate);
    const result = aggregateEval(skillId, opts.promptVersion ?? null, scores);
    const baseline = this.baselineFor(skillId);      // lê ANTES de inserir o run atual
    result.regressed = detectRegression(result, baseline);
    this.persistRun(result, "eval");
    return result;
  }

  private static persistRun(result: EvalResult, mode: "eval" | "shadow"): void {
    const passedIds = result.scores.filter((s) => s.passed).map((s) => s.caseId);
    db.prepare(`
      INSERT INTO skillos_eval_runs (id, skill_id, prompt_version, total, passed, failed, pass_rate, regressed, passed_case_ids_json, mode)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(), result.skillId, result.promptVersion ?? null, result.total, result.passed, result.failed,
      result.passRate, result.regressed ? 1 : 0, JSON.stringify(passedIds), mode,
    );
  }

  /** Último run registrado (default modo eval). */
  static lastRun(skillId: string, mode: "eval" | "shadow" = "eval"): any | null {
    return db.prepare(
      `SELECT * FROM skillos_eval_runs WHERE skill_id = ? AND mode = ? ORDER BY rowid DESC LIMIT 1`
    ).get(skillId, mode) as any || null;
  }

  // ═══════════════ shadow (candidata × atual, SEM efeito) ═══════════════
  /**
   * Roda a implementação ATUAL e uma CANDIDATA contra os mesmos casos e DIFA as notas.
   * NENHUM efeito: só pontua saídas — nunca chama propose/CommandExecutor (RN-EV-3).
   * Persiste um run mode='shadow' pra a candidata (observabilidade), sem virar baseline
   * do eval (baselineFor só olha mode='eval'). Devolve as duas notas + o diff por caso.
   */
  static async shadow(skillId: string, currentInvoke: SkillInvoke, candidateInvoke: SkillInvoke, opts: { candidatePromptVersion?: string | null; predicate?: (candidate: any, c: EvalCase) => boolean } = {}): Promise<{
    current: EvalResult; candidate: EvalResult;
    diff: { passRateDelta: number; improvedCaseIds: string[]; regressedCaseIds: string[]; unchanged: number };
  }> {
    const cases = this.listCases(skillId);
    const curScores = await this.scoreCases(cases, currentInvoke, opts.predicate);
    const candScores = await this.scoreCases(cases, candidateInvoke, opts.predicate);
    const current = aggregateEval(skillId, null, curScores);
    const candidate = aggregateEval(skillId, opts.candidatePromptVersion ?? null, candScores);

    const curPass = new Map(curScores.map((s) => [s.caseId, s.passed]));
    const improvedCaseIds: string[] = [];
    const regressedCaseIds: string[] = [];
    let unchanged = 0;
    for (const s of candScores) {
      const was = curPass.get(s.caseId) ?? false;
      if (s.passed && !was) improvedCaseIds.push(s.caseId);
      else if (!s.passed && was) regressedCaseIds.push(s.caseId);
      else unchanged++;
    }
    this.persistRun(candidate, "shadow");
    return { current, candidate, diff: { passRateDelta: candidate.passRate - current.passRate, improvedCaseIds, regressedCaseIds, unchanged } };
  }

  // ═══════════════ sweep (pronto p/ um passe de Scheduler futuro) ═══════════════
  /**
   * Roda o eval de toda skill que tenha ao menos um caso ATIVO com `recordedOutput`
   * (i.e. suíte 100% determinística — não precisa de invoke/modelo). Best-effort por
   * skill. Um passe de Scheduler pode hospedar isto no futuro (auditoria §2.7); a F11
   * NÃO liga o Scheduler (evita dependência de modelo ao vivo + 0 regressão).
   */
  static async runAll(): Promise<{ skills: number; runs: number; regressions: number }> {
    const skillIds = (db.prepare(
      `SELECT DISTINCT skill_id FROM skillos_eval_cases WHERE status = 'active' AND recorded_output_json IS NOT NULL`
    ).all() as any[]).map((r) => r.skill_id);
    let runs = 0, regressions = 0;
    for (const skillId of skillIds) {
      try {
        const r = await this.run(skillId);
        runs++;
        if (r.regressed) regressions++;
      } catch (e) {
        console.error("[SkillOsEvalService] runAll: erro na skill", skillId, e);
      }
    }
    return { skills: skillIds.length, runs, regressions };
  }
}

export default SkillOsEvalService;
