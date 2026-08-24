import db from "./db.js";
import { MissionService, Mission } from "./MissionService.js";

/**
 * MissionReversePlanner — ADR-189 F3 (Mission OS): PLANEJAMENTO REVERSO.
 *
 * Uma das ~4 primitivas genuinamente novas (grep reverse-plan/critical-path = zero na F0).
 * Parte do ESTADO FINAL desejado e desce, de trás pra frente, até a ação de hoje (§11):
 *   Receita alvo ÷ ticket médio      → vendas necessárias
 *   vendas ÷ conversão (opp→venda)   → oportunidades necessárias
 *   oportunidades ÷ conversão (contato→opp) → contatos necessários
 *   contatos necessários − base disponível  → GAP
 * Mostra o GARGALO (caminho crítico, §14) e o Último Momento Seguro (§15) — muito mais útil
 * que um gráfico. DETERMINÍSTICO (RN-MOL-3/§12): aritmética + derivação por query; LLM fora.
 *
 * HONESTO (RN-MOL): cada premissa é DERIVADA do dado real (ticket médio de `orders`, base de
 * `contacts`) OU informada; SEM a premissa, o estágio fica `unknown` e a cadeia PARA ali — NUNCA
 * inventa taxa/ticket. Read-only, isolado por org. Não executa nem grava (planeja).
 */

const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

export interface ReversePlanOpts {
  avgTicket?: number | null;              // BRL por venda (senão derivado de orders)
  saleConversionRate?: number | null;     // oportunidade → venda (0..1)
  contactConversionRate?: number | null;  // contato → oportunidade (0..1)
  baseAvailable?: number | null;          // contatos disponíveis (senão derivado de contacts)
  leadTimeDays?: number | null;           // antecedência mínima da 1ª ação (p/ Último Momento Seguro)
  asOf?: string;
}

type StageBasis = "target" | "derived" | "assumed" | "unknown";
export interface PlanStage {
  stage: string; label: string; value: number | null; unit: "BRL" | "count"; basis: StageBasis; assumption?: string;
}

export interface ReversePlan {
  missionId: string;
  applicable: boolean;                    // só missões de receita têm a cadeia completa (por ora)
  targetMetric: string | null;
  targetValue: number | null;
  chain: PlanStage[];
  base: { available: number | null; source: "contacts" | "provided" | "unknown" };
  gap: { stage: string; needed: number; available: number; missing: number } | null;
  criticalStage: string | null;           // o gargalo
  lastSafeMoment: { date: string; leadTimeDays: number } | null;
  confidence: "low" | "medium" | "high";
  assumptions: { avgTicket: number | null; avgTicketSource: string; saleConversionRate: number | null; contactConversionRate: number | null };
  note: string;
}

export class MissionReversePlanner {
  /** Ticket médio das vendas pagas (derivado). null se não houver pedido. */
  private static deriveAvgTicket(orgId: string): number | null {
    try {
      const r = db.prepare(`
        SELECT COALESCE(SUM(oi.line_total),0) rev, COUNT(DISTINCT o.id) n
        FROM order_items oi JOIN orders o ON o.id = oi.order_id
        WHERE oi.organization_id = ? AND o.status IN ('pago','em_preparo','entregue','concluido')
      `).get(orgId) as any;
      return r && Number(r.n) > 0 ? round2(Number(r.rev) / Number(r.n)) : null;
    } catch { return null; }
  }
  private static deriveBase(orgId: string): number | null {
    try { return Number((db.prepare(`SELECT COUNT(*) n FROM contacts WHERE organization_id = ?`).get(orgId) as any).n); }
    catch { return null; }
  }

  static plan(orgId: string, missionId: string, opts: ReversePlanOpts = {}): ReversePlan {
    const mission = MissionService.get(orgId, missionId);
    if (!mission) throw new Error("Missão não encontrada.");
    const target = mission.targetValue;
    const isRevenue = mission.targetMetric === "revenue";

    const avgTicketSource = opts.avgTicket != null ? "provided" : "orders";
    const avgTicket = opts.avgTicket != null ? Number(opts.avgTicket) : this.deriveAvgTicket(orgId);
    const saleRate = opts.saleConversionRate != null ? Number(opts.saleConversionRate) : null;
    const contactRate = opts.contactConversionRate != null ? Number(opts.contactConversionRate) : null;
    const base = opts.baseAvailable != null ? Number(opts.baseAvailable) : this.deriveBase(orgId);
    const baseSource: "contacts" | "provided" | "unknown" = opts.baseAvailable != null ? "provided" : (base != null ? "contacts" : "unknown");

    const assumptions = { avgTicket: avgTicket ?? null, avgTicketSource, saleConversionRate: saleRate, contactConversionRate: contactRate };

    // Missão qualitativa / sem alvo numérico / não-receita → sem cadeia completa (honesto).
    if (!isRevenue || target == null || target <= 0) {
      return {
        missionId, applicable: false, targetMetric: mission.targetMetric, targetValue: target,
        chain: [], base: { available: base, source: baseSource }, gap: null, criticalStage: null,
        lastSafeMoment: this.lastSafeMoment(mission, opts),
        confidence: "low", assumptions,
        note: isRevenue ? "Defina o valor-alvo (R$) da missão para o planejamento reverso." : "Planejamento reverso completo hoje só para missões de receita; esta missão é acompanhada por marcos.",
      };
    }

    const chain: PlanStage[] = [{ stage: "revenue", label: "Receita alvo", value: round2(target), unit: "BRL", basis: "target" }];

    // Receita ÷ ticket → vendas
    let salesNeeded: number | null = null;
    if (avgTicket && avgTicket > 0) { salesNeeded = Math.ceil(target / avgTicket); chain.push({ stage: "sales", label: "Vendas necessárias", value: salesNeeded, unit: "count", basis: avgTicketSource === "provided" ? "assumed" : "derived", assumption: `ticket médio ${avgTicket}` }); }
    else { chain.push({ stage: "sales", label: "Vendas necessárias", value: null, unit: "count", basis: "unknown", assumption: "ticket médio desconhecido (sem vendas registradas)" }); }

    // Vendas ÷ conversão → oportunidades
    let oppsNeeded: number | null = null;
    if (salesNeeded != null && saleRate && saleRate > 0) { oppsNeeded = Math.ceil(salesNeeded / saleRate); chain.push({ stage: "opportunities", label: "Oportunidades necessárias", value: oppsNeeded, unit: "count", basis: "assumed", assumption: `conversão ${Math.round(saleRate * 100)}%` }); }
    else if (salesNeeded != null) { chain.push({ stage: "opportunities", label: "Oportunidades necessárias", value: null, unit: "count", basis: "unknown", assumption: "taxa de conversão oportunidade→venda não informada" }); }

    // Oportunidades ÷ conversão → contatos
    let contactsNeeded: number | null = null;
    if (oppsNeeded != null && contactRate && contactRate > 0) { contactsNeeded = Math.ceil(oppsNeeded / contactRate); chain.push({ stage: "contacts", label: "Contatos necessários", value: contactsNeeded, unit: "count", basis: "assumed", assumption: `conversão ${Math.round(contactRate * 100)}%` }); }
    else if (oppsNeeded != null) { chain.push({ stage: "contacts", label: "Contatos necessários", value: null, unit: "count", basis: "unknown", assumption: "taxa de conversão contato→oportunidade não informada" }); }

    // GAP: contatos necessários × base disponível
    let gap: ReversePlan["gap"] = null;
    let criticalStage: string | null = null;
    if (contactsNeeded != null && base != null) {
      const missing = Math.max(0, contactsNeeded - base);
      gap = { stage: "contacts", needed: contactsNeeded, available: base, missing };
      if (missing > 0) criticalStage = "contacts"; // a base não sustenta a meta → gargalo é gerar oportunidades
    }
    // Se a cadeia parou antes por premissa faltante, o gargalo é o 1º estágio unknown.
    if (!criticalStage) {
      const firstUnknown = chain.find((s) => s.basis === "unknown");
      if (firstUnknown) criticalStage = firstUnknown.stage;
    }

    // Confiança: quantos estágios são derivados de dado vs. assumidos/unknown.
    const knownStages = chain.filter((s) => s.value != null).length;
    const confidence: ReversePlan["confidence"] = knownStages >= 4 ? (avgTicketSource === "orders" ? "high" : "medium") : knownStages >= 2 ? "medium" : "low";

    const note = criticalStage === "contacts" && gap && gap.missing > 0
      ? `Com as taxas atuais, sua base (${gap.available}) não sustenta a meta — faltam ~${gap.missing} contatos/oportunidades. É preciso gerar demanda ou melhorar conversão/ticket.`
      : gap && gap.missing === 0
        ? `Sua base atual (${gap.available}) comporta a meta com as taxas informadas.`
        : `Faltam premissas para completar a cadeia (${criticalStage || "—"}). Informe ${chain.find((s) => s.basis === "unknown")?.assumption || "as taxas"}.`;

    return {
      missionId, applicable: true, targetMetric: mission.targetMetric, targetValue: round2(target),
      chain, base: { available: base, source: baseSource }, gap, criticalStage,
      lastSafeMoment: this.lastSafeMoment(mission, opts), confidence, assumptions, note,
    };
  }

  /** §15 — Último Momento Seguro: até quando a 1ª ação pode começar sem comprometer o prazo. */
  private static lastSafeMoment(mission: Mission, opts: ReversePlanOpts): ReversePlan["lastSafeMoment"] {
    if (!mission.deadline) return null;
    const lead = opts.leadTimeDays != null && opts.leadTimeDays >= 0 ? Number(opts.leadTimeDays) : 7; // default 7 dias de antecedência
    const dl = new Date(`${mission.deadline}T00:00:00Z`);
    if (isNaN(dl.getTime())) return null;
    dl.setUTCDate(dl.getUTCDate() - lead);
    return { date: dl.toISOString().slice(0, 10), leadTimeDays: lead };
  }
}

export default MissionReversePlanner;
