import db from "./db.js";
import { SkillOsProviderHealthService } from "./SkillOsProviderHealthService.js";
import { RELIABILITY_STATUSES, FAILURE_CLASSES } from "./skillosModel.js";

/**
 * SkillOsObservabilityService — PRD 4 F9 (§17 observabilidade + §29/§30 privacidade
 * de custo). LEITURA da saúde OPERACIONAL das AI Runs pro TENANT (gestor), na Central
 * de Saúde. Tudo DERIVADO por query (RN-004) das linhas ricas de `ai_usage_log`
 * (as AI Runs da F4, `run_id IS NOT NULL`) — NENHUMA tabela/contador novo, NENHUM
 * dashboard paralelo (ESTENDE a Central existente).
 *
 * ═══ INVARIANTE §30 / Decisão D5 (privacidade de custo) ═══
 * O custo FINANCEIRO (R$/US$, centavos, tokens-como-proxy-de-custo) é visível APENAS
 * pro Admin Master (`AiUsageDashboardService` sob `requireMasterAdmin`). A visão de
 * observabilidade do TENANT carrega SÓ o que é operacional: contagens/taxas de
 * status, grounding, validação, confiança e saúde de provider — jamais dinheiro.
 *
 * Antes o §30 era atendido "por construção" (o serviço de custo já era admin-only).
 * A F9 FORMALIZA isso como um GUARDA em runtime (`assertTenantSafe`): mesmo que um dev
 * futuro plugue por engano um payload com custo numa rota de tenant, o guarda LANÇA.
 * `aiRuns()` se auto-guarda antes de devolver — defesa em profundidade, não só teste.
 *
 * GUARDRAILS (testados):
 *   - RN-OBS-1 DERIVADO (RN-004): tudo sai de query sobre `ai_usage_log`; sem contador.
 *   - RN-OBS-2 §30/D5: payload de tenant NUNCA carrega custo (guarda + auto-check).
 *   - RN-OBS-3 SÓ AI RUN: agrega apenas linhas com `run_id` (ignora legado do
 *     `recordUsage` do llm.ts, que grava sem os campos ricos) — sem falso zero.
 *   - RN-OBS-4 REUSA: saúde de provider vem do `SkillOsProviderHealthService` (F5),
 *     não reimplementa o circuit breaker.
 *   - RN-OBS-5 ISOLAMENTO: todo WHERE filtra `organization_id` (§1).
 */

// Fragmentos de chave que denotam custo FINANCEIRO (ou proxy direto dele). Qualquer
// chave que contenha um destes é proibida no payload de tenant (§30). `token` entra
// porque tokens mapeiam ~linearmente em R$ — proxy de custo, fora da visão do gestor.
const COST_KEY_FRAGMENTS = ["cost", "brl", "usd", "cents", "price", "spend", "bill", "token", "dollar", "reais", "monetary"];

function isCostKey(key: string): boolean {
  const k = key.toLowerCase();
  return COST_KEY_FRAGMENTS.some((frag) => k.includes(frag));
}

export interface AiRunsObservability {
  windowDays: number;
  totalRuns: number;
  byStatus: Record<string, number>;        // ok | retried | fallback | blocked | failed
  byValidation: Record<string, number>;    // valid | invalid | skipped
  byGrounding: Record<string, number>;     // grounded | unsupported | skipped
  byFailureClass: Record<string, number>;  // technical | format | grounding | policy | execution | outcome
  fallbackCount: number;
  fallbackRate: number;                     // 0..1
  retriedCount: number;
  blockedCount: number;
  failedCount: number;
  successRate: number;                      // (ok + retried) / total, 0..1
  avgConfidence: number | null;             // média de confidence (0..1), null se nenhuma run tem
  topSkills: Array<{ skillId: string; runs: number; failures: number; fallbacks: number }>;
  providers: Array<{ provider: string; total: number; failed: number; ok: number; failureRate: number; state: string }>;
}

export class SkillOsObservabilityService {
  static clampDays(days?: number): number {
    const raw = Number(days);
    if (!Number.isFinite(raw)) return 30;
    return Math.max(1, Math.min(180, Math.floor(raw)));
  }

  /**
   * GUARDA §30/D5: rejeita (lança) se `obj` carregar QUALQUER chave de custo
   * financeiro, em qualquer profundidade. Puro e reutilizável — é o invariante
   * testável que a Decisão D5 pede (codificado, não só plumbing). Devolve `obj`
   * pra encadear (`return assertTenantSafe(payload)`).
   */
  static assertTenantSafe<T>(obj: T, path = "$"): T {
    const walk = (v: any, p: string) => {
      if (v === null || typeof v !== "object") return;
      if (Array.isArray(v)) { v.forEach((item, i) => walk(item, `${p}[${i}]`)); return; }
      for (const key of Object.keys(v)) {
        if (isCostKey(key)) {
          throw new Error(`[§30/D5] Vazamento de custo: a chave '${p}.${key}' expõe custo financeiro num payload de tenant. Custo (R$/US$) é só do Admin Master.`);
        }
        walk(v[key], `${p}.${key}`);
      }
    };
    walk(obj, path);
    return obj;
  }

  /**
   * Visão operacional das AI Runs do tenant na janela (default 30d). §30-safe:
   * SEM custo/tokens. Auto-guardada por `assertTenantSafe` antes de devolver.
   */
  static aiRuns(orgId: string, days?: number): AiRunsObservability {
    const d = this.clampDays(days);
    const since = `-${d} days`;

    const zero = <K extends string>(keys: readonly K[]): Record<string, number> =>
      Object.fromEntries(keys.map((k) => [k, 0]));

    const byStatus = zero(RELIABILITY_STATUSES);
    for (const r of db.prepare(
      `SELECT run_status AS s, COUNT(*) AS c FROM ai_usage_log
       WHERE organization_id = ? AND run_id IS NOT NULL AND created_at >= datetime('now', ?)
       GROUP BY run_status`
    ).all(orgId, since) as any[]) {
      if (r.s && byStatus[r.s] !== undefined) byStatus[r.s] = Number(r.c) || 0;
    }

    const byValidation = zero(["valid", "invalid", "skipped"] as const);
    for (const r of db.prepare(
      `SELECT validation_status AS s, COUNT(*) AS c FROM ai_usage_log
       WHERE organization_id = ? AND run_id IS NOT NULL AND created_at >= datetime('now', ?)
       GROUP BY validation_status`
    ).all(orgId, since) as any[]) {
      if (r.s && byValidation[r.s] !== undefined) byValidation[r.s] = Number(r.c) || 0;
    }

    const byGrounding = zero(["grounded", "unsupported", "skipped"] as const);
    for (const r of db.prepare(
      `SELECT grounding_status AS s, COUNT(*) AS c FROM ai_usage_log
       WHERE organization_id = ? AND run_id IS NOT NULL AND created_at >= datetime('now', ?)
       GROUP BY grounding_status`
    ).all(orgId, since) as any[]) {
      if (r.s && byGrounding[r.s] !== undefined) byGrounding[r.s] = Number(r.c) || 0;
    }

    const byFailureClass = zero(FAILURE_CLASSES);
    for (const r of db.prepare(
      `SELECT failure_class AS s, COUNT(*) AS c FROM ai_usage_log
       WHERE organization_id = ? AND run_id IS NOT NULL AND failure_class IS NOT NULL AND created_at >= datetime('now', ?)
       GROUP BY failure_class`
    ).all(orgId, since) as any[]) {
      if (r.s && byFailureClass[r.s] !== undefined) byFailureClass[r.s] = Number(r.c) || 0;
    }

    const agg = db.prepare(
      `SELECT COUNT(*) AS total,
              SUM(fallback_used) AS fallbacks,
              AVG(confidence) AS avgConf
       FROM ai_usage_log
       WHERE organization_id = ? AND run_id IS NOT NULL AND created_at >= datetime('now', ?)`
    ).get(orgId, since) as any;
    const totalRuns = Number(agg?.total) || 0;
    const fallbackCount = Number(agg?.fallbacks) || 0;
    const retriedCount = byStatus["retried"] || 0;
    const blockedCount = byStatus["blocked"] || 0;
    const failedCount = byStatus["failed"] || 0;
    const successRate = totalRuns ? ((byStatus["ok"] || 0) + retriedCount) / totalRuns : 0;

    const topSkills = (db.prepare(
      `SELECT skill_id AS skillId,
              COUNT(*) AS runs,
              SUM(CASE WHEN run_status = 'failed' THEN 1 ELSE 0 END) AS failures,
              SUM(fallback_used) AS fallbacks
       FROM ai_usage_log
       WHERE organization_id = ? AND run_id IS NOT NULL AND skill_id IS NOT NULL AND created_at >= datetime('now', ?)
       GROUP BY skill_id
       ORDER BY runs DESC, skillId ASC
       LIMIT 10`
    ).all(orgId, since) as any[]).map((r) => ({
      skillId: String(r.skillId),
      runs: Number(r.runs) || 0,
      failures: Number(r.failures) || 0,
      fallbacks: Number(r.fallbacks) || 0,
    }));

    // Saúde de provider — REUSA o circuit breaker da F5 (escopado ao tenant). A lista
    // de providers vem das próprias runs do tenant na janela.
    const providerNames = (db.prepare(
      `SELECT DISTINCT provider FROM ai_usage_log
       WHERE organization_id = ? AND run_id IS NOT NULL AND provider IS NOT NULL AND created_at >= datetime('now', ?)
       ORDER BY provider ASC`
    ).all(orgId, since) as any[]).map((r) => String(r.provider));
    const providers = providerNames.map((provider) => {
      const s = SkillOsProviderHealthService.stats(provider, { orgId, windowMinutes: d * 24 * 60 });
      return { provider, total: s.total, failed: s.failed, ok: s.ok, failureRate: s.failureRate, state: s.state };
    });

    const payload: AiRunsObservability = {
      windowDays: d,
      totalRuns,
      byStatus,
      byValidation,
      byGrounding,
      byFailureClass,
      fallbackCount,
      fallbackRate: totalRuns ? fallbackCount / totalRuns : 0,
      retriedCount,
      blockedCount,
      failedCount,
      successRate,
      avgConfidence: agg?.avgConf === null || agg?.avgConf === undefined ? null : Number(agg.avgConf),
      topSkills,
      providers,
    };
    // RN-OBS-2: prova em runtime que a visão de tenant não vazou custo (§30/D5).
    return this.assertTenantSafe(payload);
  }
}

export default SkillOsObservabilityService;
