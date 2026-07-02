import { randomUUID } from "node:crypto";
import db from "./db.js";
import { logRadarEvent } from "./radarAudit.js";
import { RevenueIntelligenceService } from "./RevenueIntelligenceService.js";
import { AppointmentService, TZ_OFFSET_MIN } from "./AppointmentService.js";

// ZappFlow Radar — Índice de Velocidade de Conversão (IVC).
//
// Diferença chave em relação ao score de maturidade do Radar (RadarService):
// aquele é AUTODECLARADO via questionário; este é MEDIDO a partir de dados
// reais de tickets/mensagens da própria organização. Só existe para quem já é
// cliente ativo do ZappFlow (tem conversas no banco) — não serve para o
// diagnóstico de um prospect ainda sem conta.
//
// Determinístico e versionado (SCORING_VERSION), igual ao motor de maturidade:
// nenhuma IA generativa entra neste cálculo. Ver docs/adr/ADR-010-radar-velocidade-conversao.md.
//
// Deliberadamente reaproveita, em vez de duplicar:
//   - RevenueIntelligenceService.getConfig(orgId).slow_response_seconds como
//     limiar de SLA (a organização já configura esse número hoje para o RIC;
//     ter DOIS limiares de "resposta lenta" divergentes no mesmo produto seria
//     confuso e um risco de manutenção).
//   - AppointmentService.config(orgId) para o horário comercial (mesmos campos
//     agenda_open_hour/agenda_close_hour/agenda_days já usados pela Agenda).
//   - contact_cadences (CadenceService) como sinal de "existe follow-up".

export type IvcBand = "critica" | "reativa" | "em_organizacao" | "controlada" | "otimizada";

export interface VelocityCalcOptions {
  periodDays?: number;   // janela de medição; default 30, teto 180
  sessionId?: string | null; // opcional: anexa o snapshot a uma radar_sessions existente
}

// Versão do motor de cálculo. Incrementar sempre que a fórmula mudar, para que
// snapshots antigos continuem explicáveis (mesmo princípio do SCORING_VERSION
// do RadarService).
export const SCORING_VERSION = 1;

const clamp = (n: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));

function band(score: number): IvcBand {
  if (score < 25) return "critica";
  if (score < 45) return "reativa";
  if (score < 65) return "em_organizacao";
  if (score < 80) return "controlada";
  return "otimizada";
}

// Espelha AppointmentService.brParts (privado naquela classe) — fuso fixo de
// Brasília (sem horário de verão desde 2019), mesma constante TZ_OFFSET_MIN.
function localParts(ms: number) {
  const d = new Date(ms + TZ_OFFSET_MIN * 60000);
  return { hour: d.getUTCHours(), dow: d.getUTCDay() === 0 ? 7 : d.getUTCDay() }; // ISO: 1=seg..7=dom
}

function isWithinBusinessHours(ms: number, cfg: { openHour: number; closeHour: number; days: number[] }): boolean {
  const p = localParts(ms);
  if (!cfg.days.includes(p.dow)) return false;
  return p.hour >= cfg.openHour && p.hour < cfg.closeHour;
}

function percentile(sortedAsc: number[], p: number): number | null {
  if (!sortedAsc.length) return null;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil((p / 100) * sortedAsc.length) - 1));
  return Math.round(sortedAsc[idx]);
}

// Mesma curva de pontuação já usada em RevenueIntelligenceService.driverAtendimento
// (ideal = limiar de SLA; 0 pontos a partir de 10x o limiar) — reaproveitada
// aqui para que "o que conta como resposta boa/ruim" seja consistente entre o
// RIC e o Radar, não dois critérios divergentes no mesmo produto.
function responseTimeScore(p90Seconds: number | null, idealSeconds: number): number | null {
  if (p90Seconds == null) return null;
  if (p90Seconds <= idealSeconds) return 100;
  const ceiling = idealSeconds * 10;
  const over = (p90Seconds - idealSeconds) / (ceiling - idealSeconds);
  return clamp(100 - over * 100);
}

const inClause = (n: number) => new Array(n).fill("?").join(",");

export class ConversionVelocityService {
  static band = band;

  static calculate(orgId: string, actorUserId: string | undefined, opts: VelocityCalcOptions = {}) {
    const periodDays = opts.periodDays && opts.periodDays > 0 ? Math.min(Math.round(opts.periodDays), 180) : 30;
    let sessionId: string | null = null;
    if (opts.sessionId) {
      const session = db.prepare(`SELECT id FROM radar_sessions WHERE id = ? AND organization_id = ?`).get(opts.sessionId, orgId);
      if (!session) throw new Error("Sessão de diagnóstico não encontrada para anexar este cálculo.");
      sessionId = opts.sessionId;
    }

    const periodEndMs = Date.now();
    const periodStartMs = periodEndMs - periodDays * 86400000;
    const periodStart = new Date(periodStartMs).toISOString();
    const periodEnd = new Date(periodEndMs).toISOString();

    const cfg = RevenueIntelligenceService.getConfig(orgId);
    const slaThresholdSeconds = cfg.slow_response_seconds;
    const agenda = AppointmentService.config(orgId);

    // Primeiro contato -> primeira resposta, por ticket (mesmo padrão de
    // RevenueIntelligenceService: fc = 1ª mensagem do contato; fb = 1ª mensagem
    // nossa a partir dali). LEFT JOIN em fb para também capturar quem nunca foi
    // respondido. Mede só o primeiro ciclo de cada ticket (não cada mensagem
    // subsequente) — suficiente para "velocidade de entrada", documentado aqui
    // como limite conhecido da v1.
    const rows = db.prepare(`
      SELECT tk.id AS ticket_id, tk.status AS ticket_status, fc.t AS contact_at, fb.t AS response_at,
        CASE WHEN fb.t IS NOT NULL THEN (julianday(fb.t) - julianday(fc.t)) * 86400.0 END AS response_seconds
      FROM tickets tk
      JOIN (SELECT ticket_id, MIN(created_at) t FROM messages WHERE organization_id = ? AND sender_type = 'contact' GROUP BY ticket_id) fc
        ON fc.ticket_id = tk.id
      LEFT JOIN (SELECT ticket_id, MIN(created_at) t FROM messages WHERE organization_id = ? AND sender_type IN ('bot','agent') GROUP BY ticket_id) fb
        ON fb.ticket_id = tk.id AND fb.t >= fc.t
      WHERE tk.organization_id = ? AND fc.t >= ? AND fc.t <= ?
    `).all(orgId, orgId, orgId, periodStart, periodEnd) as any[];

    const ticketsAnalyzed = rows.length;
    const respondedSeconds = rows.filter((r) => r.response_seconds != null).map((r) => Math.max(0, Number(r.response_seconds))).sort((a, b) => a - b);
    const ticketsNeverResponded = ticketsAnalyzed - respondedSeconds.length;

    // --- Conformidade de SLA ---
    const slaCompliantCount = respondedSeconds.filter((s) => s <= slaThresholdSeconds).length;
    const slaComplianceRate = ticketsAnalyzed > 0 ? slaCompliantCount / ticketsAnalyzed : null;

    // --- Percentis de primeira resposta ---
    const p50 = percentile(respondedSeconds, 50);
    const p90 = percentile(respondedSeconds, 90);
    const p95 = percentile(respondedSeconds, 95);

    // --- Cobertura fora do horário comercial ---
    let outOfHoursTotal = 0;
    let outOfHoursCovered = 0;
    for (const r of rows) {
      const contactMs = AppointmentService.ms(r.contact_at);
      if (contactMs == null) continue;
      if (isWithinBusinessHours(contactMs, agenda)) continue; // só nos interessa o que caiu FORA do horário
      outOfHoursTotal++;
      if (r.response_seconds != null && r.response_seconds <= slaThresholdSeconds) outOfHoursCovered++;
    }
    const outOfHoursCoverageRate = outOfHoursTotal > 0 ? outOfHoursCovered / outOfHoursTotal : null;

    // --- Conformidade de follow-up (tickets em risco: nunca respondido OU
    // respondido acima do SLA) ---
    const atRiskIds = rows
      .filter((r) => r.response_seconds == null || r.response_seconds > slaThresholdSeconds)
      .map((r) => r.ticket_id);
    let followupCompliantTotal = 0;
    if (atRiskIds.length) {
      const cadenceRows = db.prepare(
        `SELECT DISTINCT ticket_id FROM contact_cadences WHERE organization_id = ? AND ticket_id IN (${inClause(atRiskIds.length)})`
      ).all(orgId, ...atRiskIds) as any[];
      const cadenceTicketIds = new Set(cadenceRows.map((r) => r.ticket_id));

      const msgCountRows = db.prepare(
        `SELECT ticket_id, COUNT(*) AS c FROM messages WHERE organization_id = ? AND sender_type IN ('bot','agent') AND ticket_id IN (${inClause(atRiskIds.length)}) GROUP BY ticket_id`
      ).all(orgId, ...atRiskIds) as any[];
      const msgCountByTicket = new Map(msgCountRows.map((r) => [r.ticket_id, Number(r.c)]));

      for (const id of atRiskIds) {
        const attempted = cadenceTicketIds.has(id) || (msgCountByTicket.get(id) || 0) >= 2;
        if (attempted) followupCompliantTotal++;
      }
    }
    const followupAtRiskTotal = atRiskIds.length;
    // Zero tickets em risco é um resultado BOM (não "sem dado") — só fica nulo
    // quando não há volume nenhum de ticket no período para julgar.
    const followupComplianceRate = followupAtRiskTotal > 0
      ? followupCompliantTotal / followupAtRiskTotal
      : (ticketsAnalyzed > 0 ? 1 : null);

    // --- Rastreabilidade de conversão (tickets fechados no período com
    // histórico de mudança de estágio registrado) ---
    const closedRows = db.prepare(
      `SELECT id FROM tickets WHERE organization_id = ? AND status = 'closed' AND closed_at >= ? AND closed_at <= ?`
    ).all(orgId, periodStart, periodEnd) as any[];
    const closedIds = closedRows.map((r) => r.id);
    let conversionTraceableTotal = 0;
    if (closedIds.length) {
      const traceableRows = db.prepare(
        `SELECT DISTINCT ticket_id FROM ticket_stage_logs WHERE organization_id = ? AND ticket_id IN (${inClause(closedIds.length)})`
      ).all(orgId, ...closedIds) as any[];
      conversionTraceableTotal = traceableRows.length;
    }
    const conversionClosedTotal = closedIds.length;
    const conversionTraceabilityRate = conversionClosedTotal > 0 ? conversionTraceableTotal / conversionClosedTotal : null;

    // --- Composição do IVC (PRD do módulo: SLA 30% + P90 20% + fora do
    // horário 15% + follow-up 20% + rastreabilidade 15%). Componente sem dado
    // suficiente é EXCLUÍDO e os pesos renormalizados — nunca tratado como 0,
    // mesmo princípio já usado no score de maturidade (RadarService). ---
    const components: { key: string; value: number | null; weight: number }[] = [
      { key: "slaCompliance", value: slaComplianceRate != null ? slaComplianceRate * 100 : null, weight: 0.30 },
      { key: "firstResponseP90", value: responseTimeScore(p90, slaThresholdSeconds), weight: 0.20 },
      { key: "outOfHoursCoverage", value: outOfHoursCoverageRate != null ? outOfHoursCoverageRate * 100 : null, weight: 0.15 },
      { key: "followupCompliance", value: followupComplianceRate != null ? followupComplianceRate * 100 : null, weight: 0.20 },
      { key: "conversionTraceability", value: conversionTraceabilityRate != null ? conversionTraceabilityRate * 100 : null, weight: 0.15 },
    ];
    const usable = components.filter((c) => c.value != null) as { key: string; value: number; weight: number }[];
    const weightSum = usable.reduce((s, c) => s + c.weight, 0);
    const ivcScore = weightSum > 0 ? Math.round((usable.reduce((s, c) => s + c.value * c.weight, 0) / weightSum) * 10) / 10 : null;
    const ivcBand = ivcScore != null ? band(ivcScore) : null;

    const calculationJson = {
      scoringVersion: SCORING_VERSION,
      slaThresholdSeconds,
      businessHours: agenda,
      componentsConsidered: components,
      componentsExcluded: components.filter((c) => c.value == null).map((c) => c.key),
      weightSumUsed: weightSum,
    };

    const id = randomUUID();
    db.prepare(`
      INSERT INTO radar_velocity_snapshots (
        id, organization_id, session_id, period_start, period_end, ivc_score, ivc_band, sla_threshold_seconds,
        sla_compliance_rate, first_response_p50_seconds, first_response_p90_seconds, first_response_p95_seconds,
        out_of_hours_messages_total, out_of_hours_covered_total, out_of_hours_coverage_rate,
        followup_at_risk_total, followup_compliant_total, followup_compliance_rate,
        conversion_closed_total, conversion_traceable_total, conversion_traceability_rate,
        tickets_analyzed, tickets_never_responded, scoring_version, calculation_json, calculated_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, orgId, sessionId, periodStart, periodEnd, ivcScore, ivcBand, slaThresholdSeconds,
      slaComplianceRate, p50, p90, p95,
      outOfHoursTotal, outOfHoursCovered, outOfHoursCoverageRate,
      followupAtRiskTotal, followupCompliantTotal, followupComplianceRate,
      conversionClosedTotal, conversionTraceableTotal, conversionTraceabilityRate,
      ticketsAnalyzed, ticketsNeverResponded, SCORING_VERSION, JSON.stringify(calculationJson), actorUserId || null
    );

    logRadarEvent(orgId, actorUserId, "radar_velocity_calculated", { snapshotId: id, sessionId, ivcScore, ivcBand, periodDays });

    return this.get(orgId, id);
  }

  static get(orgId: string, id: string): any {
    return db.prepare(`SELECT * FROM radar_velocity_snapshots WHERE id = ? AND organization_id = ?`).get(id, orgId) as any;
  }

  static list(orgId: string, sessionId?: string) {
    if (sessionId) {
      return db.prepare(`SELECT * FROM radar_velocity_snapshots WHERE organization_id = ? AND session_id = ? ORDER BY created_at DESC`).all(orgId, sessionId);
    }
    return db.prepare(`SELECT * FROM radar_velocity_snapshots WHERE organization_id = ? ORDER BY created_at DESC`).all(orgId);
  }

  static latest(orgId: string): any {
    return db.prepare(`SELECT * FROM radar_velocity_snapshots WHERE organization_id = ? ORDER BY created_at DESC LIMIT 1`).get(orgId) as any;
  }
}
