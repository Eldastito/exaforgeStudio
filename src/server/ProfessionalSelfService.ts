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
import { ProfessionalScheduleConfigService, WindowInput } from "./ProfessionalScheduleConfigService.js";

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
             a.network_relationship_id AS relationship_id, a.pet_id, a.professional_ack_at,
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
        ackAt: r.professional_ack_at ?? null,
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

  // ── F7.3 — Escrita: o profissional edita a PRÓPRIA disponibilidade por clínica ──

  /**
   * Resolve o vínculo GARANTINDO que é DESTE profissional e está ACEITO — a barreira de
   * autorização da escrita (a sessão dá o professionalId; o vínculo tem de ser dele).
   * Devolve o orgId real do vínculo pra delegar aos serviços por-org. Cross-org por
   * professional_id (a identidade é global), nunca cruza outro profissional.
   */
  private static relScope(professionalId: string, relationshipId: string): { orgId: string; relationshipId: string } {
    const r = db.prepare(
      `SELECT id, organization_id, status FROM clinic_professional_relationships WHERE id = ? AND professional_id = ?`
    ).get(String(relationshipId || ""), String(professionalId || "")) as any;
    if (!r) throw new Error("relationship_not_found");                 // não é dele → isolamento
    if (r.status !== "accepted") throw new Error("relationship_not_accepted");
    return { orgId: r.organization_id, relationshipId: r.id };
  }

  /** Janelas de trabalho do profissional numa clínica dele (leitura). */
  static windows(professionalId: string, relationshipId: string): any {
    const { orgId, relationshipId: rid } = this.relScope(professionalId, relationshipId);
    return ProfessionalScheduleConfigService.listWindows(orgId, rid);
  }

  /**
   * O profissional define a PRÓPRIA disponibilidade numa clínica dele. Reusa o
   * `ProfessionalScheduleConfigService.setWindows` (mesma validação de dia/hora/buffer) —
   * a diferença é só QUEM autoriza: aqui é a sessão do profissional (relScope), não o
   * owner/admin da clínica.
   */
  static setWindows(professionalId: string, relationshipId: string, windows: WindowInput[]): any {
    const { orgId, relationshipId: rid } = this.relScope(professionalId, relationshipId);
    return ProfessionalScheduleConfigService.setWindows(orgId, rid, windows, `professional:${professionalId}`);
  }

  // ── F7.4 — Escrita: o profissional ACEITA/RECUSA um atendimento federado ──

  /**
   * Resolve o atendimento GARANTINDO que é de um vínculo DESTE profissional (join por
   * professional_id). Barreira de autorização da escrita sobre appointment. Devolve o
   * orgId real + status. Nunca alcança appointment de outro profissional.
   */
  private static apptScope(professionalId: string, appointmentId: string): { orgId: string; status: string } {
    const r = db.prepare(`
      SELECT a.organization_id, a.status FROM appointments a
      JOIN clinic_professional_relationships r ON r.id = a.network_relationship_id
      WHERE a.id = ? AND r.professional_id = ?
    `).get(String(appointmentId || ""), String(professionalId || "")) as any;
    if (!r) throw new Error("appointment_not_found");
    return { orgId: r.organization_id, status: r.status };
  }

  /**
   * O profissional CONFIRMA presença (ack). Não muda o status FSM (segue confirmed) — é um
   * sinal positivo pra clínica (`professional_ack_at`). Idempotente; não confirma cancelado.
   */
  static acceptAppointment(professionalId: string, appointmentId: string): any {
    const { orgId, status } = this.apptScope(professionalId, appointmentId);
    if (["cancelled", "no_show"].includes(status)) throw new Error("appointment_not_active");
    db.prepare(`UPDATE appointments SET professional_ack_at = COALESCE(professional_ack_at, CURRENT_TIMESTAMP) WHERE organization_id = ? AND id = ?`).run(orgId, appointmentId);
    const r = db.prepare(`SELECT id, status, professional_ack_at FROM appointments WHERE id = ?`).get(appointmentId) as any;
    return { id: r.id, status: r.status, ackAt: r.professional_ack_at };
  }

  /**
   * O profissional RECUSA o atendimento (não pode atender). Cancela (reusa
   * `ProfessionalBookingService.cancelBooking` — marca cancelled, preserva histórico, tira
   * do Google) e PUBLICA um sinal pra clínica reagir (rebook/waitlist) — nunca silencioso.
   */
  static async declineAppointment(professionalId: string, appointmentId: string, reason?: string): Promise<any> {
    const { orgId } = this.apptScope(professionalId, appointmentId);
    const { ProfessionalBookingService } = await import("./ProfessionalBookingService.js");
    const appt = await ProfessionalBookingService.cancelBooking(orgId, appointmentId, `professional:${professionalId}`);
    // Sinal pra clínica (convenção nº 12 — nunca tabela de alerta paralela). Best-effort.
    try {
      const { BusinessSignalService } = await import("./BusinessSignalService.js");
      BusinessSignalService.publish(orgId, {
        domain: "clinic",
        signalType: "professional_network/booking_declined",
        severity: "attention",
        basis: "fact",
        confidence: 1,
        sourceService: "ProfessionalSelfService",
        sourceEntityType: "appointment",
        sourceEntityId: appointmentId,
        dedupeKey: `clinic:prof_declined:${appointmentId}`,
        evidence: { professionalId, reason: reason || null, note: "O profissional recusou o atendimento — reagende ou coloque em espera." },
      } as any);
    } catch { /* best-effort */ }
    return appt;
  }
}

export default ProfessionalSelfService;
