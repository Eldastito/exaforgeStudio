/**
 * Módulo Clínica — ESPECIALIDADES NORMALIZADAS (ADR-145 Fase 1 / Fatia 35).
 *
 * Substitui o texto livre `clinic_professionals.specialty` como fonte de
 * verdade pra decisões de negócio (listar profissionais qualificados,
 * defaults de duração/ciclo, alimentar o AddSpecialtyWizard da Fatia 37,
 * default_cycle_sessions da Fatia 38). O texto legado permanece — não
 * apagamos coluna em migração (retenção CFM 20 anos + risco de quebra
 * dos dashboards operacionais que já lêem o campo).
 *
 * Chave arquitetural: `backfillFromLegacy` é IDEMPOTENTE — pode rodar N
 * vezes sem duplicar specialty nem vínculo (unique parcial protege). Isso
 * habilita o gestor a "arrumar" cadastros do profissional depois e re-rodar
 * o backfill sem medo de bagunça.
 *
 * Isolamento por `organization_id` em toda leitura/escrita. Audit via
 * `logAuthEvent` no padrão das Fases 24/26/33.
 */
import { randomUUID } from "node:crypto";
import db from "./db.js";
import { logAuthEvent } from "./auditLog.js";

export interface Specialty {
  id: string;
  organizationId: string;
  name: string;
  code: string | null;
  color: string | null;
  defaultDurationMinutes: number;
  defaultCycleSessions: number;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ProfessionalSpecialtyLink {
  id: string;
  organizationId: string;
  professionalId: string;
  specialtyId: string;
  isPrimary: boolean;
  active: boolean;
  createdAt: string;
}

export interface SpecialtyPatch {
  name?: string;
  code?: string | null;
  color?: string | null;
  defaultDurationMinutes?: number;
  defaultCycleSessions?: number;
  active?: boolean;
}

function hydrate(r: any): Specialty | null {
  if (!r) return null;
  return {
    id: r.id,
    organizationId: r.organization_id,
    name: r.name,
    code: r.code ?? null,
    color: r.color ?? null,
    defaultDurationMinutes: Number(r.default_duration_minutes ?? 60),
    defaultCycleSessions: Number(r.default_cycle_sessions ?? 10),
    active: Number(r.active) !== 0,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function hydrateLink(r: any): ProfessionalSpecialtyLink | null {
  if (!r) return null;
  return {
    id: r.id,
    organizationId: r.organization_id,
    professionalId: r.professional_id,
    specialtyId: r.specialty_id,
    isPrimary: Number(r.is_primary) === 1,
    active: Number(r.active) !== 0,
    createdAt: r.created_at,
  };
}

function normalizeName(s: string): string {
  return String(s || "").trim();
}

function validDuration(n: any): number {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v) || v < 5 || v > 480) return 60;
  return v;
}

function validCycleSessions(n: any): number {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v) || v < 1 || v > 200) return 10;
  return v;
}

export class ClinicSpecialtyService {
  // ── CRUD de especialidade ─────────────────────────────────────────────

  static list(orgId: string, opts: { includeInactive?: boolean } = {}): Specialty[] {
    const rows = opts.includeInactive
      ? db.prepare(
          `SELECT * FROM clinic_specialties
            WHERE organization_id = ?
            ORDER BY active DESC, name ASC`
        ).all(orgId) as any[]
      : db.prepare(
          `SELECT * FROM clinic_specialties
            WHERE organization_id = ? AND active = 1
            ORDER BY name ASC`
        ).all(orgId) as any[];
    return rows.map((r) => hydrate(r)!).filter(Boolean);
  }

  static get(orgId: string, id: string): Specialty | null {
    const r = db.prepare(
      `SELECT * FROM clinic_specialties WHERE organization_id = ? AND id = ?`
    ).get(orgId, id) as any;
    return hydrate(r);
  }

  /**
   * Cria uma especialidade. Nome é obrigatório e trimado. Duplicata por
   * (org, name) devolve a existente sem lançar (idempotente pra facilitar
   * backfill + operação manual convivendo).
   */
  static create(
    orgId: string,
    input: {
      name: string;
      code?: string | null;
      color?: string | null;
      defaultDurationMinutes?: number;
      defaultCycleSessions?: number;
    },
    actorId: string | null = null
  ): Specialty {
    const name = normalizeName(input.name);
    if (!name) throw new Error("Nome da especialidade é obrigatório.");

    const existing = db.prepare(
      `SELECT * FROM clinic_specialties WHERE organization_id = ? AND name = ?`
    ).get(orgId, name) as any;
    if (existing) return hydrate(existing)!;

    const id = randomUUID();
    const duration = validDuration(input.defaultDurationMinutes);
    const cycles = validCycleSessions(input.defaultCycleSessions);
    db.prepare(
      `INSERT INTO clinic_specialties
         (id, organization_id, name, code, color, default_duration_minutes, default_cycle_sessions)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(id, orgId, name, input.code ?? null, input.color ?? null, duration, cycles);

    logAuthEvent(orgId, actorId, null, "CLINIC_SPECIALTY_CREATED", {
      specialtyId: id, name, defaultDurationMinutes: duration, defaultCycleSessions: cycles,
    });

    return this.get(orgId, id)!;
  }

  /**
   * Atualiza campos permitidos. Renomear pra um nome já existente é bloqueado
   * (violaria unique index) — retorna erro claro. Desativar (active=0) não
   * remove; usar `list()` ignora inativas por default.
   */
  static update(orgId: string, id: string, patch: SpecialtyPatch, actorId: string | null = null): Specialty | null {
    const cur = this.get(orgId, id);
    if (!cur) return null;

    const patches: string[] = [];
    const params: any[] = [];

    if (patch.name !== undefined) {
      const name = normalizeName(patch.name);
      if (!name) throw new Error("Nome da especialidade é obrigatório.");
      if (name !== cur.name) {
        const clash = db.prepare(
          `SELECT id FROM clinic_specialties WHERE organization_id = ? AND name = ? AND id != ?`
        ).get(orgId, name, id) as any;
        if (clash) throw new Error("Já existe uma especialidade com esse nome.");
        patches.push("name = ?"); params.push(name);
      }
    }
    if (patch.code !== undefined) { patches.push("code = ?"); params.push(patch.code || null); }
    if (patch.color !== undefined) { patches.push("color = ?"); params.push(patch.color || null); }
    if (patch.defaultDurationMinutes !== undefined) {
      patches.push("default_duration_minutes = ?"); params.push(validDuration(patch.defaultDurationMinutes));
    }
    if (patch.defaultCycleSessions !== undefined) {
      patches.push("default_cycle_sessions = ?"); params.push(validCycleSessions(patch.defaultCycleSessions));
    }
    if (patch.active !== undefined) { patches.push("active = ?"); params.push(patch.active ? 1 : 0); }

    if (!patches.length) return cur;
    patches.push("updated_at = CURRENT_TIMESTAMP");
    db.prepare(
      `UPDATE clinic_specialties SET ${patches.join(", ")} WHERE organization_id = ? AND id = ?`
    ).run(...params, orgId, id);

    logAuthEvent(orgId, actorId, null, "CLINIC_SPECIALTY_UPDATED", {
      specialtyId: id, changes: Object.keys(patch),
    });

    return this.get(orgId, id);
  }

  // ── Vínculos profissional↔especialidade ───────────────────────────────

  /**
   * Lista profissionais vinculados a uma especialidade. Devolve join com
   * `clinic_professionals` (name/active/registration) — a UI da Fatia 37
   * mostra "Dra. Ana Silva (CRM/SP 12345)" no seletor.
   */
  static listProfessionalsForSpecialty(orgId: string, specialtyId: string, opts: { activeOnly?: boolean } = { activeOnly: true }): Array<{
    linkId: string;
    professionalId: string;
    name: string;
    council: string | null;
    registrationNumber: string | null;
    isPrimary: boolean;
    linkActive: boolean;
    professionalActive: boolean;
  }> {
    const rows = db.prepare(
      `SELECT ps.id AS link_id, ps.professional_id, ps.is_primary, ps.active AS link_active,
              p.name, p.council, p.registration_number, p.active AS prof_active
         FROM clinic_professional_specialties ps
         JOIN clinic_professionals p
           ON p.id = ps.professional_id AND p.organization_id = ps.organization_id
        WHERE ps.organization_id = ? AND ps.specialty_id = ?
          ${opts.activeOnly ? "AND ps.active = 1 AND p.active = 1" : ""}
        ORDER BY p.name ASC`
    ).all(orgId, specialtyId) as any[];
    return rows.map((r) => ({
      linkId: r.link_id,
      professionalId: r.professional_id,
      name: r.name,
      council: r.council ?? null,
      registrationNumber: r.registration_number ?? null,
      isPrimary: Number(r.is_primary) === 1,
      linkActive: Number(r.link_active) !== 0,
      professionalActive: Number(r.prof_active) !== 0,
    }));
  }

  /**
   * Lista especialidades vinculadas a um profissional. Usado pela ficha do
   * profissional (Fatia 37 UI) e como default no AddSpecialtyWizard quando
   * o operador escolhe profissional antes de especialidade.
   */
  static listSpecialtiesForProfessional(orgId: string, professionalId: string, opts: { activeOnly?: boolean } = { activeOnly: true }): Array<{
    linkId: string;
    specialtyId: string;
    name: string;
    color: string | null;
    isPrimary: boolean;
    linkActive: boolean;
    specialtyActive: boolean;
  }> {
    const rows = db.prepare(
      `SELECT ps.id AS link_id, ps.specialty_id, ps.is_primary, ps.active AS link_active,
              s.name, s.color, s.active AS spec_active
         FROM clinic_professional_specialties ps
         JOIN clinic_specialties s
           ON s.id = ps.specialty_id AND s.organization_id = ps.organization_id
        WHERE ps.organization_id = ? AND ps.professional_id = ?
          ${opts.activeOnly ? "AND ps.active = 1 AND s.active = 1" : ""}
        ORDER BY ps.is_primary DESC, s.name ASC`
    ).all(orgId, professionalId) as any[];
    return rows.map((r) => ({
      linkId: r.link_id,
      specialtyId: r.specialty_id,
      name: r.name,
      color: r.color ?? null,
      isPrimary: Number(r.is_primary) === 1,
      linkActive: Number(r.link_active) !== 0,
      specialtyActive: Number(r.spec_active) !== 0,
    }));
  }

  /**
   * Substitui atomicamente o conjunto de especialidades de um profissional
   * pelo passado. Regras:
   *   - Cada `{specialtyId, isPrimary?}` no array vira vínculo ativo (upsert).
   *   - Vínculos anteriores AUSENTES do array são desativados (active=0),
   *     não deletados — preserva histórico.
   *   - No máximo 1 `isPrimary=true` por profissional; se vier >1, mantém o
   *     primeiro (garantia leve, não trava chamada).
   *   - Se qualquer specialtyId não pertencer à org → erro.
   */
  static setProfessionalSpecialties(
    orgId: string,
    professionalId: string,
    input: Array<{ specialtyId: string; isPrimary?: boolean }>,
    actorId: string | null = null
  ): ProfessionalSpecialtyLink[] {
    const prof = db.prepare(
      `SELECT id FROM clinic_professionals WHERE organization_id = ? AND id = ?`
    ).get(orgId, professionalId) as any;
    if (!prof) throw new Error("Profissional não encontrado.");

    for (const item of input) {
      const s = db.prepare(
        `SELECT id FROM clinic_specialties WHERE organization_id = ? AND id = ?`
      ).get(orgId, item.specialtyId) as any;
      if (!s) throw new Error(`Especialidade não encontrada: ${item.specialtyId}`);
    }

    let primaryAssigned = false;
    const targetIds = new Set(input.map((i) => i.specialtyId));

    const tx = db.transaction(() => {
      // Desativa vínculos ausentes do input (soft-off)
      db.prepare(
        `UPDATE clinic_professional_specialties
            SET active = 0
          WHERE organization_id = ? AND professional_id = ?
            AND specialty_id NOT IN (${input.length ? input.map(() => "?").join(",") : "''"})`
      ).run(orgId, professionalId, ...input.map((i) => i.specialtyId));

      // Upsert dos vínculos do input
      for (const item of input) {
        const isPrimary = item.isPrimary === true && !primaryAssigned;
        if (isPrimary) primaryAssigned = true;

        const existing = db.prepare(
          `SELECT id FROM clinic_professional_specialties
            WHERE organization_id = ? AND professional_id = ? AND specialty_id = ?`
        ).get(orgId, professionalId, item.specialtyId) as any;

        if (existing) {
          db.prepare(
            `UPDATE clinic_professional_specialties
                SET is_primary = ?, active = 1
              WHERE id = ? AND organization_id = ?`
          ).run(isPrimary ? 1 : 0, existing.id, orgId);
        } else {
          db.prepare(
            `INSERT INTO clinic_professional_specialties
               (id, organization_id, professional_id, specialty_id, is_primary, active)
             VALUES (?, ?, ?, ?, ?, 1)`
          ).run(randomUUID(), orgId, professionalId, item.specialtyId, isPrimary ? 1 : 0);
        }
      }
    });
    tx();

    logAuthEvent(orgId, actorId, null, "CLINIC_PROFESSIONAL_SPECIALTY_LINKED", {
      professionalId,
      specialtyIds: input.map((i) => i.specialtyId),
      count: input.length,
    });

    return this.listSpecialtiesForProfessional(orgId, professionalId, { activeOnly: false })
      .filter((l) => targetIds.has(l.specialtyId))
      .map((l) => ({
        id: l.linkId,
        organizationId: orgId,
        professionalId,
        specialtyId: l.specialtyId,
        isPrimary: l.isPrimary,
        active: l.linkActive,
        createdAt: "",
      }));
  }

  // ── Backfill idempotente do texto legado ──────────────────────────────

  /**
   * Cria especialidades + vínculos a partir do campo texto legado
   * `clinic_professionals.specialty`. IDEMPOTENTE — pode rodar N vezes sem
   * duplicar (unique index protege create; UPDATE ativa vínculo existente).
   *
   * Regras:
   *   - Valores vazios/null são ignorados.
   *   - Trim + case-sensitive (o operador vê o que digitou).
   *   - Profissional inativo entra no backfill (a especialidade existe mesmo
   *     assim; o vínculo fica active=1 mas o join com prof.active=0 esconde
   *     nas queries com activeOnly=true).
   *   - Marca `is_primary=1` no primeiro vínculo criado pra cada profissional.
   *
   * Devolve `{specialtiesCreated, linksCreated, linksAlreadyExisted}`.
   */
  static backfillFromLegacy(orgId: string, actorId: string | null = null): {
    specialtiesCreated: number;
    linksCreated: number;
    linksAlreadyExisted: number;
  } {
    const summary = { specialtiesCreated: 0, linksCreated: 0, linksAlreadyExisted: 0 };
    const profs = db.prepare(
      `SELECT id, specialty FROM clinic_professionals
        WHERE organization_id = ? AND specialty IS NOT NULL AND TRIM(specialty) != ''`
    ).all(orgId) as any[];

    for (const p of profs) {
      const name = normalizeName(p.specialty);
      if (!name) continue;

      // Cria (ou pega existente)
      const before = db.prepare(
        `SELECT id FROM clinic_specialties WHERE organization_id = ? AND name = ?`
      ).get(orgId, name) as any;
      const spec = this.create(orgId, { name }, actorId);
      if (!before) summary.specialtiesCreated++;

      // Vínculo
      const existingLink = db.prepare(
        `SELECT id, active FROM clinic_professional_specialties
          WHERE organization_id = ? AND professional_id = ? AND specialty_id = ?`
      ).get(orgId, p.id, spec.id) as any;

      if (existingLink) {
        summary.linksAlreadyExisted++;
        // Se estava inativo, reativa — backfill é intencionalmente "sim, este
        // profissional atende esta especialidade"
        if (Number(existingLink.active) === 0) {
          db.prepare(
            `UPDATE clinic_professional_specialties SET active = 1 WHERE id = ? AND organization_id = ?`
          ).run(existingLink.id, orgId);
        }
      } else {
        // Primeiro vínculo do profissional vira primary
        const hasAny = db.prepare(
          `SELECT 1 FROM clinic_professional_specialties
            WHERE organization_id = ? AND professional_id = ? LIMIT 1`
        ).get(orgId, p.id) as any;
        db.prepare(
          `INSERT INTO clinic_professional_specialties
             (id, organization_id, professional_id, specialty_id, is_primary, active)
           VALUES (?, ?, ?, ?, ?, 1)`
        ).run(randomUUID(), orgId, p.id, spec.id, hasAny ? 0 : 1);
        summary.linksCreated++;
      }
    }

    logAuthEvent(orgId, actorId, null, "CLINIC_SPECIALTY_BACKFILL_RUN", summary);
    return summary;
  }
}

export default ClinicSpecialtyService;
