/**
 * Módulo Clínica — EPISÓDIO DE CUIDADO (ADR-145 D1 / Fatia 36).
 *
 * Entidade CENTRAL da Jornada de Tratamento. Amarra paciente + especialidade
 * + profissional responsável + estado (active|on_hold|discharged|cancelled).
 *
 * Esta fatia entrega: abrir episódio, listar, transferir profissional
 * responsável, colocar em espera e retomar. NÃO entrega alta/reopen —
 * essas duas ações exigem PIN (ADR-145 D5) e ficam na Fatia 39 pra
 * concentrar a lógica de assinatura eletrônica num único lugar.
 *
 * Regras de negócio blindadas aqui (do PRD e do ADR):
 *   - RN-002: profissional é fixo por episódio; troca só via transfer.
 *   - RN-003: multi-especialidade não é transferência — cada especialidade
 *     é 1 episódio próprio (unique parcial ativo por specialty garante).
 *   - Transfer só entre profissionais da MESMA especialidade do episódio
 *     (senão vira mudança de especialidade, que exige novo episódio).
 *   - Isolamento por organization_id em toda leitura/escrita.
 *   - Audit no padrão das fases 26/33 (`logAuthEvent`).
 */
import { randomUUID } from "node:crypto";
import db from "./db.js";
import { logAuthEvent } from "./auditLog.js";
import { ClinicAgendaService } from "./ClinicAgendaService.js";
import { ClinicTreatmentCycleService } from "./ClinicTreatmentCycleService.js";

export type EpisodeStatus = "active" | "on_hold" | "discharged" | "cancelled";

export interface CareEpisode {
  id: string;
  organizationId: string;
  contactId: string;
  specialtyId: string;
  primaryProfessionalId: string;
  status: EpisodeStatus;
  startedAt: string;
  onHoldAt: string | null;
  onHoldReason: string | null;
  dischargedAt: string | null;
  dischargeType: string | null;
  dischargeSummary: string | null;
  dischargedByProfessionalId: string | null;
  dischargeSignedWithPin: boolean;
  reopenedAt: string | null;
  reopenReason: string | null;
  cancelledAt: string | null;
  cancelledReason: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EpisodeTransfer {
  id: string;
  organizationId: string;
  episodeId: string;
  fromProfessionalId: string;
  toProfessionalId: string;
  reason: string;
  effectiveAt: string;
  changedBy: string | null;
  createdAt: string;
}

function hydrate(r: any): CareEpisode | null {
  if (!r) return null;
  return {
    id: r.id,
    organizationId: r.organization_id,
    contactId: r.contact_id,
    specialtyId: r.specialty_id,
    primaryProfessionalId: r.primary_professional_id,
    status: r.status,
    startedAt: r.started_at,
    onHoldAt: r.on_hold_at ?? null,
    onHoldReason: r.on_hold_reason ?? null,
    dischargedAt: r.discharged_at ?? null,
    dischargeType: r.discharge_type ?? null,
    dischargeSummary: r.discharge_summary ?? null,
    dischargedByProfessionalId: r.discharged_by_professional_id ?? null,
    dischargeSignedWithPin: Number(r.discharge_signed_with_pin) === 1,
    reopenedAt: r.reopened_at ?? null,
    reopenReason: r.reopen_reason ?? null,
    cancelledAt: r.cancelled_at ?? null,
    cancelledReason: r.cancelled_reason ?? null,
    createdBy: r.created_by ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function hydrateTransfer(r: any): EpisodeTransfer | null {
  if (!r) return null;
  return {
    id: r.id,
    organizationId: r.organization_id,
    episodeId: r.episode_id,
    fromProfessionalId: r.from_professional_id,
    toProfessionalId: r.to_professional_id,
    reason: r.reason,
    effectiveAt: r.effective_at,
    changedBy: r.changed_by ?? null,
    createdAt: r.created_at,
  };
}

function assertProfessionalInSpecialty(orgId: string, professionalId: string, specialtyId: string): void {
  const link = db.prepare(
    `SELECT id FROM clinic_professional_specialties
      WHERE organization_id = ? AND professional_id = ? AND specialty_id = ? AND active = 1`
  ).get(orgId, professionalId, specialtyId) as any;
  if (!link) {
    const e: any = new Error("Profissional não está vinculado a esta especialidade.");
    e.code = "PROFESSIONAL_NOT_IN_SPECIALTY";
    throw e;
  }
}

function nowISO(): string { return new Date().toISOString(); }

export class ClinicCareEpisodeService {
  // ── Leitura ────────────────────────────────────────────────────────────

  static get(orgId: string, id: string): CareEpisode | null {
    const r = db.prepare(
      `SELECT * FROM clinic_care_episodes WHERE organization_id = ? AND id = ?`
    ).get(orgId, id) as any;
    return hydrate(r);
  }

  /**
   * Lista episódios de um paciente. Default: todos os estados (a UI
   * mostra cards separados de ativos, em espera, alta e cancelados;
   * `activeOnly` reduz pra painel operacional).
   */
  static listByPatient(orgId: string, contactId: string, opts: { activeOnly?: boolean } = {}): CareEpisode[] {
    const rows = opts.activeOnly
      ? db.prepare(
          `SELECT * FROM clinic_care_episodes
            WHERE organization_id = ? AND contact_id = ? AND status IN ('active','on_hold')
            ORDER BY started_at DESC`
        ).all(orgId, contactId) as any[]
      : db.prepare(
          `SELECT * FROM clinic_care_episodes
            WHERE organization_id = ? AND contact_id = ?
            ORDER BY started_at DESC`
        ).all(orgId, contactId) as any[];
    return rows.map((r) => hydrate(r)!).filter(Boolean);
  }

  /**
   * Lista episódios ativos de um profissional. Base pro dashboard do
   * profissional na Fatia 40 (fila operacional) e pra métricas Fatia 43.
   */
  static listByProfessional(orgId: string, professionalId: string, opts: { activeOnly?: boolean } = { activeOnly: true }): CareEpisode[] {
    const rows = opts.activeOnly
      ? db.prepare(
          `SELECT * FROM clinic_care_episodes
            WHERE organization_id = ? AND primary_professional_id = ? AND status IN ('active','on_hold')
            ORDER BY started_at DESC`
        ).all(orgId, professionalId) as any[]
      : db.prepare(
          `SELECT * FROM clinic_care_episodes
            WHERE organization_id = ? AND primary_professional_id = ?
            ORDER BY started_at DESC`
        ).all(orgId, professionalId) as any[];
    return rows.map((r) => hydrate(r)!).filter(Boolean);
  }

  static listTransfers(orgId: string, episodeId: string): EpisodeTransfer[] {
    const rows = db.prepare(
      `SELECT * FROM clinic_care_episode_transfers
        WHERE organization_id = ? AND episode_id = ?
        ORDER BY effective_at DESC, rowid DESC`
    ).all(orgId, episodeId) as any[];
    return rows.map((r) => hydrateTransfer(r)!).filter(Boolean);
  }

  // ── Abertura ───────────────────────────────────────────────────────────

  /**
   * Abre um episódio de cuidado. Validações:
   *   - Contact existe na org.
   *   - Specialty existe na org e está ativa.
   *   - Profissional existe na org e está ativo.
   *   - Profissional está VINCULADO à specialty (ADR-145 D2).
   *   - Não existe outro episódio active|on_hold pra (paciente, specialty)
   *     — protegido pelo unique parcial + retorna erro claro.
   */
  static open(
    orgId: string,
    contactId: string,
    input: { specialtyId: string; primaryProfessionalId: string; startedAt?: string | null },
    actorId: string | null = null
  ): CareEpisode {
    const contact = db.prepare(
      `SELECT id FROM contacts WHERE organization_id = ? AND id = ?`
    ).get(orgId, contactId) as any;
    if (!contact) throw new Error("Paciente não encontrado.");

    const spec = db.prepare(
      `SELECT id, active FROM clinic_specialties WHERE organization_id = ? AND id = ?`
    ).get(orgId, input.specialtyId) as any;
    if (!spec) throw new Error("Especialidade não encontrada.");
    if (Number(spec.active) === 0) throw new Error("Especialidade está desativada.");

    const prof = db.prepare(
      `SELECT id, active FROM clinic_professionals WHERE organization_id = ? AND id = ?`
    ).get(orgId, input.primaryProfessionalId) as any;
    if (!prof) throw new Error("Profissional não encontrado.");
    if (Number(prof.active) === 0) throw new Error("Profissional está desativado.");

    assertProfessionalInSpecialty(orgId, input.primaryProfessionalId, input.specialtyId);

    const existing = db.prepare(
      `SELECT id FROM clinic_care_episodes
        WHERE organization_id = ? AND contact_id = ? AND specialty_id = ?
          AND status IN ('active','on_hold') LIMIT 1`
    ).get(orgId, contactId, input.specialtyId) as any;
    if (existing) {
      const e: any = new Error("Paciente já possui episódio ativo nesta especialidade.");
      e.code = "EPISODE_ALREADY_ACTIVE";
      e.existingEpisodeId = existing.id;
      throw e;
    }

    const id = randomUUID();
    const startedAt = input.startedAt || nowISO();
    try {
      db.prepare(
        `INSERT INTO clinic_care_episodes
           (id, organization_id, contact_id, specialty_id, primary_professional_id,
            status, started_at, created_by)
         VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`
      ).run(id, orgId, contactId, input.specialtyId, input.primaryProfessionalId, startedAt, actorId);
    } catch (e: any) {
      // Race com o unique parcial — outro request criou entre a checagem e o insert
      if (String(e?.message || "").includes("UNIQUE") || e?.code === "SQLITE_CONSTRAINT_UNIQUE") {
        const err: any = new Error("Paciente já possui episódio ativo nesta especialidade.");
        err.code = "EPISODE_ALREADY_ACTIVE";
        throw err;
      }
      throw e;
    }

    logAuthEvent(orgId, actorId, contactId, "CLINIC_CARE_EPISODE_OPENED", {
      episodeId: id, specialtyId: input.specialtyId,
      primaryProfessionalId: input.primaryProfessionalId, startedAt,
    });

    return this.get(orgId, id)!;
  }

  // ── Transfer ───────────────────────────────────────────────────────────

  /**
   * Transfere o profissional responsável. Regras:
   *   - Episódio precisa estar `active` ou `on_hold` (transfer de fechado
   *     não faz sentido).
   *   - Destino ≠ atual (senão é no-op).
   *   - Destino vinculado à MESMA specialty do episódio (senão vira mudança
   *     de especialidade, que exige novo episódio via `open`).
   *   - Motivo obrigatório (audit-of-audit exige texto — se não, gestor
   *     não consegue reconstruir "por que trocou").
   *   - Registra em clinic_care_episode_transfers (append-only, imutável).
   *   - Atualiza primary_professional_id no episódio.
   *   - Appointments/prontuários históricos NÃO são tocados (imutabilidade
   *     Fase 29 — cada consulta antiga fica com o profissional que a fez).
   */
  static transfer(
    orgId: string,
    episodeId: string,
    input: { toProfessionalId: string; reason: string; effectiveAt?: string | null },
    actorId: string | null = null
  ): { episode: CareEpisode; transfer: EpisodeTransfer } {
    const ep = this.get(orgId, episodeId);
    if (!ep) throw new Error("Episódio não encontrado.");
    if (ep.status !== "active" && ep.status !== "on_hold") {
      const e: any = new Error("Episódio não está ativo — não pode ser transferido.");
      e.code = "EPISODE_NOT_ACTIVE"; throw e;
    }
    if (!input.toProfessionalId) throw new Error("Profissional destino é obrigatório.");
    if (input.toProfessionalId === ep.primaryProfessionalId) {
      const e: any = new Error("Profissional destino é o mesmo do responsável atual.");
      e.code = "TRANSFER_NOOP"; throw e;
    }
    const reason = String(input.reason || "").trim();
    if (!reason) throw new Error("Motivo da transferência é obrigatório.");

    const dest = db.prepare(
      `SELECT id, active FROM clinic_professionals WHERE organization_id = ? AND id = ?`
    ).get(orgId, input.toProfessionalId) as any;
    if (!dest) throw new Error("Profissional destino não encontrado.");
    if (Number(dest.active) === 0) throw new Error("Profissional destino está desativado.");

    assertProfessionalInSpecialty(orgId, input.toProfessionalId, ep.specialtyId);

    const transferId = randomUUID();
    const effectiveAt = input.effectiveAt || nowISO();

    const tx = db.transaction(() => {
      db.prepare(
        `INSERT INTO clinic_care_episode_transfers
           (id, organization_id, episode_id, from_professional_id, to_professional_id,
            reason, effective_at, changed_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(transferId, orgId, episodeId, ep.primaryProfessionalId, input.toProfessionalId,
            reason, effectiveAt, actorId);
      db.prepare(
        `UPDATE clinic_care_episodes
            SET primary_professional_id = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND organization_id = ?`
      ).run(input.toProfessionalId, episodeId, orgId);
    });
    tx();

    logAuthEvent(orgId, actorId, ep.contactId, "CLINIC_CARE_EPISODE_TRANSFERRED", {
      episodeId, fromProfessionalId: ep.primaryProfessionalId,
      toProfessionalId: input.toProfessionalId, transferId,
    });

    return {
      episode: this.get(orgId, episodeId)!,
      transfer: hydrateTransfer(
        db.prepare(`SELECT * FROM clinic_care_episode_transfers WHERE id = ?`).get(transferId)
      )!,
    };
  }

  // ── Hold / Resume ──────────────────────────────────────────────────────

  /**
   * Coloca o episódio em espera (paciente sumiu, gravidez, mudou de
   * cidade, etc.). Diferente de alta — pode voltar. Diferente de
   * cancelled — o tratamento existiu de fato.
   */
  static hold(
    orgId: string,
    episodeId: string,
    input: { reason: string },
    actorId: string | null = null
  ): CareEpisode {
    const ep = this.get(orgId, episodeId);
    if (!ep) throw new Error("Episódio não encontrado.");
    if (ep.status !== "active") {
      const e: any = new Error("Episódio não está ativo.");
      e.code = "EPISODE_NOT_ACTIVE"; throw e;
    }
    const reason = String(input.reason || "").trim();
    if (!reason) throw new Error("Motivo do hold é obrigatório.");

    db.prepare(
      `UPDATE clinic_care_episodes
          SET status='on_hold', on_hold_at=CURRENT_TIMESTAMP, on_hold_reason=?, updated_at=CURRENT_TIMESTAMP
        WHERE id=? AND organization_id=?`
    ).run(reason, episodeId, orgId);

    logAuthEvent(orgId, actorId, ep.contactId, "CLINIC_CARE_EPISODE_HOLD", {
      episodeId, reason,
    });
    return this.get(orgId, episodeId)!;
  }

  static resume(
    orgId: string,
    episodeId: string,
    actorId: string | null = null
  ): CareEpisode {
    const ep = this.get(orgId, episodeId);
    if (!ep) throw new Error("Episódio não encontrado.");
    if (ep.status !== "on_hold") {
      const e: any = new Error("Episódio não está em espera.");
      e.code = "EPISODE_NOT_ON_HOLD"; throw e;
    }
    db.prepare(
      `UPDATE clinic_care_episodes
          SET status='active', on_hold_at=NULL, on_hold_reason=NULL, updated_at=CURRENT_TIMESTAMP
        WHERE id=? AND organization_id=?`
    ).run(episodeId, orgId);

    logAuthEvent(orgId, actorId, ep.contactId, "CLINIC_CARE_EPISODE_RESUMED", {
      episodeId, previousHoldReason: ep.onHoldReason,
    });
    return this.get(orgId, episodeId)!;
  }

  /**
   * Assistente "Adicionar especialidade" (ADR-145 Fatia 37, RF-010). Consolida
   * em UM fluxo o abrir episódio + criar primeiro appointment — evita o pátio
   * de erros de fluxos manuais (abrir episódio e esquecer de agendar; agendar
   * com profissional divergente). Transação atômica: se o appointment falhar
   * (conflito, ausência, etc.), NADA persiste — o episódio também é rollbackado.
   *
   * Duração do primeiro appointment usa specialty.default_duration_minutes se
   * durationMinutes não vier. firstAppointmentAt é opcional — sem ele, só
   * abre o episódio (o operador marca depois).
   */
  static addSpecialtyForPatient(
    orgId: string,
    contactId: string,
    input: {
      specialtyId: string;
      primaryProfessionalId: string;
      startedAt?: string | null;
      firstAppointmentAt?: string | null;
      durationMinutes?: number | null;
      title?: string | null;
      roomId?: string | null;
      /** Fatia 38: cria ciclo inicial no mesmo fluxo. Default: sim. */
      createInitialCycle?: boolean;
      plannedSessions?: number | null;
    },
    actorId: string | null = null
  ): { episode: CareEpisode; firstAppointment: any | null; initialCycle: any | null } {
    let firstAppointment: any = null;
    let episode: CareEpisode | null = null;
    let initialCycle: any = null;
    const wantCycle = input.createInitialCycle !== false; // default true

    // Se firstAppointmentAt não vem, só abrimos o episódio (+ ciclo opcional).
    if (!input.firstAppointmentAt) {
      const tx = db.transaction(() => {
        episode = this.open(orgId, contactId, {
          specialtyId: input.specialtyId,
          primaryProfessionalId: input.primaryProfessionalId,
          startedAt: input.startedAt,
        }, actorId);
        if (wantCycle) {
          initialCycle = ClinicTreatmentCycleService.create(orgId, episode.id, {
            plannedSessions: input.plannedSessions ?? null,
          }, actorId);
        }
      });
      tx();
      return { episode: episode!, firstAppointment: null, initialCycle };
    }

    // Fluxo composto: abrir episódio + ciclo + primeiro appointment em 1 transação.
    // Rollback total se qualquer parte falhar.
    let durationMinutes = input.durationMinutes ?? undefined;
    if (durationMinutes == null || durationMinutes <= 0) {
      const spec = db.prepare(
        `SELECT default_duration_minutes FROM clinic_specialties WHERE organization_id = ? AND id = ?`
      ).get(orgId, input.specialtyId) as any;
      durationMinutes = Number(spec?.default_duration_minutes) || 60;
    }

    const tx = db.transaction(() => {
      episode = this.open(orgId, contactId, {
        specialtyId: input.specialtyId,
        primaryProfessionalId: input.primaryProfessionalId,
        startedAt: input.startedAt,
      }, actorId);
      if (wantCycle) {
        initialCycle = ClinicTreatmentCycleService.create(orgId, episode.id, {
          plannedSessions: input.plannedSessions ?? null,
        }, actorId);
      }
      firstAppointment = ClinicAgendaService.createAppointment(orgId, {
        contactId,
        title: input.title || undefined,
        scheduledStart: input.firstAppointmentAt!,
        professionalId: input.primaryProfessionalId,
        roomId: input.roomId || undefined,
        durationMinutes,
        careEpisodeId: episode.id,
      }, actorId ?? undefined);
      // Amarra o appointment ao ciclo inicial (sequência 1)
      if (initialCycle && firstAppointment?.id) {
        db.prepare(
          `UPDATE appointments SET treatment_cycle_id = ?, cycle_sequence_number = 1
            WHERE id = ? AND organization_id = ?`
        ).run(initialCycle.id, firstAppointment.id, orgId);
        firstAppointment.treatmentCycleId = initialCycle.id;
        firstAppointment.cycleSequenceNumber = 1;
      }
    });
    tx();

    return { episode: episode!, firstAppointment, initialCycle };
  }

  /**
   * Cancela episódio aberto por engano (não é alta). Reversível na Fatia 39
   * via reopen. Difere de discharge (Fatia 39) por não exigir PIN — é
   * ação administrativa da recepção, não decisão clínica.
   */
  static cancel(
    orgId: string,
    episodeId: string,
    input: { reason: string },
    actorId: string | null = null
  ): CareEpisode {
    const ep = this.get(orgId, episodeId);
    if (!ep) throw new Error("Episódio não encontrado.");
    if (ep.status === "cancelled") return ep;
    if (ep.status === "discharged") {
      const e: any = new Error("Episódio já teve alta — não pode ser cancelado.");
      e.code = "EPISODE_ALREADY_DISCHARGED"; throw e;
    }
    const reason = String(input.reason || "").trim();
    if (!reason) throw new Error("Motivo do cancelamento é obrigatório.");

    db.prepare(
      `UPDATE clinic_care_episodes
          SET status='cancelled', cancelled_at=CURRENT_TIMESTAMP, cancelled_reason=?, updated_at=CURRENT_TIMESTAMP
        WHERE id=? AND organization_id=?`
    ).run(reason, episodeId, orgId);

    logAuthEvent(orgId, actorId, ep.contactId, "CLINIC_CARE_EPISODE_CANCELLED", {
      episodeId, reason,
    });
    return this.get(orgId, episodeId)!;
  }
}

export default ClinicCareEpisodeService;
