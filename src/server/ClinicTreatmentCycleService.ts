/**
 * Módulo Clínica — CICLOS DE SESSÕES RENOVÁVEIS (ADR-145 D4 / Fatia 38).
 *
 * Um episódio de cuidado (Fatia 36) tem N ciclos ao longo do tempo. O
 * ciclo é a unidade administrativa/assistencial ("10 sessões autorizadas
 * pela operadora"). Renovação ilimitada, encadeada via previous_cycle_id.
 *
 * REGRA CRÍTICA (RN-004): saldo de sessões é SEMPRE derivado por query
 * a partir dos appointments — NÃO existe coluna contador mutável. Isso
 * evita divergência silenciosa entre "saldo" e "o que aconteceu na agenda".
 *
 *   consumidas = appointments.status='completed' vinculados a este cycle
 *              + no_show, somente se cycle.no_show_consumes_session = 1
 *   restantes  = max(planned_sessions - consumidas, 0)
 *   scheduled  = appointments.status IN ('confirmed'|'checked_in') futuros
 *   available  = max(planned_sessions - consumidas - scheduled, 0)
 *
 * RN-005 (renovação): quando restantes == 0, ciclo vira 'renewal_due' —
 * episódio permanece 'active' (o paciente não desaparece por consumir
 * 10 sessões — dor #1 do cliente no áudio 5). Novo agendamento sem
 * saldo exige renovação (backend força o operador a decidir).
 *
 * Unique index parcial WHERE status IN ('active','renewal_due','pending_
 * authorization') garante 1 ciclo "em uso" por episódio — renew cria
 * novo E fecha o anterior na mesma transação, sem janela de duplicidade.
 */
import { randomUUID } from "node:crypto";
import db from "./db.js";
import { logAuthEvent } from "./auditLog.js";

export type CycleStatus =
  | "draft"
  | "pending_authorization"
  | "active"
  | "renewal_due"
  | "exhausted"
  | "renewed"
  | "cancelled"
  | "expired";

export interface TreatmentCycle {
  id: string;
  organizationId: string;
  episodeId: string;
  cycleNumber: number;
  previousCycleId: string | null;
  plannedSessions: number;
  noShowConsumesSession: boolean;
  status: CycleStatus;
  authorizationId: string | null;
  guideId: string | null;
  startsAt: string | null;
  expiresAt: string | null;
  renewalRequestedAt: string | null;
  renewedAt: string | null;
  cancelledAt: string | null;
  cancelledReason: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CycleUsage {
  cycleId: string;
  planned: number;
  completed: number;
  noShowConsumed: number;
  scheduled: number;
  remaining: number;
  availableToSchedule: number;
  status: CycleStatus;
}

const ACTIVE_LIKE: CycleStatus[] = ["active", "renewal_due", "pending_authorization"];

function hydrate(r: any): TreatmentCycle | null {
  if (!r) return null;
  return {
    id: r.id,
    organizationId: r.organization_id,
    episodeId: r.episode_id,
    cycleNumber: Number(r.cycle_number),
    previousCycleId: r.previous_cycle_id ?? null,
    plannedSessions: Number(r.planned_sessions),
    noShowConsumesSession: Number(r.no_show_consumes_session) === 1,
    status: r.status,
    authorizationId: r.authorization_id ?? null,
    guideId: r.guide_id ?? null,
    startsAt: r.starts_at ?? null,
    expiresAt: r.expires_at ?? null,
    renewalRequestedAt: r.renewal_requested_at ?? null,
    renewedAt: r.renewed_at ?? null,
    cancelledAt: r.cancelled_at ?? null,
    cancelledReason: r.cancelled_reason ?? null,
    createdBy: r.created_by ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function validPlannedSessions(n: any, fallback: number): number {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v) || v < 1 || v > 200) return fallback;
  return v;
}

function loadEpisodeOrThrow(orgId: string, episodeId: string): any {
  const ep = db.prepare(
    `SELECT id, contact_id, specialty_id, status FROM clinic_care_episodes
      WHERE organization_id = ? AND id = ?`
  ).get(orgId, episodeId) as any;
  if (!ep) throw new Error("Episódio não encontrado.");
  return ep;
}

function specialtyDefaultCycleSessions(orgId: string, specialtyId: string): number {
  const s = db.prepare(
    `SELECT default_cycle_sessions FROM clinic_specialties
      WHERE organization_id = ? AND id = ?`
  ).get(orgId, specialtyId) as any;
  const v = Number(s?.default_cycle_sessions);
  return Number.isFinite(v) && v > 0 ? v : 10;
}

export class ClinicTreatmentCycleService {
  // ── Leitura ────────────────────────────────────────────────────────────

  static get(orgId: string, id: string): TreatmentCycle | null {
    const r = db.prepare(
      `SELECT * FROM clinic_treatment_cycles WHERE organization_id = ? AND id = ?`
    ).get(orgId, id) as any;
    return hydrate(r);
  }

  static listByEpisode(orgId: string, episodeId: string): TreatmentCycle[] {
    const rows = db.prepare(
      `SELECT * FROM clinic_treatment_cycles
        WHERE organization_id = ? AND episode_id = ?
        ORDER BY cycle_number DESC`
    ).all(orgId, episodeId) as any[];
    return rows.map((r) => hydrate(r)!).filter(Boolean);
  }

  /** Ciclo "em uso" do episódio (active|renewal_due|pending_authorization). */
  static currentForEpisode(orgId: string, episodeId: string): TreatmentCycle | null {
    const r = db.prepare(
      `SELECT * FROM clinic_treatment_cycles
        WHERE organization_id = ? AND episode_id = ?
          AND status IN ('active','renewal_due','pending_authorization')
        ORDER BY cycle_number DESC LIMIT 1`
    ).get(orgId, episodeId) as any;
    return hydrate(r);
  }

  // ── Uso derivado por query (RN-004) ────────────────────────────────────

  static usage(orgId: string, cycleId: string): CycleUsage {
    const cycle = this.get(orgId, cycleId);
    if (!cycle) throw new Error("Ciclo não encontrado.");

    const stats = db.prepare(
      `SELECT
         SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) AS completed,
         SUM(CASE WHEN status='no_show' THEN 1 ELSE 0 END) AS no_shows,
         SUM(CASE WHEN status IN ('confirmed','checked_in','in_care') THEN 1 ELSE 0 END) AS scheduled
       FROM appointments
       WHERE organization_id = ? AND treatment_cycle_id = ?`
    ).get(orgId, cycleId) as any;

    const completed = Number(stats?.completed) || 0;
    const noShows = Number(stats?.no_shows) || 0;
    const scheduled = Number(stats?.scheduled) || 0;

    const noShowConsumed = cycle.noShowConsumesSession ? noShows : 0;
    const consumed = completed + noShowConsumed;
    const remaining = Math.max(cycle.plannedSessions - consumed, 0);
    const available = Math.max(cycle.plannedSessions - consumed - scheduled, 0);

    return {
      cycleId: cycle.id,
      planned: cycle.plannedSessions,
      completed,
      noShowConsumed,
      scheduled,
      remaining,
      availableToSchedule: available,
      status: cycle.status,
    };
  }

  // ── Criar ciclo ────────────────────────────────────────────────────────

  /**
   * Cria um ciclo pra um episódio. Regras:
   *   - Episódio existe, `active` ou `on_hold`.
   *   - Não existe outro ciclo "em uso" (active|renewal_due|pending_authorization)
   *     — bloqueado pelo unique parcial. Se existir, retorna CYCLE_ALREADY_ACTIVE.
   *   - `plannedSessions` puxa `specialty.default_cycle_sessions` se omitido;
   *     valida 1..200.
   *   - `cycle_number` = último + 1 (inclui ciclos fechados no cálculo).
   */
  static create(
    orgId: string,
    episodeId: string,
    input: { plannedSessions?: number | null; noShowConsumesSession?: boolean; startsAt?: string | null } = {},
    actorId: string | null = null
  ): TreatmentCycle {
    const ep = loadEpisodeOrThrow(orgId, episodeId);
    if (ep.status !== "active" && ep.status !== "on_hold") {
      const e: any = new Error("Episódio não está ativo.");
      e.code = "EPISODE_NOT_ACTIVE"; throw e;
    }

    // Ciclo em uso? (unique parcial vai bloquear, mas queremos erro claro)
    const existing = db.prepare(
      `SELECT id FROM clinic_treatment_cycles
        WHERE organization_id = ? AND episode_id = ?
          AND status IN ('active','renewal_due','pending_authorization') LIMIT 1`
    ).get(orgId, episodeId) as any;
    if (existing) {
      const e: any = new Error("Episódio já tem ciclo em uso — renove ou cancele antes de abrir novo.");
      e.code = "CYCLE_ALREADY_ACTIVE"; e.existingCycleId = existing.id; throw e;
    }

    const defaultN = specialtyDefaultCycleSessions(orgId, ep.specialty_id);
    const plannedSessions = validPlannedSessions(input.plannedSessions, defaultN);

    // cycle_number: max + 1 (inclui fechados — sequência global do episódio)
    const maxRow = db.prepare(
      `SELECT COALESCE(MAX(cycle_number), 0) AS mx FROM clinic_treatment_cycles
        WHERE organization_id = ? AND episode_id = ?`
    ).get(orgId, episodeId) as any;
    const cycleNumber = Number(maxRow?.mx || 0) + 1;

    const id = randomUUID();
    try {
      db.prepare(
        `INSERT INTO clinic_treatment_cycles
           (id, organization_id, episode_id, cycle_number, planned_sessions,
            no_show_consumes_session, status, starts_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`
      ).run(id, orgId, episodeId, cycleNumber, plannedSessions,
            input.noShowConsumesSession ? 1 : 0, input.startsAt || null, actorId);
    } catch (e: any) {
      if (String(e?.message || "").includes("UNIQUE") || e?.code === "SQLITE_CONSTRAINT_UNIQUE") {
        const err: any = new Error("Episódio já tem ciclo em uso.");
        err.code = "CYCLE_ALREADY_ACTIVE"; throw err;
      }
      throw e;
    }

    logAuthEvent(orgId, actorId, ep.contact_id, "CLINIC_TREATMENT_CYCLE_CREATED", {
      cycleId: id, episodeId, cycleNumber, plannedSessions,
      noShowConsumesSession: !!input.noShowConsumesSession,
    });

    return this.get(orgId, id)!;
  }

  // ── Renovar ciclo ──────────────────────────────────────────────────────

  /**
   * Renova um ciclo: marca o atual como 'renewed' e cria um novo ligado
   * via previous_cycle_id. Tudo em UMA transação — sem janela em que
   * existam 2 ciclos ativos.
   *
   * Regras:
   *   - Ciclo alvo precisa estar `active`, `renewal_due` ou `exhausted`.
   *   - Renovação ilimitada (RN-005) — cliente pediu explicitamente.
   *   - plannedSessions do novo puxa do anterior se omitido.
   *   - noShowConsumesSession herda do anterior se omitido.
   *   - Reason é opcional (renovação é fluxo normal, não exceção).
   */
  static renew(
    orgId: string,
    cycleId: string,
    input: { plannedSessions?: number | null; noShowConsumesSession?: boolean } = {},
    actorId: string | null = null
  ): { previous: TreatmentCycle; current: TreatmentCycle } {
    const prev = this.get(orgId, cycleId);
    if (!prev) throw new Error("Ciclo não encontrado.");
    if (prev.status !== "active" && prev.status !== "renewal_due" && prev.status !== "exhausted") {
      const e: any = new Error("Ciclo não pode ser renovado neste estado.");
      e.code = "CYCLE_NOT_RENEWABLE"; e.status = prev.status; throw e;
    }

    const ep = loadEpisodeOrThrow(orgId, prev.episodeId);
    if (ep.status !== "active" && ep.status !== "on_hold") {
      const e: any = new Error("Episódio não está ativo.");
      e.code = "EPISODE_NOT_ACTIVE"; throw e;
    }

    const plannedSessions = validPlannedSessions(input.plannedSessions, prev.plannedSessions);
    const noShowConsumesSession = input.noShowConsumesSession !== undefined
      ? !!input.noShowConsumesSession
      : prev.noShowConsumesSession;

    const newId = randomUUID();
    const nextNumber = prev.cycleNumber + 1;

    const tx = db.transaction(() => {
      // Fecha o anterior como 'renewed' PRIMEIRO — libera unique parcial pro insert
      db.prepare(
        `UPDATE clinic_treatment_cycles
            SET status='renewed', renewed_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
          WHERE id=? AND organization_id=?`
      ).run(cycleId, orgId);

      db.prepare(
        `INSERT INTO clinic_treatment_cycles
           (id, organization_id, episode_id, cycle_number, previous_cycle_id,
            planned_sessions, no_show_consumes_session, status, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)`
      ).run(newId, orgId, prev.episodeId, nextNumber, cycleId,
            plannedSessions, noShowConsumesSession ? 1 : 0, actorId);
    });
    tx();

    logAuthEvent(orgId, actorId, ep.contact_id, "CLINIC_TREATMENT_CYCLE_RENEWED", {
      previousCycleId: cycleId, newCycleId: newId, episodeId: prev.episodeId,
      previousCycleNumber: prev.cycleNumber, newCycleNumber: nextNumber, plannedSessions,
    });

    return {
      previous: this.get(orgId, cycleId)!,
      current: this.get(orgId, newId)!,
    };
  }

  // ── Transição pós-appointment (hook) ───────────────────────────────────

  /**
   * Chamada quando um appointment com treatment_cycle_id transita pra
   * completed/no_show. Recalcula uso e transiciona o ciclo pra renewal_due
   * quando esgota (RN-005). Best-effort: retorna o ciclo (ou null se
   * o appointment não tinha cycle).
   *
   * NÃO transforma o episódio (RN-001: paciente NUNCA some por consumo
   * de sessão — episódio continua `active` até alta explícita da Fatia 39).
   */
  static transitionOnAppointmentCompleted(orgId: string, appointmentId: string): TreatmentCycle | null {
    const appt = db.prepare(
      `SELECT id, contact_id, treatment_cycle_id, status FROM appointments
        WHERE organization_id = ? AND id = ?`
    ).get(orgId, appointmentId) as any;
    if (!appt || !appt.treatment_cycle_id) return null;

    const cycle = this.get(orgId, appt.treatment_cycle_id);
    if (!cycle) return null;
    if (cycle.status !== "active") return cycle; // já foi transicionado

    const use = this.usage(orgId, cycle.id);
    if (use.remaining === 0) {
      db.prepare(
        `UPDATE clinic_treatment_cycles
            SET status='renewal_due', updated_at=CURRENT_TIMESTAMP
          WHERE id=? AND organization_id=?`
      ).run(cycle.id, orgId);
      logAuthEvent(orgId, null, appt.contact_id, "CLINIC_TREATMENT_CYCLE_EXHAUSTED", {
        cycleId: cycle.id, episodeId: cycle.episodeId, triggeredByAppointmentId: appointmentId,
        planned: cycle.plannedSessions, consumed: use.completed + use.noShowConsumed,
      });
      return this.get(orgId, cycle.id);
    }
    return cycle;
  }

  // ── Fila de renovação (RF-100 §5) ──────────────────────────────────────

  /**
   * Ciclos que precisam de atenção da recepção. Retorna:
   *   - status='renewal_due' (esgotado, aguardando renovação)
   *   - status='active' mas remaining <= threshold (alerta antecipado)
   *   - status='pending_authorization' (aguardando OK do convênio)
   *
   * Threshold default 2 (a recepção vê "faltam 2 sessões" — janela pra
   * providenciar guia sem interromper tratamento).
   */
  static renewalQueue(orgId: string, opts: { threshold?: number } = {}): Array<{
    cycle: TreatmentCycle;
    usage: CycleUsage;
    patientName: string | null;
    specialtyName: string | null;
    professionalName: string | null;
  }> {
    const threshold = Math.max(0, Math.floor(Number(opts.threshold) || 2));

    const rows = db.prepare(
      `SELECT c.*, ep.contact_id, ep.specialty_id, ep.primary_professional_id,
              ct.name AS patient_name, s.name AS specialty_name, p.name AS professional_name
         FROM clinic_treatment_cycles c
         JOIN clinic_care_episodes ep
           ON ep.id = c.episode_id AND ep.organization_id = c.organization_id
         LEFT JOIN contacts ct ON ct.id = ep.contact_id AND ct.organization_id = c.organization_id
         LEFT JOIN clinic_specialties s ON s.id = ep.specialty_id AND s.organization_id = c.organization_id
         LEFT JOIN clinic_professionals p ON p.id = ep.primary_professional_id AND p.organization_id = c.organization_id
        WHERE c.organization_id = ?
          AND c.status IN ('active','renewal_due','pending_authorization')
          AND ep.status IN ('active','on_hold')
        ORDER BY c.created_at DESC`
    ).all(orgId) as any[];

    const out: any[] = [];
    for (const r of rows) {
      const cycle = hydrate(r)!;
      const usage = this.usage(orgId, cycle.id);
      const needs = cycle.status !== "active" || usage.remaining <= threshold;
      if (needs) {
        out.push({
          cycle, usage,
          patientName: r.patient_name || null,
          specialtyName: r.specialty_name || null,
          professionalName: r.professional_name || null,
        });
      }
    }
    return out;
  }

  // ── Cancel ─────────────────────────────────────────────────────────────

  static cancel(
    orgId: string,
    cycleId: string,
    input: { reason: string },
    actorId: string | null = null
  ): TreatmentCycle {
    const cycle = this.get(orgId, cycleId);
    if (!cycle) throw new Error("Ciclo não encontrado.");
    if (cycle.status === "cancelled") return cycle;
    if (cycle.status === "renewed") {
      const e: any = new Error("Ciclo já foi renovado — não pode ser cancelado.");
      e.code = "CYCLE_NOT_CANCELLABLE"; throw e;
    }
    const reason = String(input.reason || "").trim();
    if (!reason) throw new Error("Motivo do cancelamento é obrigatório.");

    db.prepare(
      `UPDATE clinic_treatment_cycles
          SET status='cancelled', cancelled_at=CURRENT_TIMESTAMP, cancelled_reason=?, updated_at=CURRENT_TIMESTAMP
        WHERE id=? AND organization_id=?`
    ).run(reason, cycleId, orgId);

    const ep = loadEpisodeOrThrow(orgId, cycle.episodeId);
    logAuthEvent(orgId, actorId, ep.contact_id, "CLINIC_TREATMENT_CYCLE_CANCELLED", {
      cycleId, episodeId: cycle.episodeId, reason,
    });
    return this.get(orgId, cycleId)!;
  }
}

export default ClinicTreatmentCycleService;
