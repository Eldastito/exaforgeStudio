import db from "./db.js";
import { MissionService, Mission } from "./MissionService.js";
import { MissionRuntimeService, MissionActionRef } from "./MissionRuntimeService.js";
import { MissionCheckpointService } from "./MissionCheckpointService.js";
import { PatternMemoryService, PatternCandidate } from "./PatternMemoryService.js";

/**
 * MissionDebriefService — ADR-189 F10 (Mission OS): DEBRIEF + APRENDIZADO.
 *
 * Ao terminar, a missão gera (a) um DEBRIEF read-model (objetivo/resultado/desvio/ações eficazes×
 * ineficazes/lições, §41) e (b) alimenta o MOTOR ÚNICO de aprendizado (PatternMemoryService, §42 —
 * SEM 2º banco de memória), espelhando o CreativeLearningService (ADR-167 F13). DONE ≠ EXEMPLO
 * (§9/PRD8/PRD9): só missão com resultado ASSEGURADO ensina forte — no nível da missão, o estado
 * `achieved` (que por D7 só se alcança via outcome confirmado) É o proxy de assured; `failed` é
 * aprendizado determinístico (backfired). `cancelled` não ensina (sem sinal). Idempotente por
 * `mission:<id>` (RN-EL-4). Determinístico/read-only pro debrief; opt-in por `pattern_memory`.
 */

const DOMAIN = "mission";

export interface MissionDebrief {
  missionId: string;
  status: string;
  humanStatus: string;
  objective: { title: string; desiredState: string | null; targetMetric: string | null; targetValue: number | null };
  result: { measurable: boolean; actual: number | null; target: number | null; attainmentPct: number | null; deviation: number | null };
  actions: { total: number; effective: MissionActionRef[]; ineffective: MissionActionRef[] };
  lessons: string[];
  note: string;
}

export class MissionDebriefService {
  private static verticalOf(orgId: string): string {
    try { return String((db.prepare(`SELECT vertical FROM organization_settings WHERE organization_id = ?`).get(orgId) as any)?.vertical || "geral"); }
    catch { return "geral"; }
  }

  /** Debrief read-model (determinístico, read-only). Compõe missão + ações + checkpoint. */
  static debrief(orgId: string, missionId: string): MissionDebrief {
    const m = MissionService.get(orgId, missionId);
    if (!m) throw new Error("Missão não encontrada.");
    const actions = MissionRuntimeService.actions(orgId, missionId);
    const effective = actions.filter((a) => a.status === "done");
    const ineffective = actions.filter((a) => a.status === "rejected" || a.status === "cancelled" || a.status === "failed");

    const cp = MissionCheckpointService.checkpoint(orgId, missionId);
    const measurable = cp.status !== "not_applicable" && cp.actual != null && cp.targetValue != null;
    const deviation = measurable ? Math.round(((cp.actual as number) - (cp.targetValue as number)) * 100) / 100 : null;

    const lessons: string[] = [];
    if (m.status === "achieved") lessons.push("Missão atingida — a estratégia funcionou para este objetivo.");
    if (m.status === "failed") lessons.push("Missão não atingida — revisar premissas (ticket/conversão/base) e o plano reverso.");
    if (effective.length) lessons.push(`${effective.length} ação(ões) concluída(s) contribuíram para o resultado.`);
    if (ineffective.length) lessons.push(`${ineffective.length} ação(ões) não avançaram — candidatas a evitar em missões semelhantes.`);
    if (!actions.length) lessons.push("Nenhuma ação governada foi executada — a missão não chegou a agir.");

    return {
      missionId, status: m.status, humanStatus: m.humanStatus,
      objective: { title: m.title, desiredState: m.desiredState, targetMetric: m.targetMetric, targetValue: m.targetValue },
      result: { measurable, actual: cp.actual, target: cp.targetValue, attainmentPct: cp.attainmentPct, deviation },
      actions: { total: actions.length, effective, ineffective },
      lessons,
      note: m.status === "achieved" ? "Missão concluída com sucesso." : m.status === "failed" ? "Missão encerrada sem atingir o objetivo." : "Missão ainda em andamento — debrief parcial.",
    };
  }

  /**
   * Alimenta o motor único a partir da missão TERMINADA. Só `achieved`/`failed` ensinam (assured
   * proxy / determinístico); `cancelled` e em-andamento não. Idempotente por `mission:<id>`.
   */
  static learn(orgId: string, missionId: string, actorId?: string): {
    ok: boolean; learned: boolean; idempotent?: boolean; reason?: string; patternId?: string; patternKey?: string; outcome?: string;
  } {
    if (!orgId || !missionId) return { ok: false, learned: false, reason: "args_invalidos" };
    if (!PatternMemoryService.isEnabled(orgId)) return { ok: true, learned: false, reason: "pattern_memory_off" };
    const m = MissionService.get(orgId, missionId);
    if (!m) return { ok: true, learned: false, reason: "missao_nao_encontrada" };

    let outcome: string;
    if (m.status === "achieved") outcome = "worked";
    else if (m.status === "failed") outcome = "backfired";
    else return { ok: true, learned: false, reason: "nao_terminal" };

    const vertical = this.verticalOf(orgId);
    // Assinatura da missão (origem × métrica-alvo) — aprende "que tipo de missão funciona pro nicho".
    const signature = `${m.source}:${m.targetMetric || "qualitativa"}`;
    const patternType = `mission:${signature}`;
    const patternKey = signature;
    // realizedImpact = valor-alvo entregue quando ATINGIU (unidade documentada; 0 quando falhou).
    const realizedImpact = outcome === "worked" && m.targetValue != null ? Number(m.targetValue) : 0;

    const candidate: PatternCandidate = {
      scopeId: vertical, patternType, patternKey,
      evidenceCount: 1, confidence: 0.5,
      evidence: { vertical, source: m.source, targetMetric: m.targetMetric },
      fallbackDescription: `Missão de ${m.targetMetric || "objetivo qualitativo"} (origem ${m.source}) no nicho ${vertical}.`,
      scopeName: vertical,
    };
    const patternId = PatternMemoryService.ensurePattern(orgId, DOMAIN, candidate);
    const res = PatternMemoryService.recordOutcome(orgId, patternId, {
      outcome, realizedImpact, source: "assured",
      eventKey: `mission:${missionId}`,
      correlationId: `mission:${missionId}`,
      note: `aprendizado de missão (${m.status}) — assinatura ${signature} (ADR-189 F10)`,
    }, actorId || "system:mission-learning");

    if (!res.ok) return { ok: false, learned: false, reason: res.error, patternId, patternKey };
    return { ok: true, learned: !res.idempotent, idempotent: !!res.idempotent, reason: res.idempotent ? "ja_aprendido" : "aprendido", patternId, patternKey, outcome };
  }
}

export default MissionDebriefService;
