/**
 * ProfessionalFinanceService — ADR-180 F8.1/F8.2: Finanças da Agenda Federada
 * (split clínica × profissional + imposto retido + previsão a receber).
 *
 * F8.2 acrescenta: (a) DIREÇÃO do split ABERTA — o % do vínculo é de UM lado
 * (`commission_beneficiary` = 'professional' | 'clinic', o combinado entre as partes) e
 * o outro fica com o resto; o financeiro SEMPRE mostra os dois. (b) IMPOSTO RETIDO na
 * fonte sobre o bruto do profissional (opt-in por vínculo; sem config → `taxAmount=null`,
 * nunca inventa CLT/ISS — RN-PN-4; líquido = bruto). (c) `forecast` — receita A RECEBER
 * por profissional (previsto = agendado ainda não atendido), com a data do 1º atendimento.
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
  status: string;                       // confirmed | completed | cancelled | no_show | ...
  realized: boolean;                    // status === 'completed' (ATENDIDO)
  currency: string;                     // 'BRL'
  gross: number | null;                 // preço acordado (snapshot); null se desconhecido
  commissionPercent: number | null;     // % do vínculo (o combinado entre as partes)
  commissionBeneficiary: string;        // 'professional' | 'clinic' — de quem é o %
  professionalAmount: number | null;    // parte BRUTA do profissional
  clinicAmount: number | null;          // parte da clínica
  taxWithholdingPercent: number | null; // % de imposto retido (null = sem retenção)
  taxAmount: number | null;             // imposto retido sobre o bruto do profissional (null se não configurado)
  netProfessional: number | null;       // líquido do profissional (bruto − retido)
  basis: SettlementBasis;               // fact=atendido · estimate=agendado · unknown=sem preço
}

export interface FinanceTotals {
  count: number;
  gross: number | null;                 // soma dos que têm preço (null se nenhum tem)
  professionalAmount: number | null;
  clinicAmount: number | null;
  taxAmount: number | null;             // soma dos impostos retidos (null se nenhum configurado)
  netProfessional: number | null;       // soma do líquido do profissional
  missingPrice: number;                 // quantos entraram sem preço (transparência)
}
export interface ProfessionalStatement {
  relationshipId: string;
  professionalId: string | null;
  professionalName: string | null;
  commissionPercent: number | null;
  commissionBeneficiary: string;
  taxWithholdingPercent: number | null;
  currency: string;
  realized: FinanceTotals;              // ATENDIDO (fact)
  expected: FinanceTotals;              // AGENDADO ainda não atendido (estimate)
  events: ServiceSettlement[];
}
export interface ProfessionalForecastRow {
  relationshipId: string;
  professionalId: string | null;
  professionalName: string | null;
  nextServiceDate: string | null;       // 1º atendimento previsto na janela (o "quando")
  expected: FinanceTotals;              // a receber (agendado ainda não atendido)
}
export interface FinanceForecast {
  currency: string;
  from: string | null;
  to: string | null;
  byProfessional: ProfessionalForecastRow[];
  totalNetProfessional: number | null;  // soma do líquido previsto (null se nada com preço)
}

const MONEY_STATUSES = new Set(["confirmed", "completed"]); // dinheiro só de vaga viva/atendida

function round2(n: number): number { return Math.round(n * 100) / 100; }

export class ProfessionalFinanceService {
  /** Deriva o acerto de UM appointment federado (a partir da linha + vínculo). */
  private static compute(row: any, rel: any): ServiceSettlement {
    const gross = row.network_service_price == null ? null : Number(row.network_service_price);
    const commissionPercent = rel && rel.commissionPercent != null ? Number(rel.commissionPercent) : null;
    const beneficiary: string = rel?.commissionBeneficiary === "clinic" ? "clinic" : "professional";
    let professionalAmount: number | null = null;
    let clinicAmount: number | null = null;
    if (gross != null && commissionPercent != null) {
      // O % é a parte de UM lado (o combinado); o outro fica com o resto. Sempre mostramos os dois.
      const share = round2(gross * commissionPercent / 100);
      if (beneficiary === "clinic") { clinicAmount = share; professionalAmount = round2(gross - share); }
      else { professionalAmount = share; clinicAmount = round2(gross - share); }
    }
    // Imposto retido na fonte sobre o BRUTO do profissional (opt-in). Sem config →
    // taxAmount null (não inventa CLT/ISS — RN-PN-4); nesse caso o líquido = bruto.
    const taxWithholdingPercent = rel && rel.taxWithholdingPercent != null ? Number(rel.taxWithholdingPercent) : null;
    let taxAmount: number | null = null;
    let netProfessional: number | null = null;
    if (professionalAmount != null) {
      if (taxWithholdingPercent != null) {
        taxAmount = round2(professionalAmount * taxWithholdingPercent / 100);
        netProfessional = round2(professionalAmount - taxAmount);
      } else {
        netProfessional = professionalAmount;
      }
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
      commissionBeneficiary: beneficiary,
      professionalAmount,
      clinicAmount,
      taxWithholdingPercent,
      taxAmount,
      netProfessional,
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
      commissionBeneficiary: rel.commissionBeneficiary,
      taxWithholdingPercent: rel.taxWithholdingPercent ?? null,
      currency: "BRL",
      realized: this.totals(events.filter((e) => e.realized)),
      expected: this.totals(events.filter((e) => !e.realized)),
      events,
    };
  }

  /**
   * Previsão de receita A RECEBER: por profissional (vínculo aceito), agrega o PREVISTO
   * (agendado ainda não atendido — AGENDADO ≠ ATENDIDO, RN-PN-5) numa janela opcional.
   * O "quando" é a data do 1º atendimento previsto (`nextServiceDate`). Só conta vaga
   * viva (`confirmed`); honesto (sem preço → não soma, `missingPrice` conta). Isolado por
   * org (RN-PN-2). Nunca inventa dinheiro nem data de repasse.
   */
  static forecast(orgId: string, opts?: { fromISO?: string; toISO?: string }): FinanceForecast {
    const rels = ClinicProfessionalRelationshipService.list(orgId, { status: "accepted" });
    const args: any[] = [orgId];
    let sql = `SELECT * FROM appointments WHERE organization_id = ? AND network_relationship_id IS NOT NULL AND status = 'confirmed'`;
    if (opts?.fromISO) { sql += ` AND scheduled_start >= ?`; args.push(opts.fromISO); }
    if (opts?.toISO) { sql += ` AND scheduled_start <= ?`; args.push(opts.toISO); }
    sql += ` ORDER BY scheduled_start ASC`;
    const rows = db.prepare(sql).all(...args) as any[];

    const byRel = new Map<string, any[]>();
    for (const r of rows) {
      const k = r.network_relationship_id;
      if (!byRel.has(k)) byRel.set(k, []);
      byRel.get(k)!.push(r);
    }

    const byProfessional: ProfessionalForecastRow[] = [];
    let totalNet = 0, anyNet = false;
    for (const rel of rels) {
      const relRows = byRel.get(rel.id) || [];
      if (!relRows.length) continue; // sem nada previsto → fora da previsão (não inventa linha)
      const events = relRows.map((r) => this.compute(r, rel));
      const expected = this.totals(events);
      const nextServiceDate = relRows.map((r) => r.scheduled_start).filter(Boolean).sort()[0] || null;
      if (expected.netProfessional != null) { totalNet += expected.netProfessional; anyNet = true; }
      byProfessional.push({
        relationshipId: rel.id,
        professionalId: rel.professionalId,
        professionalName: rel.professional?.name ?? null,
        nextServiceDate,
        expected,
      });
    }
    // Ordena por data prevista mais próxima (o que recebe primeiro).
    byProfessional.sort((a, b) => String(a.nextServiceDate || "~").localeCompare(String(b.nextServiceDate || "~")));

    return {
      currency: "BRL",
      from: opts?.fromISO ?? null,
      to: opts?.toISO ?? null,
      byProfessional,
      totalNetProfessional: anyNet ? round2(totalNet) : null,
    };
  }

  /**
   * Soma um conjunto de acertos. Cada campo fica null quando NENHUM evento o tinha (não
   * inventa 0 — RN-004/null≠zero): gross conta preço; prof/clínica contam o split (null
   * quando não há comissão configurada, mesmo com preço); imposto/líquido idem.
   */
  private static totals(events: ServiceSettlement[]): FinanceTotals {
    let gross = 0, prof = 0, clinic = 0, tax = 0, net = 0, missingPrice = 0;
    let anyPrice = false, anyProf = false, anyClinic = false, anyTax = false, anyNet = false;
    for (const e of events) {
      if (e.gross == null) { missingPrice++; continue; }
      anyPrice = true; gross += e.gross;
      if (e.professionalAmount != null) { prof += e.professionalAmount; anyProf = true; }
      if (e.clinicAmount != null) { clinic += e.clinicAmount; anyClinic = true; }
      if (e.taxAmount != null) { tax += e.taxAmount; anyTax = true; }
      if (e.netProfessional != null) { net += e.netProfessional; anyNet = true; }
    }
    return {
      count: events.length,
      gross: anyPrice ? round2(gross) : null,
      professionalAmount: anyProf ? round2(prof) : null,
      clinicAmount: anyClinic ? round2(clinic) : null,
      taxAmount: anyTax ? round2(tax) : null,
      netProfessional: anyNet ? round2(net) : null,
      missingPrice,
    };
  }
}

export default ProfessionalFinanceService;
