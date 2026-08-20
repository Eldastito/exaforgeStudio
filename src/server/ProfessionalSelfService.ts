/**
 * ProfessionalSelfService — ADR-180 F7.1: camada de LEITURA por-profissional (webapp de
 * autoatendimento).
 *
 * Tudo que o painel do profissional mostra é DERIVADO por profissional (não por clínica):
 * fan-out sobre os vínculos ACEITOS da identidade global, cruzando as fontes que já
 * existem por-org (agenda federada, `ProfessionalFinanceService.statement`). É a peça que
 * inverte a perspectiva — do "a clínica X vê o profissional" pro "o profissional vê as
 * clínicas dele". Read-only; a escrita (disponibilidade, aceitar/recusar) vem nas F7.3/F7.4.
 *
 * Privacidade: o profissional só enxerga os PRÓPRIOS vínculos/atendimentos (join por
 * `professional_id`). Nunca cruza dados de outro profissional. Dinheiro é DELE (o que vai
 * receber), então não é role-gated aqui — a barreira é a sessão escopada (F7.1 auth).
 */
import db from "./db.js";
import { ProfessionalService } from "./ProfessionalService.js";
import { ProfessionalFinanceService } from "./ProfessionalFinanceService.js";

export interface ClinicLink { organizationId: string; clinicName: string | null; relationshipId: string; status: string; }

function clinicName(orgId: string): string | null {
  const r = db.prepare(`SELECT business_name FROM organization_settings WHERE organization_id = ?`).get(orgId) as any;
  return r?.business_name ?? null;
}

export class ProfessionalSelfService {
  /** Vínculos ACEITOS do profissional (as clínicas onde ele atende), cross-org. */
  static clinics(professionalId: string): ClinicLink[] {
    const rows = db.prepare(
      `SELECT id, organization_id, status FROM clinic_professional_relationships WHERE professional_id = ? AND status = 'accepted' ORDER BY invited_at`
    ).all(String(professionalId || "")) as any[];
    return rows.map((r) => ({ organizationId: r.organization_id, clinicName: clinicName(r.organization_id), relationshipId: r.id, status: r.status }));
  }

  /** Identidade + clínicas — o "cabeçalho" do painel. */
  static overview(professionalId: string): any {
    const prof = ProfessionalService.getById(String(professionalId || ""));
    if (!prof) throw new Error("professional_not_found");
    return {
      professional: { id: prof.id, name: prof.name, council: prof.council, registrationNumber: prof.registrationNumber, specialties: prof.specialties, phone: prof.phone, email: prof.email },
      clinics: this.clinics(professionalId),
    };
  }

  /**
   * Agenda federada do profissional (todas as clínicas), numa janela. O profissional VÊ os
   * próprios atendimentos com quem/qual pet (é o atendimento DELE). Cancelado/no-show fora.
   */
  static agenda(professionalId: string, opts?: { fromISO?: string; toISO?: string; limit?: number }): any {
    const args: any[] = [String(professionalId || "")];
    let sql = `
      SELECT a.id, a.organization_id, a.title, a.scheduled_start, a.scheduled_end, a.status,
             a.network_relationship_id AS relationship_id, a.pet_id,
             c.name AS contact_name, p.name AS pet_name
      FROM appointments a
      JOIN clinic_professional_relationships r ON r.id = a.network_relationship_id
      LEFT JOIN contacts c ON c.id = a.contact_id AND c.organization_id = a.organization_id
      LEFT JOIN clinic_pets p ON p.id = a.pet_id AND p.organization_id = a.organization_id
      WHERE r.professional_id = ? AND a.status NOT IN ('cancelled','no_show')`;
    if (opts?.fromISO) { sql += ` AND a.scheduled_start >= ?`; args.push(opts.fromISO); }
    if (opts?.toISO) { sql += ` AND a.scheduled_start <= ?`; args.push(opts.toISO); }
    sql += ` ORDER BY a.scheduled_start ASC`;
    const limit = Math.min(Math.max(Number(opts?.limit) || 200, 1), 500);
    sql += ` LIMIT ${limit}`;
    const rows = db.prepare(sql).all(...args) as any[];
    return {
      appointments: rows.map((r) => ({
        id: r.id, relationshipId: r.relationship_id,
        clinicName: clinicName(r.organization_id),
        start: r.scheduled_start, end: r.scheduled_end, status: r.status,
        title: r.title, contactName: r.contact_name ?? null, petName: r.pet_name ?? null,
      })),
    };
  }

  /** Soma null-safe de dois totais de finanças (null = sem dado; não vira 0). */
  private static add(a: any, b: any): any {
    const s = (x: number | null, y: number | null) => (x == null && y == null ? null : (Number(x) || 0) + (Number(y) || 0));
    return {
      count: (a.count || 0) + (b.count || 0),
      gross: s(a.gross, b.gross), professionalAmount: s(a.professionalAmount, b.professionalAmount),
      clinicAmount: s(a.clinicAmount, b.clinicAmount), taxAmount: s(a.taxAmount, b.taxAmount),
      netProfessional: s(a.netProfessional, b.netProfessional), missingPrice: (a.missingPrice || 0) + (b.missingPrice || 0),
    };
  }

  /**
   * Financeiro do profissional AGREGADO por clínica (o que ele recebe/vai receber). Fan-out
   * do `ProfessionalFinanceService.statement` sobre os vínculos aceitos + total consolidado
   * realizado × previsto. Nunca inventa dinheiro (o statement já é honesto: sem preço → null).
   */
  static finance(professionalId: string, opts?: { fromISO?: string; toISO?: string }): any {
    const clinics = this.clinics(professionalId);
    const empty = { count: 0, gross: null, professionalAmount: null, clinicAmount: null, taxAmount: null, netProfessional: null, missingPrice: 0 };
    const byClinic = clinics.map((c) => {
      const st = ProfessionalFinanceService.statement(c.organizationId, c.relationshipId, opts);
      return { clinicName: c.clinicName, relationshipId: c.relationshipId, realized: st.realized, expected: st.expected };
    });
    const totals = byClinic.reduce((acc, c) => ({ realized: this.add(acc.realized, c.realized), expected: this.add(acc.expected, c.expected) }), { realized: { ...empty }, expected: { ...empty } });
    return { currency: "BRL", byClinic, totals };
  }
}

export default ProfessionalSelfService;
