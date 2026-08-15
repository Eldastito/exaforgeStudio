/**
 * ProfessionalServiceService (ADR-169 F4 / BEAUTY-004) — vínculo N:N
 * profissional↔serviço da vertical Beleza & Salões.
 *
 * Modelo (tabela `professional_services`, criada em `db.ts` no fim do
 * initDb — aditiva):
 *
 *   (organization_id, professional_id, service_id)  ← UNIQUE
 *    + is_primary (INTEGER 0/1)  → serviço-signature do profissional
 *    + active (INTEGER 0/1)      → soft-off preserva histórico (nunca DELETE)
 *    + commission_percent (REAL) → default 0.0; fatia futura de comissão
 *
 * Por que uma tabela nova em vez de reusar `clinic_professional_specialties`?
 * Decisão D6 do ADR-169: mapear cada serviço como uma "especialidade" evitaria
 * a tabela mas obrigaria semear especialidade por serviço (ambíguo — "corte"
 * é especialidade OU serviço?) e não daria lugar natural pra `commission_percent`.
 * A tabela nova é agnóstica à vertical (referencia `products_services`, que é
 * o catálogo canônico), então pode ser reusada por outras verticais no futuro.
 *
 * Guardrails:
 *  - Multi-tenant duro (convenção nº 1): toda query filtra `organization_id`
 *    e valida que profissional/serviço pertencem à MESMA org (senão lança).
 *  - Nunca inventa vínculo cross-tenant (RN-BS-11): se `professionalId` é de
 *    outra org, `link` lança "profissional não encontrado" — nunca cria sem
 *    validar.
 *  - `setForProfessional` é atômico (transação) e soft-off para vínculos
 *    ausentes do input (preserva histórico + comissão).
 */
import db from "./db.js";
import { randomUUID } from "node:crypto";

export interface ProfessionalServiceLink {
  linkId: string;
  professionalId: string;
  serviceId: string;
  isPrimary: boolean;
  active: boolean;
  commissionPercent: number;
  createdAt: string;
}

export interface ServiceForProfessional extends ProfessionalServiceLink {
  serviceName: string;
  servicePrice: number | null;
  serviceDurationMinutes: number | null;
  serviceActive: boolean;
}

export interface ProfessionalForService {
  linkId: string;
  professionalId: string;
  professionalName: string;
  professionalActive: boolean;
  isPrimary: boolean;
  linkActive: boolean;
  commissionPercent: number;
}

export class ProfessionalServiceService {
  /**
   * Cria (ou reativa) 1 vínculo prof↔serviço. Idempotente por UNIQUE(org,
   * professional_id, service_id) — se o vínculo já existe, ATUALIZA
   * (is_primary/active/commission_percent) em vez de recriar (preserva
   * `created_at` e o `id`). Valida que ambos pertencem à mesma org.
   */
  static link(
    orgId: string,
    professionalId: string,
    serviceId: string,
    opts: { isPrimary?: boolean; active?: boolean; commissionPercent?: number } = {},
  ): ProfessionalServiceLink {
    const prof = db.prepare(
      "SELECT id FROM clinic_professionals WHERE organization_id = ? AND id = ?",
    ).get(orgId, professionalId) as any;
    if (!prof) throw new Error("Profissional não encontrado nesta organização.");

    const service = db.prepare(
      "SELECT id, type FROM products_services WHERE organization_id = ? AND id = ?",
    ).get(orgId, serviceId) as any;
    if (!service) throw new Error("Serviço não encontrado nesta organização.");
    // O modelo de dados de `products_services` é polimórfico (product|service|
    // reservation). Vincular profissional a produto físico não faz sentido —
    // recusa cedo (defensivo, RN-BS-11 não inventa vínculo).
    if (service.type !== "service") {
      throw new Error(`Vínculo prof↔serviço só aceita type='service' (recebeu type='${service.type}').`);
    }

    const isPrimary = opts.isPrimary === true ? 1 : 0;
    const active = opts.active === false ? 0 : 1;
    const commissionPercent = Number.isFinite(opts.commissionPercent) ? Number(opts.commissionPercent) : 0;
    if (commissionPercent < 0 || commissionPercent > 100) {
      throw new Error(`commissionPercent fora do intervalo [0..100]: ${commissionPercent}`);
    }

    const existing = db.prepare(
      "SELECT id FROM professional_services WHERE organization_id = ? AND professional_id = ? AND service_id = ?",
    ).get(orgId, professionalId, serviceId) as any;

    if (existing) {
      db.prepare(
        `UPDATE professional_services
            SET is_primary = ?, active = ?, commission_percent = ?
          WHERE id = ? AND organization_id = ?`,
      ).run(isPrimary, active, commissionPercent, existing.id, orgId);
      return this.getLink(orgId, existing.id)!;
    }

    const id = randomUUID();
    db.prepare(
      `INSERT INTO professional_services (id, organization_id, professional_id, service_id, is_primary, active, commission_percent)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, orgId, professionalId, serviceId, isPrimary, active, commissionPercent);
    return this.getLink(orgId, id)!;
  }

  /**
   * Desativa (soft-off) o vínculo prof↔serviço. Nunca deleta — preserva
   * histórico e valor de comissão pactuado.
   */
  static unlink(orgId: string, professionalId: string, serviceId: string): { ok: boolean; changed: boolean } {
    const r = db.prepare(
      `UPDATE professional_services
          SET active = 0
        WHERE organization_id = ? AND professional_id = ? AND service_id = ? AND active = 1`,
    ).run(orgId, professionalId, serviceId);
    return { ok: true, changed: r.changes > 0 };
  }

  /** Lê 1 vínculo por id (dentro da org). */
  static getLink(orgId: string, linkId: string): ProfessionalServiceLink | null {
    const r = db.prepare(
      "SELECT id, professional_id, service_id, is_primary, active, commission_percent, created_at FROM professional_services WHERE id = ? AND organization_id = ?",
    ).get(linkId, orgId) as any;
    if (!r) return null;
    return {
      linkId: r.id,
      professionalId: r.professional_id,
      serviceId: r.service_id,
      isPrimary: Number(r.is_primary) === 1,
      active: Number(r.active) !== 0,
      commissionPercent: Number(r.commission_percent) || 0,
      createdAt: r.created_at,
    };
  }

  /**
   * Lista serviços que um profissional faz. `activeOnly=true` (padrão) filtra
   * link ativo E serviço ativo (`products_services.active=1`). Ordena por
   * `is_primary DESC, name ASC` — o principal aparece primeiro.
   */
  static listServicesFor(
    orgId: string,
    professionalId: string,
    opts: { activeOnly?: boolean } = { activeOnly: true },
  ): ServiceForProfessional[] {
    const rows = db.prepare(
      `SELECT ps.id AS link_id, ps.professional_id, ps.service_id, ps.is_primary,
              ps.active AS link_active, ps.commission_percent, ps.created_at,
              s.name AS service_name, s.price AS service_price,
              s.duration_minutes AS service_duration_minutes, s.active AS service_active
         FROM professional_services ps
         JOIN products_services s
           ON s.id = ps.service_id AND s.organization_id = ps.organization_id
        WHERE ps.organization_id = ? AND ps.professional_id = ?
          ${opts.activeOnly ? "AND ps.active = 1 AND s.active = 1" : ""}
        ORDER BY ps.is_primary DESC, s.name ASC`,
    ).all(orgId, professionalId) as any[];
    return rows.map((r) => ({
      linkId: r.link_id,
      professionalId: r.professional_id,
      serviceId: r.service_id,
      isPrimary: Number(r.is_primary) === 1,
      active: Number(r.link_active) !== 0,
      commissionPercent: Number(r.commission_percent) || 0,
      createdAt: r.created_at,
      serviceName: r.service_name,
      servicePrice: r.service_price != null ? Number(r.service_price) : null,
      serviceDurationMinutes: r.service_duration_minutes != null ? Number(r.service_duration_minutes) : null,
      serviceActive: Number(r.service_active) !== 0,
    }));
  }

  /**
   * Lista profissionais habilitados para um serviço. Reusa o padrão do
   * `ClinicSpecialtyService.listProfessionalsForSpecialty` — é o join que
   * responde "quem pode fazer coloração?" na UI de agendamento.
   */
  static listProfessionalsFor(
    orgId: string,
    serviceId: string,
    opts: { activeOnly?: boolean } = { activeOnly: true },
  ): ProfessionalForService[] {
    const rows = db.prepare(
      `SELECT ps.id AS link_id, ps.professional_id, ps.is_primary,
              ps.active AS link_active, ps.commission_percent,
              p.name AS professional_name, p.active AS professional_active
         FROM professional_services ps
         JOIN clinic_professionals p
           ON p.id = ps.professional_id AND p.organization_id = ps.organization_id
        WHERE ps.organization_id = ? AND ps.service_id = ?
          ${opts.activeOnly ? "AND ps.active = 1 AND p.active = 1" : ""}
        ORDER BY ps.is_primary DESC, p.name ASC`,
    ).all(orgId, serviceId) as any[];
    return rows.map((r) => ({
      linkId: r.link_id,
      professionalId: r.professional_id,
      professionalName: r.professional_name,
      professionalActive: Number(r.professional_active) !== 0,
      isPrimary: Number(r.is_primary) === 1,
      linkActive: Number(r.link_active) !== 0,
      commissionPercent: Number(r.commission_percent) || 0,
    }));
  }

  /**
   * "Este profissional pode fazer este serviço?" — atalho boolean pra o gate
   * de agendamento em fatias futuras (F10 look→serviço→profissional). Só
   * considera link ATIVO + profissional ATIVO + serviço ATIVO (senão retorna
   * false — RN-BS-11 nunca infere capacidade sem prova).
   */
  static isCapable(orgId: string, professionalId: string, serviceId: string): boolean {
    const r = db.prepare(
      `SELECT 1
         FROM professional_services ps
         JOIN clinic_professionals p
           ON p.id = ps.professional_id AND p.organization_id = ps.organization_id
         JOIN products_services s
           ON s.id = ps.service_id AND s.organization_id = ps.organization_id
        WHERE ps.organization_id = ? AND ps.professional_id = ? AND ps.service_id = ?
          AND ps.active = 1 AND p.active = 1 AND s.active = 1
        LIMIT 1`,
    ).get(orgId, professionalId, serviceId);
    return !!r;
  }

  /**
   * Substitui atomicamente o conjunto de serviços de um profissional pelo
   * passado. Mesmo padrão do `ClinicSpecialtyService.setProfessionalSpecialties`:
   *   - Cada `{serviceId, isPrimary?, commissionPercent?}` no array vira
   *     vínculo ativo (upsert idempotente via `link`).
   *   - Vínculos anteriores AUSENTES do array são DESATIVADOS (active=0),
   *     nunca deletados — preserva histórico + comissão pactuada.
   *   - No máximo 1 `isPrimary=true` por profissional; se vier >1, mantém o
   *     primeiro (garantia leve, não trava a chamada).
   *   - Se qualquer serviceId não pertencer à org OU não for type='service'
   *     → `link` lança.
   */
  static setForProfessional(
    orgId: string,
    professionalId: string,
    input: Array<{ serviceId: string; isPrimary?: boolean; commissionPercent?: number }>,
  ): ProfessionalServiceLink[] {
    const prof = db.prepare(
      "SELECT id FROM clinic_professionals WHERE organization_id = ? AND id = ?",
    ).get(orgId, professionalId) as any;
    if (!prof) throw new Error("Profissional não encontrado nesta organização.");

    // Valida cedo — se algum serviço não bate, aborta ANTES de tocar em nada
    for (const item of input) {
      const s = db.prepare(
        "SELECT id, type FROM products_services WHERE organization_id = ? AND id = ?",
      ).get(orgId, item.serviceId) as any;
      if (!s) throw new Error(`Serviço não encontrado: ${item.serviceId}`);
      if (s.type !== "service") throw new Error(`Só type='service' (${item.serviceId} é '${s.type}').`);
    }

    let primaryAssigned = false;
    const targetIds = input.map((i) => i.serviceId);

    const tx = db.transaction(() => {
      // Desativa vínculos ausentes (soft-off — preserva histórico)
      if (targetIds.length) {
        db.prepare(
          `UPDATE professional_services
              SET active = 0
            WHERE organization_id = ? AND professional_id = ?
              AND service_id NOT IN (${targetIds.map(() => "?").join(",")})`,
        ).run(orgId, professionalId, ...targetIds);
      } else {
        db.prepare(
          `UPDATE professional_services
              SET active = 0
            WHERE organization_id = ? AND professional_id = ?`,
        ).run(orgId, professionalId);
      }

      // Upsert dos vínculos do input
      for (const item of input) {
        const isPrimary = item.isPrimary === true && !primaryAssigned;
        if (isPrimary) primaryAssigned = true;
        this.link(orgId, professionalId, item.serviceId, {
          isPrimary,
          active: true,
          commissionPercent: item.commissionPercent,
        });
      }
    });
    tx();

    return this.listServicesFor(orgId, professionalId, { activeOnly: true }).map((s) => ({
      linkId: s.linkId,
      professionalId: s.professionalId,
      serviceId: s.serviceId,
      isPrimary: s.isPrimary,
      active: s.active,
      commissionPercent: s.commissionPercent,
      createdAt: s.createdAt,
    }));
  }
}
