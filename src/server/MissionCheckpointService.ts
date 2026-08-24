import db from "./db.js";
import { MissionService, Mission } from "./MissionService.js";
import { BusinessGoalService } from "./BusinessGoalService.js";
import { BusinessSignalService } from "./BusinessSignalService.js";
import { MissionRuntimeService } from "./MissionRuntimeService.js";

/**
 * MissionCheckpointService — ADR-189 F6 (Mission OS): CHECKPOINT + REPLAN.
 *
 * Durante a execução, compara PLANEJADO × REALIZADO × TEMPO (§36): o valor esperado até agora
 * (alvo × fração do tempo decorrido) contra o valor REAL da métrica (derivado por query). Classifica
 * on_track/at_risk/off_track e publica `mission/at_risk` em `business_signals` (nunca tabela paralela,
 * convenção nº 12) quando a missão sai da trajetória — cedo o bastante pra reagir. DETERMINÍSTICO/
 * read-only pra o checkpoint. Isolado por org.
 *
 * REPLAN (§38/§39): `proposeReplan` propõe um ajuste como AÇÃO GOVERNADA (via MissionRuntimeService
 * — F5), nunca executa direto: "auto" no máximo AUTO-PROPÕE (segue awaiting_approval; a ApprovalPolicy
 * decide). RESULTADO ≠ EXECUÇÃO: o checkpoint nunca marca a missão como achieved.
 *
 * Reusa BusinessGoalService.currentValue (métrica real), MissionRuntimeService (replan governado),
 * business_signals (self-healing). Sem motor novo (D4/§184).
 */

const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

export type CheckpointStatus = "on_track" | "at_risk" | "off_track" | "not_applicable";
export interface MissionCheckpoint {
  missionId: string;
  status: CheckpointStatus;
  targetValue: number | null;
  actual: number | null;
  expectedByNow: number | null;
  elapsedFraction: number | null;
  attainmentPct: number | null;
  note: string;
}

function frac(startISO: string, endISO: string, asOfISO: string): number | null {
  const s = new Date(startISO).getTime(), e = new Date(`${endISO}T23:59:59Z`).getTime(), a = new Date(asOfISO).getTime();
  if (isNaN(s) || isNaN(e) || isNaN(a)) return null;
  if (e <= s) return 1;
  return Math.max(0, Math.min(1, (a - s) / (e - s)));
}

export class MissionCheckpointService {
  static checkpoint(orgId: string, missionId: string, opts: { asOf?: string; actualValue?: number } = {}): MissionCheckpoint {
    const mission = MissionService.get(orgId, missionId);
    if (!mission) throw new Error("Missão não encontrada.");
    const asOf = opts.asOf || new Date().toISOString();

    // Precisa de métrica conhecida + alvo + prazo pra ter trajetória.
    if (!mission.targetMetric || !BusinessGoalService.isKnownMetric(mission.targetMetric) || mission.targetValue == null || !mission.deadline) {
      return { missionId, status: "not_applicable", targetValue: mission.targetValue, actual: null, expectedByNow: null, elapsedFraction: null, attainmentPct: null,
        note: "Sem métrica/alvo/prazo mensuráveis — missão acompanhada por marcos, não por trajetória." };
    }

    const elapsed = frac(mission.createdAt, mission.deadline, asOf);
    const actual = opts.actualValue != null ? Number(opts.actualValue) : BusinessGoalService.currentValue(orgId, mission.targetMetric);
    if (elapsed == null || actual == null) {
      return { missionId, status: "not_applicable", targetValue: mission.targetValue, actual, expectedByNow: null, elapsedFraction: elapsed, attainmentPct: null,
        note: "Não foi possível medir a trajetória agora." };
    }

    const target = Number(mission.targetValue);
    const expectedByNow = round2(target * elapsed);
    const reached = actual >= target;
    const ratio = expectedByNow > 0 ? actual / expectedByNow : 1; // cedo (esperado ~0) → no ritmo
    const status: CheckpointStatus = reached || ratio >= 1 ? "on_track" : ratio >= 0.7 ? "at_risk" : "off_track";
    const attainmentPct = target > 0 ? Math.round((actual / target) * 100) : null;

    const brl = mission.targetUnit === "BRL";
    const fmt = (n: number) => brl ? `R$ ${n.toLocaleString("pt-BR")}` : String(Math.round(n));
    const note = status === "on_track"
      ? `No ritmo: ${fmt(actual)} de ${fmt(target)} (esperado ~${fmt(expectedByNow)} a ${Math.round(elapsed * 100)}% do prazo).`
      : `${status === "off_track" ? "Fora da trajetória" : "Em risco"}: ${fmt(actual)} realizados, esperado ~${fmt(expectedByNow)} a ${Math.round(elapsed * 100)}% do prazo. Precisa reagir.`;

    return { missionId, status, targetValue: target, actual, expectedByNow, elapsedFraction: round2(elapsed), attainmentPct, note };
  }

  /** Publica/repõe o sinal mission/at_risk conforme a trajetória. Self-healing; dedupe por missão. */
  static publishCheckpointSignal(orgId: string, missionId: string, opts: { asOf?: string; actualValue?: number } = {}): { published: boolean; resolved: boolean } {
    const dedupeKey = `mission_checkpoint:${missionId}`;
    let published = false, resolved = false;
    try {
      const c = this.checkpoint(orgId, missionId, opts);
      if (c.status === "at_risk" || c.status === "off_track") {
        BusinessSignalService.publish(orgId, {
          domain: "mission", signalType: "at_risk", severity: c.status === "off_track" ? "risk" : "attention",
          basis: "hypothesis", confidence: 0.6, impactAmount: null, sourceService: "MissionCheckpointService",
          evidence: { missionId, status: c.status, actual: c.actual, expectedByNow: c.expectedByNow, elapsedFraction: c.elapsedFraction, message: c.note },
          dedupeKey,
        });
        try { BusinessSignalService.reopenByDedupe(orgId, dedupeKey); } catch { /* noop */ }
        published = true;
      } else if (c.status === "on_track") {
        try { const rr = BusinessSignalService.resolveByDedupe(orgId, dedupeKey); resolved = !!rr?.ok; } catch { /* noop */ }
      }
    } catch { /* best-effort */ }
    return { published, resolved };
  }

  /** Passe do Scheduler: checkpoint das missões em andamento (com métrica/alvo/prazo). Só orgs com a flag. */
  static pass(): void {
    let rows: any[] = [];
    try {
      rows = db.prepare(`
        SELECT id, organization_id FROM missions
        WHERE mission_status IN ('running','waiting_approval')
          AND target_metric IS NOT NULL AND target_value IS NOT NULL AND deadline IS NOT NULL
      `).all() as any[];
    } catch { return; }
    for (const r of rows) {
      try { if (MissionService.isEnabled(r.organization_id)) this.publishCheckpointSignal(r.organization_id, r.id); }
      catch (e) { console.error("[Mission] checkpoint pass falhou", r.id, e); }
    }
  }

  /**
   * REPLAN GOVERNADO (§38): propõe um ajuste da missão como AÇÃO governada (via F5). Nunca executa
   * direto (nasce awaiting_approval; a ApprovalPolicy decide). Só faz sentido quando a missão está
   * em risco/fora da trajetória — mas quem decide agir é o dono. Reusa MissionRuntimeService.
   */
  static proposeReplan(orgId: string, missionId: string, opts: { reason?: string; actor?: string } = {}): { mission: Mission; action: any } {
    const c = this.checkpoint(orgId, missionId);
    const reason = opts.reason || (c.status === "off_track" || c.status === "at_risk" ? c.note : "Ajuste de plano da missão.");
    return MissionRuntimeService.proposeAction(orgId, missionId, {
      domain: "mission", actionType: "mission_replan",
      title: "Replanejar a missão", description: reason, basis: "hypothesis",
    }, opts.actor);
  }
}

export default MissionCheckpointService;
