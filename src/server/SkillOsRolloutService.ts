import db from "./db.js";
import {
  ROLLOUT_STAGES, RolloutStage, RolloutState, RolloutDecision,
  rolloutStageRank, evaluateRollout,
} from "./skillosModel.js";
import { SkillOsProviderHealthService } from "./SkillOsProviderHealthService.js";

/**
 * SkillOsRolloutService — PRD 4 F12 (§68 canário/rollout + §69 rollback + kill switch +
 * production readiness). Governa ONDE cada skill está na esteira e SE ela se expõe pra
 * uma org — reusando o teto de `execution_mode` da ADR-159 (nunca uma escala paralela)
 * e o kill switch como ÚNICO ponto de corte (sem flag/executor duplicado). O gate de
 * execução real continua no `CommandExecutorService` (G1/G2/G3); aqui é só exposição.
 *
 * Estado em `skillos_rollout` (plataforma, §49). A linha `__global__` = kill switch de
 * plataforma. Cohort de canário é DETERMINÍSTICO e ESTÁVEL (hash puro): subir o
 * percentual só ADICIONA orgs, nunca embaralha quem já entrou.
 *
 * Rollback (§69) de primeira classe, do mais leve ao mais duro:
 *   - `stepDown(skillId)` — desce um degrau na escada (broader→…→development).
 *   - `kill(skillId)` — corta a skill (kill switch por-skill).
 *   - `killAll()` — kill switch de PLATAFORMA (corta o SkillOS inteiro num comando).
 * Tudo reversível (`setStage`/`revive`/`reviveAll`) e aditivo (migration só cria tabela).
 *
 * GUARDRAILS (testados):
 *   - RN-RO-1 REUSA ADR-159: estágio→`execution_mode` existente; `autonomous` NUNCA.
 *   - RN-RO-2 KILL ÚNICO: um kill global desliga tudo; sem 2º caminho.
 *   - RN-RO-3 COHORT ESTÁVEL: mesma (skill,org) sempre no mesmo balde (hash puro).
 *   - RN-RO-4 READINESS DERIVADO (RN-004): regressão/health saem de query, sem contador.
 */

const GLOBAL = "__global__";

export class SkillOsRolloutService {
  private static row(skillId: string): any {
    return db.prepare(`SELECT skill_id, stage, canary_percent, killed FROM skillos_rollout WHERE skill_id = ?`).get(skillId) as any;
  }

  /** Estado de rollout da skill (defaults se nunca configurada: development/0/vivo). */
  static get(skillId: string): RolloutState {
    const r = this.row(skillId);
    return {
      skillId,
      stage: (r?.stage as RolloutStage) || "development",
      canaryPercent: r?.canary_percent != null ? Number(r.canary_percent) : 0,
      killed: !!r?.killed,
    };
  }

  private static upsert(skillId: string, patch: { stage?: RolloutStage; canaryPercent?: number; killed?: boolean }): RolloutState {
    const cur = this.get(skillId);
    const stage = patch.stage ?? cur.stage;
    const canary = patch.canaryPercent != null ? Math.max(0, Math.min(100, Math.floor(patch.canaryPercent))) : cur.canaryPercent;
    const killed = patch.killed != null ? patch.killed : cur.killed;
    db.prepare(`
      INSERT INTO skillos_rollout (skill_id, stage, canary_percent, killed, updated_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(skill_id) DO UPDATE SET stage=excluded.stage, canary_percent=excluded.canary_percent, killed=excluded.killed, updated_at=CURRENT_TIMESTAMP
    `).run(skillId, stage, canary, killed ? 1 : 0);
    return this.get(skillId);
  }

  static setStage(skillId: string, stage: RolloutStage): RolloutState {
    if (!ROLLOUT_STAGES.includes(stage)) throw new Error(`estágio inválido: ${stage}`);
    return this.upsert(skillId, { stage });
  }

  static setCanaryPercent(skillId: string, percent: number): RolloutState {
    if (!Number.isFinite(percent)) throw new Error("canaryPercent inválido");
    return this.upsert(skillId, { canaryPercent: percent });
  }

  /** Rollback leve (§69): desce UM degrau na escada. development é o piso. */
  static stepDown(skillId: string): RolloutState {
    const cur = this.get(skillId);
    const rank = rolloutStageRank(cur.stage);
    const next = ROLLOUT_STAGES[Math.max(0, rank - 1)];
    return this.setStage(skillId, next);
  }

  static kill(skillId: string): RolloutState { return this.upsert(skillId, { killed: true }); }
  static revive(skillId: string): RolloutState { return this.upsert(skillId, { killed: false }); }

  // ── kill switch de PLATAFORMA (§69: "disable SkillOS" num comando) ──
  static killAll(): { globalKilled: boolean } { this.upsert(GLOBAL, { killed: true }); return { globalKilled: true }; }
  static reviveAll(): { globalKilled: boolean } { this.upsert(GLOBAL, { killed: false }); return { globalKilled: false }; }
  static isGloballyKilled(): boolean { return !!this.row(GLOBAL)?.killed; }

  /**
   * DECISÃO de exposição pra (skill, org): live? em que `execution_mode`? por quê?
   * Considera kill global → kill da skill → estágio → cohort de canário.
   */
  static isLiveForOrg(skillId: string, orgId: string): RolloutDecision {
    return evaluateRollout(this.get(skillId), orgId, this.isGloballyKilled());
  }

  /**
   * READINESS operacional do SkillOS (derivada por query — RN-004). Sinaliza o que
   * bloquearia produção: kill switch global, skills em kill, skills com o último eval
   * REGREDIDO (F11) e providers com breaker ABERTO (F5). Sem custo (§30-safe).
   */
  static readiness(): {
    ok: boolean;
    globalKill: boolean;
    killedSkills: string[];
    regressedSkills: string[];
    openProviders: string[];
    issues: string[];
  } {
    const globalKill = this.isGloballyKilled();
    const killedSkills = (db.prepare(`SELECT skill_id FROM skillos_rollout WHERE killed = 1 AND skill_id != ?`).all(GLOBAL) as any[]).map((r) => r.skill_id);

    // Skills cujo ÚLTIMO run de eval regrediu (F11). Deriva o "último" por rowid.
    const regressedSkills = (db.prepare(`
      SELECT r.skill_id FROM skillos_eval_runs r
      JOIN (SELECT skill_id, MAX(rowid) AS last FROM skillos_eval_runs WHERE mode = 'eval' GROUP BY skill_id) m
        ON m.skill_id = r.skill_id AND m.last = r.rowid
      WHERE r.regressed = 1
    `).all() as any[]).map((r) => r.skill_id);

    // Providers com breaker aberto (F5, derivado de ai_usage_log).
    const providers = (db.prepare(`SELECT DISTINCT provider FROM skillos_model_profiles WHERE status != 'disabled'`).all() as any[]).map((r) => r.provider);
    const openProviders = providers.filter((p) => {
      const s = SkillOsProviderHealthService.state(p);
      return s === "open";
    });

    const issues: string[] = [];
    if (globalKill) issues.push("kill switch de plataforma ATIVO — SkillOS desligado.");
    if (killedSkills.length) issues.push(`${killedSkills.length} skill(s) em kill switch.`);
    if (regressedSkills.length) issues.push(`${regressedSkills.length} skill(s) com eval regredido.`);
    if (openProviders.length) issues.push(`${openProviders.length} provider(s) com breaker aberto.`);

    return { ok: issues.length === 0, globalKill, killedSkills, regressedSkills, openProviders, issues };
  }
}

export default SkillOsRolloutService;
