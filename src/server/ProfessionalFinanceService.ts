/**
 * ProfessionalFinanceService — ADR-180 F8.1: Finanças da Agenda Federada
 * (split clínica × profissional).
 *
 * Fecha a parte da visão original do dono: "quanto vai receber, o percentual da clínica
 * e dele separados, realizado × previsto". É um READ-MODEL DERIVADO (RN-004 — sem
 * contador mutável, sem ledger paralelo §184/RN-PN-7): cada atendimento federado
 * (appointment com `network_relationship_id`) vira um acerto calculado na hora a partir de
 *   • o preço ACORDADO no agendamento (`network_service_price`, snapshot da F8.1 — o valor
 *     devido é o combinado quando reservou, não o catálogo de hoje);
 *   • a comissão do vínculo (`relationship.commission_percent` — a parte do profissional);
 *   • o STATUS do appointment: `completed` = ATENDIDO (realizado/`fact`) × `confirmed` =
 *     AGENDADO (previsto/`estimate`) — AGENDADO ≠ ATENDIDO (RN-PN-5).
 *
 * Honestidade dura (RN-PN-4 / não inventa dinheiro): sem preço → `gross=null`; sem
 * comissão → `professionalAmount=null` (nunca assume 0 nem 100%). Isolamento por org
 * (RN-PN-2 — orgId 1º arg; só appointments DESTA org e DESTE vínculo). Cancelado/no-show
 * fica FORA do dinheiro. Determinístico.
 */
import db from "./db.js";
import { ClinicProfessionalRelationshipService } from "./ClinicProfessionalRelationshipService.js";

export type SettlementBasis = "fact" | "estimate" | "unknown";
export interface ServiceSettlement {
  appointmentId: string;
  relationshipId: string | null;
  professionalId: string | null;
  professionalName: string | null;
  contactId: string | null;
  petId: string | null;
  serviceId: string | null;
  serviceName: string | null;
  scheduledStart: string | null;
  status: string;                     // confirmed | completed | cancelled | no_show | ...
  realized: boolean;                  // status === 'completed' (ATENDIDO)
  currency: string;                   // 'BRL'
  gross: number | null;               // preço acordado (snapshot); null se desconhecido
  commissionPercent: number | null;   // % do profissional (do vínculo)
  professionalAmount: number | null;  // gross * commission%/100
  clinicAmount: number | null;        // gross - professionalAmount
  basis: SettlementBasis;             // fact=atendido · estimate=agendado · unknown=sem preço
}

export interface FinanceTotals {
  count: number;
  gross: number | null;               // soma dos que têm preço (null se nenhum tem)
  professionalAmount: number | null;
  clinicAmount: number | null;
  missingPrice: number;               // quantos entraram sem preço (transparência)
}
export interface ProfessionalStatement {
  relationshipId: string;
  professionalId: string | null;
  professionalName: string | null;
  commissionPercent: number | null;
  currency: string;
  realized: FinanceTotals;            // ATENDIDO (fact)
  expected: FinanceTotals;            // AGENDADO ainda não atendido (estimate)
  events: ServiceSettlement[];
}

const MONEY_STATUSES = new Set(["confirmed", "completed"]); // dinheiro só de vaga viva/atendida

function round2(n: number): number { return Math.round(n * 100) / 100; }

export class ProfessionalFinanceService {
  /** Deriva o acerto de UM appointment federado (a partir da linha + vínculo). */
  private static compute(row: any, rel: any): ServiceSettlement {
    const gross = row.network_service_price == null ? null : Number(row.network_service_price);
    const commissionPercent = rel && rel.commissionPercent != null ? Number(rel.commissionPercent) : null;
    let professionalAmount: number | null = null;
    let clinicAmount: number | null = null;
    if (gross != null && commissionPercent != null) {
      professionalAmount = round2(gross * commissionPercent / 100);
      clinicAmount = round2(gross - professionalAmount);
    }
    const realized = row.status === "completed";
    const basis: SettlementBasis = gross == null ? "unknown" : (realized ? "fact" : "estimate");
    let serviceName: string | null = null;
    if (row.network_service_id) {
      const svc = db.prepare(`SELECT name FROM products_services WHERE id = ? AND organization_id = ?`).get(row.network_service_id, row.organization_id) as any;
      serviceName = svc ? svc.name : null;
    }
    return {
      appointmentId: row.id,
      relationshipId: row.network_relationship_id ?? null,
      professionalId: rel?.professionalId ?? null,
      professionalName: rel?.professional?.name ?? row.professional_name_snapshot ?? null,
      contactId: row.contact_id ?? null,
      petId: row.pet_id ?? null,
      serviceId: row.network_service_id ?? null,
      serviceName,
      scheduledStart: row.scheduled_start ?? null,
      status: row.status,
      realized,
      currency: "BRL",
      gross,
      commissionPercent,
      professionalAmount,
      clinicAmount,
      basis,
    };
  }

  /** Acerto de um único atendimento federado. Lança se não for federado/desta org. */
  static settlement(orgId: string, appointmentId: string): ServiceSettlement {
    const row = db.prepare(
      `SELECT * FROM appointments WHERE organization_id = ? AND id = ? AND network_relationship_id IS NOT NULL`
    ).get(orgId, String(appointmentId || "")) as any;
    if (!row) throw new Error("appointment_not_found");
    const rel = ClinicProfessionalRelationshipService.get(orgId, row.network_relationship_id);
    return this.compute(row, rel);
  }

  /**
   * Extrato do profissional (por vínculo): os atendimentos federados + totais
   * REALIZADO (atendido/fact) × PREVISTO (agendado/estimate). Filtro opcional por
   * intervalo (scheduled_start). Cancelado/no-show fica fora do dinheiro (mas fora da
   * lista também — só as vagas vivas/atendidas contam). Isolado por org (RN-PN-2).
   */
  static statement(
    orgId: string, relationshipId: string,
    opts?: { fromISO?: string; toISO?: string },
  ): ProfessionalStatement {
    const rel = ClinicProfessionalRelationshipService.get(orgId, String(relationshipId || ""));
    if (!rel) throw new Error("relationship_not_found");

    const args: any[] = [orgId, relationshipId];
    let sql = `SELECT * FROM appointments WHERE organization_id = ? AND network_relationship_id = ? AND status IN ('confirmed','completed')`;
    if (opts?.fromISO) { sql += ` AND scheduled_start >= ?`; args.push(opts.fromISO); }
    if (opts?.toISO) { sql += ` AND scheduled_start <= ?`; args.push(opts.toISO); }
    sql += ` ORDER BY scheduled_start DESC`;
    const rows = db.prepare(sql).all(...args) as any[];

    const events = rows.map((r) => this.compute(r, rel));
    return {
      relationshipId: rel.id,
      professionalId: rel.professionalId,
      professionalName: rel.professional?.name ?? null,
      commissionPercent: rel.commissionPercent ?? null,
      currency: "BRL",
      realized: this.totals(events.filter((e) => e.realized)),
      expected: this.totals(events.filter((e) => !e.realized)),
      events,
    };
  }

  /** Soma um conjunto de acertos, mantendo null quando NENHUM tem preço (não inventa 0). */
  private static totals(events: ServiceSettlement[]): FinanceTotals {
    let gross = 0, prof = 0, clinic = 0, withPrice = 0, missingPrice = 0;
    for (const e of events) {
      if (e.gross == null) { missingPrice++; continue; }
      withPrice++;
      gross += e.gross;
      if (e.professionalAmount != null) prof += e.professionalAmount;
      if (e.clinicAmount != null) clinic += e.clinicAmount;
    }
    return {
      count: events.length,
      gross: withPrice ? round2(gross) : null,
      professionalAmount: withPrice ? round2(prof) : null,
      clinicAmount: withPrice ? round2(clinic) : null,
      missingPrice,
    };
  }
}

export default ProfessionalFinanceService;
