/**
 * Módulo Clínica — BLOQUEIO DE AGENDA POR INDISPONIBILIDADE (ADR-080 Fase 22).
 *
 * Profissional marca férias, congresso, atestado próprio ou outro motivo;
 * `ClinicAgendaService.createAppointment` recusa qualquer slot que se
 * sobrepõe à janela (a menos que `force:true`, padrão de bypass dos demais
 * gates da agenda). Nunca APAGA appointments existentes — se a recepção
 * marca ausência depois de já ter agendado consultas naquela janela, elas
 * ficam; o gestor decide caso a caso (cancelar/reagendar). O gate só
 * intercepta CRIAÇÃO nova.
 *
 * Timezone: `startsAt`/`endsAt` guardados como ISO 8601. Sobreposição
 * calculada em milissegundos (parse único), agnóstico de timezone da UI.
 *
 * Determinístico, isolado por `organization_id`.
 */
import { randomUUID } from "node:crypto";
import db from "./db.js";
import { logAuthEvent } from "./auditLog.js";

export type AbsenceReason = "vacation" | "conference" | "sick_leave" | "other";
const ALLOWED_REASONS: AbsenceReason[] = ["vacation", "conference", "sick_leave", "other"];

export interface Absence {
  id: string;
  organizationId: string;
  professionalId: string;
  startsAt: string;
  endsAt: string;
  reason: AbsenceReason;
  notes: string | null;
  createdBy: string | null;
  createdAt: string;
}

function hydrate(r: any): Absence | null {
  if (!r) return null;
  return {
    id: r.id,
    organizationId: r.organization_id,
    professionalId: r.professional_id,
    startsAt: r.starts_at,
    endsAt: r.ends_at,
    reason: r.reason,
    notes: r.notes ?? null,
    createdBy: r.created_by ?? null,
    createdAt: r.created_at,
  };
}

function parseIso(s: string): number {
  const t = Date.parse(String(s || ""));
  if (!Number.isFinite(t)) throw new Error("Data/hora inválida (use ISO 8601).");
  return t;
}

export class ClinicProfessionalAbsenceService {
  /**
   * Registra uma nova indisponibilidade. Valida ordem das datas, whitelist
   * de `reason` e existência do profissional no org. Não valida overlap
   * com ausências existentes — múltiplas ausências parciais podem coexistir
   * (ex.: manhã de congresso + tarde de folga no mesmo dia).
   */
  static create(orgId: string, professionalId: string, input: {
    startsAt: string;
    endsAt: string;
    reason: AbsenceReason;
    notes?: string | null;
  }, actorId: string | null): Absence {
    const prof = db.prepare(
      `SELECT id FROM clinic_professionals WHERE id = ? AND organization_id = ?`
    ).get(professionalId, orgId) as any;
    if (!prof) throw new Error("Profissional não encontrado.");

    const startMs = parseIso(input.startsAt);
    const endMs = parseIso(input.endsAt);
    if (endMs <= startMs) {
      const e: any = new Error("Fim da ausência precisa ser depois do início.");
      e.code = "ABSENCE_INVALID_RANGE";
      throw e;
    }

    const reason = String(input.reason || "").trim() as AbsenceReason;
    if (!ALLOWED_REASONS.includes(reason)) {
      const e: any = new Error(`Motivo inválido. Use: ${ALLOWED_REASONS.join(", ")}.`);
      e.code = "ABSENCE_INVALID_REASON";
      throw e;
    }

    const notes = input.notes ? String(input.notes).trim().slice(0, 500) : null;

    const id = randomUUID();
    db.prepare(
      `INSERT INTO clinic_professional_absences
         (id, organization_id, professional_id, starts_at, ends_at, reason, notes, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, orgId, professionalId, input.startsAt, input.endsAt, reason, notes, actorId);

    logAuthEvent(orgId, actorId, professionalId, "CLINIC_ABSENCE_CREATED", {
      absenceId: id,
      professionalId,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      reason,
    });

    return this.get(orgId, id)!;
  }

  static get(orgId: string, absenceId: string): Absence | null {
    const r = db.prepare(
      `SELECT * FROM clinic_professional_absences WHERE id = ? AND organization_id = ?`
    ).get(absenceId, orgId);
    return hydrate(r);
  }

  /**
   * Lista ausências do org. Filtros opcionais:
   *  - `professionalId`: restringe a um profissional
   *  - `activeAt`: só ausências ATIVAS no timestamp dado (starts <= t < ends)
   *  - `from`/`to`: janela — retorna ausências que se sobrepõem
   *  - `limit`: default 100, max 500
   */
  static list(orgId: string, opts: {
    professionalId?: string;
    activeAt?: string;
    from?: string;
    to?: string;
    limit?: number;
  } = {}): Absence[] {
    const filters: string[] = ["organization_id = ?"];
    const params: any[] = [orgId];

    if (opts.professionalId) {
      filters.push("professional_id = ?");
      params.push(opts.professionalId);
    }
    if (opts.activeAt) {
      filters.push("starts_at <= ? AND ends_at > ?");
      params.push(opts.activeAt, opts.activeAt);
    }
    if (opts.from) {
      filters.push("ends_at > ?");
      params.push(opts.from);
    }
    if (opts.to) {
      filters.push("starts_at < ?");
      params.push(opts.to);
    }

    const limit = Math.max(1, Math.min(500, Number(opts.limit) || 100));
    const rows = db.prepare(
      `SELECT * FROM clinic_professional_absences
        WHERE ${filters.join(" AND ")}
        ORDER BY starts_at DESC
        LIMIT ?`
    ).all(...params, limit) as any[];

    return rows.map((r) => hydrate(r)!).filter(Boolean);
  }

  /**
   * Detecta sobreposição entre a janela [startMs, endMs) e alguma ausência
   * ativa do profissional. Regra padrão de intervalos abertos-fechados:
   * há overlap se `absence.starts < endMs AND absence.ends > startMs`.
   *
   * Usado por `ClinicAgendaService.createAppointment` — só chamado quando
   * há `professionalId` no input (ausência é por profissional).
   */
  static overlaps(orgId: string, professionalId: string, startMs: number, endMs: number): Absence | null {
    if (endMs <= startMs) return null;
    // Comparação em ms via strftime não é portável — convertemos ISO pra ms
    // em memória. Volume real é baixo (dezenas de ausências por profissional
    // por ano); não precisa de índice espacial.
    const rows = db.prepare(
      `SELECT * FROM clinic_professional_absences
        WHERE organization_id = ? AND professional_id = ?`
    ).all(orgId, professionalId) as any[];
    for (const r of rows) {
      const s = Date.parse(r.starts_at);
      const e = Date.parse(r.ends_at);
      if (!Number.isFinite(s) || !Number.isFinite(e)) continue;
      if (s < endMs && e > startMs) return hydrate(r);
    }
    return null;
  }

  static remove(orgId: string, absenceId: string, actorId: string | null): void {
    const before = this.get(orgId, absenceId);
    if (!before) throw new Error("Ausência não encontrada.");
    db.prepare(
      `DELETE FROM clinic_professional_absences WHERE id = ? AND organization_id = ?`
    ).run(absenceId, orgId);
    logAuthEvent(orgId, actorId, before.professionalId, "CLINIC_ABSENCE_REMOVED", {
      absenceId,
      professionalId: before.professionalId,
    });
  }
}

export default ClinicProfessionalAbsenceService;
