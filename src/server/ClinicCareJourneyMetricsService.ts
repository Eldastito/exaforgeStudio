/**
 * Módulo Clínica — MÉTRICAS DA JORNADA DE TRATAMENTO (ADR-145 Fatia 40).
 *
 * Fecha a Fase 2. Consolida métricas de negócio derivadas de episódios,
 * ciclos, altas e appointments — todas por query (RN-004: nunca contador
 * mutável). Isolamento por organization_id.
 *
 * Métricas disponíveis:
 *   - Episódios ativos totais + breakdown por specialty e por profissional.
 *   - Altas no período: totais e breakdown por dischargeType.
 *   - Média de ciclos até alta (só episódios discharged no período).
 *   - Tempo médio entre esgotamento e renovação (só ciclos renewed).
 *   - Tratamentos ativos SEM próximo horário agendado.
 *   - Transferências no período (histórico de troca de responsável).
 *
 * Fila operacional (RF-100 §5):
 *   - active-without-schedule: episódio active|on_hold sem appointment
 *     futuro (paciente perdido no meio do tratamento).
 *   - renewal-pending: ciclo renewal_due (delega pra Fatia 38 renewalQueue).
 *   - transfers-recent: transferências últimos N dias.
 *   - futures-after-discharge: appointments futuros de episódios já
 *     dischargados (paciente precisa decidir: manter ou cancelar).
 *
 * Counts pra badge (padrão Fase 31 — evita front baixar array grande
 * só pra saber se tem item):
 *   - active: episódios active|on_hold.
 *   - renewalDue: ciclos aguardando renovação.
 *   - withoutSchedule: tratamentos ativos sem próximo horário.
 *   - futuresAfterDischarge: appointments órfãos.
 */
import db from "./db.js";

export type QueueFilter =
  | "active-without-schedule"
  | "renewal-pending"
  | "transfers-recent"
  | "futures-after-discharge";

export interface CareJourneyMetrics {
  episodes: {
    active: number;
    onHold: number;
    dischargedInPeriod: number;
    cancelledInPeriod: number;
    bySpecialty: Array<{ specialtyId: string; specialtyName: string; count: number }>;
    byProfessional: Array<{ professionalId: string; professionalName: string; count: number }>;
  };
  discharges: {
    total: number;
    byType: Record<string, number>;
    avgCyclesUntilDischarge: number | null;
  };
  cycles: {
    active: number;
    renewalDue: number;
    renewedInPeriod: number;
    avgDaysBetweenExhaustAndRenew: number | null;
  };
  transfers: {
    inPeriod: number;
  };
  operational: {
    activeWithoutNextAppointment: number;
    futureAppointmentsAfterDischarge: number;
  };
  window: { fromISO: string; toISO: string };
}

export interface Counts {
  active: number;
  onHold: number;
  renewalDue: number;
  withoutSchedule: number;
  futuresAfterDischarge: number;
  transfersRecent: number;
}

function normalizeWindow(from?: string | null, to?: string | null, nowMs: number = Date.now()): { fromISO: string; toISO: string } {
  const parseOr = (s: any, fallback: number) => {
    const v = Date.parse(String(s || ""));
    return Number.isFinite(v) ? v : fallback;
  };
  const now = nowMs;
  const thirtyDaysAgo = now - 30 * 86400000;
  const fromMs = parseOr(from, thirtyDaysAgo);
  const toMs = parseOr(to, now);
  return {
    fromISO: new Date(fromMs).toISOString(),
    toISO: new Date(toMs).toISOString(),
  };
}

export class ClinicCareJourneyMetricsService {
  static overview(orgId: string, opts: { from?: string; to?: string; nowMs?: number } = {}): CareJourneyMetrics {
    const win = normalizeWindow(opts.from, opts.to, opts.nowMs);

    // Episódios por status (totais atuais, snapshot no momento da query)
    const statusRows = db.prepare(
      `SELECT status, COUNT(*) AS c FROM clinic_care_episodes
        WHERE organization_id = ?
        GROUP BY status`
    ).all(orgId) as any[];
    const active = Number(statusRows.find((r) => r.status === "active")?.c) || 0;
    const onHold = Number(statusRows.find((r) => r.status === "on_hold")?.c) || 0;

    // Discharges/cancelamentos NO PERÍODO
    const dischargedInPeriod = Number((db.prepare(
      `SELECT COUNT(*) AS c FROM clinic_care_episodes
        WHERE organization_id = ? AND status='discharged'
          AND discharged_at >= ? AND discharged_at <= ?`
    ).get(orgId, win.fromISO, win.toISO) as any)?.c) || 0;

    const cancelledInPeriod = Number((db.prepare(
      `SELECT COUNT(*) AS c FROM clinic_care_episodes
        WHERE organization_id = ? AND status='cancelled'
          AND cancelled_at >= ? AND cancelled_at <= ?`
    ).get(orgId, win.fromISO, win.toISO) as any)?.c) || 0;

    // Episódios ativos por specialty (join com clinic_specialties pro nome)
    const bySpecialty = (db.prepare(
      `SELECT s.id AS specialty_id, s.name AS specialty_name, COUNT(e.id) AS c
         FROM clinic_care_episodes e
         JOIN clinic_specialties s ON s.id = e.specialty_id AND s.organization_id = e.organization_id
        WHERE e.organization_id = ? AND e.status IN ('active','on_hold')
        GROUP BY s.id, s.name
        ORDER BY c DESC`
    ).all(orgId) as any[]).map((r) => ({
      specialtyId: r.specialty_id, specialtyName: r.specialty_name, count: Number(r.c),
    }));

    // Episódios ativos por profissional
    const byProfessional = (db.prepare(
      `SELECT p.id AS professional_id, p.name AS professional_name, COUNT(e.id) AS c
         FROM clinic_care_episodes e
         JOIN clinic_professionals p ON p.id = e.primary_professional_id AND p.organization_id = e.organization_id
        WHERE e.organization_id = ? AND e.status IN ('active','on_hold')
        GROUP BY p.id, p.name
        ORDER BY c DESC`
    ).all(orgId) as any[]).map((r) => ({
      professionalId: r.professional_id, professionalName: r.professional_name, count: Number(r.c),
    }));

    // Discharges no período por tipo
    const dischargeTypeRows = db.prepare(
      `SELECT discharge_type, COUNT(*) AS c
         FROM clinic_care_episodes
        WHERE organization_id = ? AND status='discharged'
          AND discharged_at >= ? AND discharged_at <= ?
          AND discharge_type IS NOT NULL
        GROUP BY discharge_type`
    ).all(orgId, win.fromISO, win.toISO) as any[];
    const byType: Record<string, number> = {};
    for (const r of dischargeTypeRows) byType[r.discharge_type] = Number(r.c);

    // Média de ciclos até alta (episódios discharged no período)
    const avgCyclesRow = db.prepare(
      `SELECT AVG(cycle_count) AS avg_c
         FROM (
           SELECT e.id, COUNT(c.id) AS cycle_count
             FROM clinic_care_episodes e
             LEFT JOIN clinic_treatment_cycles c
               ON c.episode_id = e.id AND c.organization_id = e.organization_id
            WHERE e.organization_id = ? AND e.status='discharged'
              AND e.discharged_at >= ? AND e.discharged_at <= ?
            GROUP BY e.id
         )`
    ).get(orgId, win.fromISO, win.toISO) as any;
    const avgCyclesUntilDischarge = avgCyclesRow?.avg_c != null
      ? Math.round(Number(avgCyclesRow.avg_c) * 10) / 10
      : null;

    // Ciclos atuais (snapshot)
    const cycleStatusRows = db.prepare(
      `SELECT status, COUNT(*) AS c FROM clinic_treatment_cycles
        WHERE organization_id = ?
        GROUP BY status`
    ).all(orgId) as any[];
    const activeCycles = Number(cycleStatusRows.find((r) => r.status === "active")?.c) || 0;
    const renewalDue = Number(cycleStatusRows.find((r) => r.status === "renewal_due")?.c) || 0;

    // Ciclos renovados no período
    const renewedInPeriod = Number((db.prepare(
      `SELECT COUNT(*) AS c FROM clinic_treatment_cycles
        WHERE organization_id = ? AND status='renewed'
          AND renewed_at >= ? AND renewed_at <= ?`
    ).get(orgId, win.fromISO, win.toISO) as any)?.c) || 0;

    // Tempo médio entre esgotar e renovar (só ciclos que renewed no período,
    // e cujo appointment "esgotante" tem updated_at ≤ renewed_at).
    // Aproximação: usamos updated_at do ciclo anterior (marcado como renewed)
    // vs created_at do novo ciclo (que aponta previous_cycle_id).
    const gapRow = db.prepare(
      `SELECT AVG((julianday(new_c.created_at) - julianday(old_c.updated_at)) * 24) AS avg_h
         FROM clinic_treatment_cycles new_c
         JOIN clinic_treatment_cycles old_c
           ON old_c.id = new_c.previous_cycle_id AND old_c.organization_id = new_c.organization_id
        WHERE new_c.organization_id = ?
          AND new_c.created_at >= ? AND new_c.created_at <= ?`
    ).get(orgId, win.fromISO, win.toISO) as any;
    const avgDaysBetweenExhaustAndRenew = gapRow?.avg_h != null
      ? Math.round((Number(gapRow.avg_h) / 24) * 10) / 10
      : null;

    // Transferências no período
    const transfersInPeriod = Number((db.prepare(
      `SELECT COUNT(*) AS c FROM clinic_care_episode_transfers
        WHERE organization_id = ? AND effective_at >= ? AND effective_at <= ?`
    ).get(orgId, win.fromISO, win.toISO) as any)?.c) || 0;

    // Operational: episódios ativos SEM próximo appointment
    // (não existe appointment futuro ativo pra aquele episódio)
    const activeWithoutNext = Number((db.prepare(
      `SELECT COUNT(*) AS c FROM clinic_care_episodes e
        WHERE e.organization_id = ?
          AND e.status IN ('active','on_hold')
          AND NOT EXISTS (
            SELECT 1 FROM appointments a
             WHERE a.organization_id = e.organization_id
               AND a.care_episode_id = e.id
               AND a.status NOT IN ('cancelled','no_show','completed')
               AND a.scheduled_start >= CURRENT_TIMESTAMP
          )`
    ).get(orgId) as any)?.c) || 0;

    // Operational: appointments futuros de episódios DISCHARGED
    // (paciente teve alta mas ainda tem consulta agendada — UI precisa decidir)
    const futuresAfterDischarge = Number((db.prepare(
      `SELECT COUNT(*) AS c FROM appointments a
         JOIN clinic_care_episodes e ON e.id = a.care_episode_id AND e.organization_id = a.organization_id
        WHERE a.organization_id = ?
          AND e.status = 'discharged'
          AND a.status NOT IN ('cancelled','no_show','completed')
          AND a.scheduled_start >= CURRENT_TIMESTAMP`
    ).get(orgId) as any)?.c) || 0;

    return {
      episodes: {
        active, onHold, dischargedInPeriod, cancelledInPeriod, bySpecialty, byProfessional,
      },
      discharges: {
        total: dischargedInPeriod, byType, avgCyclesUntilDischarge,
      },
      cycles: {
        active: activeCycles, renewalDue,
        renewedInPeriod, avgDaysBetweenExhaustAndRenew,
      },
      transfers: { inPeriod: transfersInPeriod },
      operational: {
        activeWithoutNextAppointment: activeWithoutNext,
        futureAppointmentsAfterDischarge: futuresAfterDischarge,
      },
      window: win,
    };
  }

  /**
   * Fila operacional — retorna os itens do filtro. Cada item vem hidratado
   * com nome do paciente + specialty + profissional pra UI mostrar sem
   * request extra.
   */
  static queue(orgId: string, filter: QueueFilter, opts: { limit?: number; nowMs?: number } = {}): any[] {
    const limit = Math.max(1, Math.min(500, Number(opts.limit) || 100));

    if (filter === "active-without-schedule") {
      return (db.prepare(
        `SELECT e.id AS episode_id, e.status, e.started_at,
                c.name AS patient_name, c.id AS contact_id,
                s.name AS specialty_name, s.id AS specialty_id,
                p.name AS professional_name, p.id AS professional_id
           FROM clinic_care_episodes e
           LEFT JOIN contacts c ON c.id = e.contact_id AND c.organization_id = e.organization_id
           LEFT JOIN clinic_specialties s ON s.id = e.specialty_id AND s.organization_id = e.organization_id
           LEFT JOIN clinic_professionals p ON p.id = e.primary_professional_id AND p.organization_id = e.organization_id
          WHERE e.organization_id = ?
            AND e.status IN ('active','on_hold')
            AND NOT EXISTS (
              SELECT 1 FROM appointments a
               WHERE a.organization_id = e.organization_id
                 AND a.care_episode_id = e.id
                 AND a.status NOT IN ('cancelled','no_show','completed')
                 AND a.scheduled_start >= CURRENT_TIMESTAMP
            )
          ORDER BY e.started_at DESC
          LIMIT ?`
      ).all(orgId, limit) as any[]).map((r) => ({
        episodeId: r.episode_id, status: r.status, startedAt: r.started_at,
        patientId: r.contact_id, patientName: r.patient_name,
        specialtyId: r.specialty_id, specialtyName: r.specialty_name,
        professionalId: r.professional_id, professionalName: r.professional_name,
      }));
    }

    if (filter === "renewal-pending") {
      return (db.prepare(
        `SELECT c.id AS cycle_id, c.cycle_number, c.planned_sessions, c.status,
                e.id AS episode_id, e.contact_id,
                ct.name AS patient_name,
                sp.name AS specialty_name, sp.id AS specialty_id,
                p.name AS professional_name, p.id AS professional_id
           FROM clinic_treatment_cycles c
           JOIN clinic_care_episodes e ON e.id = c.episode_id AND e.organization_id = c.organization_id
           LEFT JOIN contacts ct ON ct.id = e.contact_id AND ct.organization_id = c.organization_id
           LEFT JOIN clinic_specialties sp ON sp.id = e.specialty_id AND sp.organization_id = c.organization_id
           LEFT JOIN clinic_professionals p ON p.id = e.primary_professional_id AND p.organization_id = c.organization_id
          WHERE c.organization_id = ? AND c.status = 'renewal_due'
            AND e.status IN ('active','on_hold')
          ORDER BY c.updated_at DESC
          LIMIT ?`
      ).all(orgId, limit) as any[]).map((r) => ({
        cycleId: r.cycle_id, cycleNumber: r.cycle_number, plannedSessions: r.planned_sessions,
        episodeId: r.episode_id, patientId: r.contact_id, patientName: r.patient_name,
        specialtyId: r.specialty_id, specialtyName: r.specialty_name,
        professionalId: r.professional_id, professionalName: r.professional_name,
      }));
    }

    if (filter === "transfers-recent") {
      const nowMs = Number.isFinite(opts.nowMs as number) ? (opts.nowMs as number) : Date.now();
      const sinceISO = new Date(nowMs - 30 * 86400000).toISOString();
      return (db.prepare(
        `SELECT t.id AS transfer_id, t.episode_id, t.reason, t.effective_at,
                fp.name AS from_name, fp.id AS from_id,
                tp.name AS to_name, tp.id AS to_id,
                ct.name AS patient_name, ct.id AS contact_id,
                sp.name AS specialty_name
           FROM clinic_care_episode_transfers t
           JOIN clinic_care_episodes e ON e.id = t.episode_id AND e.organization_id = t.organization_id
           LEFT JOIN clinic_professionals fp ON fp.id = t.from_professional_id AND fp.organization_id = t.organization_id
           LEFT JOIN clinic_professionals tp ON tp.id = t.to_professional_id AND tp.organization_id = t.organization_id
           LEFT JOIN contacts ct ON ct.id = e.contact_id AND ct.organization_id = t.organization_id
           LEFT JOIN clinic_specialties sp ON sp.id = e.specialty_id AND sp.organization_id = t.organization_id
          WHERE t.organization_id = ? AND t.effective_at >= ?
          ORDER BY t.effective_at DESC
          LIMIT ?`
      ).all(orgId, sinceISO, limit) as any[]).map((r) => ({
        transferId: r.transfer_id, episodeId: r.episode_id, reason: r.reason, effectiveAt: r.effective_at,
        fromProfessionalId: r.from_id, fromProfessionalName: r.from_name,
        toProfessionalId: r.to_id, toProfessionalName: r.to_name,
        patientId: r.contact_id, patientName: r.patient_name, specialtyName: r.specialty_name,
      }));
    }

    if (filter === "futures-after-discharge") {
      return (db.prepare(
        `SELECT a.id AS appointment_id, a.title, a.scheduled_start, a.status,
                e.id AS episode_id, e.status AS episode_status, e.discharged_at,
                ct.name AS patient_name, ct.id AS contact_id,
                sp.name AS specialty_name
           FROM appointments a
           JOIN clinic_care_episodes e ON e.id = a.care_episode_id AND e.organization_id = a.organization_id
           LEFT JOIN contacts ct ON ct.id = a.contact_id AND ct.organization_id = a.organization_id
           LEFT JOIN clinic_specialties sp ON sp.id = e.specialty_id AND sp.organization_id = a.organization_id
          WHERE a.organization_id = ?
            AND e.status = 'discharged'
            AND a.status NOT IN ('cancelled','no_show','completed')
            AND a.scheduled_start >= CURRENT_TIMESTAMP
          ORDER BY a.scheduled_start ASC
          LIMIT ?`
      ).all(orgId, limit) as any[]).map((r) => ({
        appointmentId: r.appointment_id, title: r.title, scheduledStart: r.scheduled_start,
        appointmentStatus: r.status,
        episodeId: r.episode_id, dischargedAt: r.discharged_at,
        patientId: r.contact_id, patientName: r.patient_name, specialtyName: r.specialty_name,
      }));
    }

    return [];
  }

  /**
   * Counts pra badge do sidebar (padrão Fase 31). Retorna só os números —
   * o front decide o que mostrar. Barato de calcular via COUNT direto.
   */
  static counts(orgId: string, opts: { nowMs?: number } = {}): Counts {
    const nowMs = Number.isFinite(opts.nowMs as number) ? (opts.nowMs as number) : Date.now();
    const sinceTransfersISO = new Date(nowMs - 30 * 86400000).toISOString();

    const active = Number((db.prepare(
      `SELECT COUNT(*) AS c FROM clinic_care_episodes WHERE organization_id = ? AND status='active'`
    ).get(orgId) as any)?.c) || 0;

    const onHold = Number((db.prepare(
      `SELECT COUNT(*) AS c FROM clinic_care_episodes WHERE organization_id = ? AND status='on_hold'`
    ).get(orgId) as any)?.c) || 0;

    const renewalDue = Number((db.prepare(
      `SELECT COUNT(*) AS c FROM clinic_treatment_cycles WHERE organization_id = ? AND status='renewal_due'`
    ).get(orgId) as any)?.c) || 0;

    const withoutSchedule = Number((db.prepare(
      `SELECT COUNT(*) AS c FROM clinic_care_episodes e
        WHERE e.organization_id = ? AND e.status IN ('active','on_hold')
          AND NOT EXISTS (
            SELECT 1 FROM appointments a
             WHERE a.organization_id = e.organization_id
               AND a.care_episode_id = e.id
               AND a.status NOT IN ('cancelled','no_show','completed')
               AND a.scheduled_start >= CURRENT_TIMESTAMP
          )`
    ).get(orgId) as any)?.c) || 0;

    const futuresAfterDischarge = Number((db.prepare(
      `SELECT COUNT(*) AS c FROM appointments a
         JOIN clinic_care_episodes e ON e.id = a.care_episode_id AND e.organization_id = a.organization_id
        WHERE a.organization_id = ?
          AND e.status = 'discharged'
          AND a.status NOT IN ('cancelled','no_show','completed')
          AND a.scheduled_start >= CURRENT_TIMESTAMP`
    ).get(orgId) as any)?.c) || 0;

    const transfersRecent = Number((db.prepare(
      `SELECT COUNT(*) AS c FROM clinic_care_episode_transfers
        WHERE organization_id = ? AND effective_at >= ?`
    ).get(orgId, sinceTransfersISO) as any)?.c) || 0;

    return { active, onHold, renewalDue, withoutSchedule, futuresAfterDischarge, transfersRecent };
  }
}

export default ClinicCareJourneyMetricsService;
