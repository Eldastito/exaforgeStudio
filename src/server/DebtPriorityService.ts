import { RecoveryDebtService } from "./RecoveryDebtService.js";

/**
 * DebtPriorityService — Matriz de Priorização de Dívida (Financial Recovery OS,
 * PRD-ZF-UNIFIED-GAP-CLOSURE-03 F3.8 / PR-7). Read-only, determinística, sem tabela nova
 * (deriva do Mapa da Dívida — PR-5).
 *
 * REGRA CRÍTICA (F3.3 / RN-FR-3): o ZapFlow NÃO estabelece sozinho uma ordem jurídica
 * universal de pagamentos. Esta matriz SEPARA quatro eixos independentes — risco jurídico,
 * criticidade operacional, custo financeiro e negociabilidade — pontua cada um e EXPLICA;
 * o `priorityScore` composto é um AUXÍLIO de leitura, nunca um veredito de "pague esta
 * primeiro". Risco jurídico sempre remete a validação profissional (nunca parecer).
 *
 * Não expõe dinheiro (só scores/bands/labels/razões) → sem money-gating.
 */

export type Band = "low" | "medium" | "high";
interface Axis { score: number; band: Band | "unknown"; known: boolean }

export interface DebtPriorityItem {
  id: string;
  creditor: string;
  category: string;
  priorityScore: number;               // 0-100 — auxílio de leitura, NÃO ordem jurídica
  axes: { legalRisk: Axis; operationalCriticality: Axis; financialCost: Axis; negotiability: Axis };
  reason: string;
  recommendedStep: string;
  dataGaps: string[];
}

const BAND_SCORE: Record<Band, number> = { high: 100, medium: 60, low: 20 };
// Pesos do composto (transparentes). Somam 1. Negociabilidade entra como URGÊNCIA (baixa
// negociabilidade = mais urgente agir, pois não dá pra adiar/renegociar fácil).
const W = { legal: 0.30, operational: 0.30, cost: 0.25, negotiability: 0.15 };
const CAVEAT = "A matriz SEPARA risco jurídico, criticidade operacional, custo financeiro e negociabilidade e explica — NÃO é uma ordem jurídica de pagamento. Risco jurídico exige validação de profissional habilitado (RN-FR-3).";

function bandAxis(v: any): Axis {
  if (v === "high" || v === "medium" || v === "low") return { score: BAND_SCORE[v as Band], band: v, known: true };
  return { score: 40, band: "unknown", known: false }; // desconhecido não pune forte; baixa a confiança
}

export class DebtPriorityService {
  /** Prioriza as dívidas ativas por 4 eixos + composto explicável. Determinística. */
  static prioritize(orgId: string): { generatedAt: string; items: DebtPriorityItem[]; caveats: string[] } {
    const rows = RecoveryDebtService.list(orgId).filter((r: any) => r.status === "open" || r.status === "renegotiating");
    const items = rows.map((r: any) => this.scoreItem(r)).sort((a, b) => b.priorityScore - a.priorityScore);
    return { generatedAt: new Date().toISOString(), items, caveats: [CAVEAT] };
  }

  private static scoreItem(r: any): DebtPriorityItem {
    const dataGaps: string[] = [];
    const legalRisk = bandAxis(r.legal_risk);
    const operationalCriticality = bandAxis(r.operational_criticality);
    if (!legalRisk.known) dataGaps.push("risco jurídico não informado");
    if (!operationalCriticality.known) dataGaps.push("criticidade operacional não informada");

    // Custo financeiro: juros conhecido + fatia vencida. Sem ambos → desconhecido.
    const interest = num(r.interest_rate);
    const total = num(r.amount_total) || 0;
    const overdue = num(r.amount_overdue) || 0;
    const overdueShare = total > 0 ? Math.min(1, overdue / total) : 0;
    let costScore: number, costKnown = false;
    if (interest != null) {
      costKnown = true;
      const byInterest = interest >= 5 ? 100 : interest >= 2 ? 70 : interest >= 1 ? 45 : interest > 0 ? 25 : 10;
      costScore = clamp(Math.max(byInterest, overdueShare * 100)); // atraso também é custo
    } else if (overdue > 0) {
      costKnown = true; costScore = clamp(overdueShare * 100);
    } else {
      costScore = 40; dataGaps.push("juros/atraso não informados");
    }
    const financialCost: Axis = { score: costScore, band: costScore >= 70 ? "high" : costScore >= 40 ? "medium" : "low", known: costKnown };

    // Negociabilidade como URGÊNCIA de agir (baixa negociabilidade = mais urgente).
    const negRaw = r.negotiability;
    const negUrgencyScore = negRaw === "low" ? 100 : negRaw === "medium" ? 50 : negRaw === "high" ? 20 : 50;
    const negotiability: Axis = { score: negUrgencyScore, band: negRaw === "low" || negRaw === "medium" || negRaw === "high" ? negRaw : "unknown", known: negRaw != null };
    if (!negotiability.known) dataGaps.push("negociabilidade não informada");

    const priorityScore = round1(
      W.legal * legalRisk.score + W.operational * operationalCriticality.score +
      W.cost * financialCost.score + W.negotiability * negUrgencyScore,
    );

    return {
      id: r.id, creditor: r.creditor, category: r.category, priorityScore,
      axes: { legalRisk, operationalCriticality, financialCost, negotiability },
      reason: this.reason(legalRisk, operationalCriticality, financialCost, negRaw),
      recommendedStep: this.recommend(legalRisk, operationalCriticality, financialCost, negRaw),
      dataGaps,
    };
  }

  private static reason(legal: Axis, oper: Axis, cost: Axis, neg: any): string {
    const parts: string[] = [];
    if (legal.band === "high") parts.push("risco jurídico alto");
    if (oper.band === "high") parts.push("crítica pra operação");
    if (cost.band === "high") parts.push("custo financeiro alto (juros/atraso)");
    if (neg === "low") parts.push("baixa negociabilidade");
    const base = parts.length ? `Puxa a prioridade: ${parts.join(", ")}.` : "Sem eixo de alta urgência destacado.";
    return legal.band === "high" ? `${base} (hipótese — risco jurídico exige validação profissional)` : `${base} (hipótese)`;
  }

  private static recommend(legal: Axis, oper: Axis, cost: Axis, neg: any): string {
    if (legal.band === "high") return "Risco jurídico elevado — validar com contador/advogado habilitado antes de decidir a próxima medida.";
    if (neg === "high" && cost.band === "high") return "Alta negociabilidade + custo alto — priorizar renegociação/alongamento de prazo.";
    if (oper.band === "high") return "Crítica para a operação — proteger a continuidade (não interromper o essencial).";
    if (cost.band === "high") return "Custo financeiro alto — avaliar antecipar quitação/renegociar juros.";
    return "Acompanhar; sem ação urgente destacada no momento.";
  }
}

function num(v: any): number | null { const n = Number(v); return Number.isFinite(n) ? n : null; }
function clamp(n: number, lo = 0, hi = 100) { return Math.max(lo, Math.min(hi, n)); }
function round1(n: number) { return Math.round((Number(n) || 0) * 10) / 10; }

export default DebtPriorityService;
