import db from "./db.js";
import { ApprovalPolicyService } from "./ApprovalPolicyService.js";

/**
 * ImpactPrioritizationService (ADR-136, Epic 2 — C3).
 *
 * Motor de Concentração de Impacto / Pareto (PRD §9). Ranqueia os sinais
 * ABERTOS por um score DETERMINÍSTICO (sem LLM, reproduzível em teste) para
 * responder "o que atacar primeiro" — no máximo 3 prioridades globais e até 3
 * por domínio. Cada prioridade explica seu ranking e traz os campos do §9.3.
 *
 * Score (PRD §9.2):
 *   priority_score = normalized_impact*0.40 + urgency*0.20 + confidence*0.15
 *                  + strategic_weight*0.15 + actionability*0.10
 *
 * Regras: impacto normalizado DENTRO da mesma unidade; BRL tem preferência;
 * eventos críticos de segurança/compliance podem ultrapassar o ranking
 * financeiro; sinais do mesmo tipo/evento são agrupados. Isolado por org.
 */

const WEIGHTS = { impact: 0.4, urgency: 0.2, confidence: 0.15, strategic: 0.15, actionability: 0.1 };

// Peso estratégico por domínio (0..1). Segurança/compliance no topo (podem
// ultrapassar o financeiro via override abaixo).
const STRATEGIC: Record<string, number> = {
  security: 1.0, compliance: 1.0,
  finance: 1.0, procurement: 0.85, inventory: 0.85, sales: 0.8, retail_ops: 0.7, tasks: 0.55,
};
const STRATEGIC_DEFAULT = 0.6;

const URGENCY: Record<string, number> = { critical: 1.0, risk: 0.7, attention: 0.4, info: 0.15 };

// Preferência por unidade (PRD §9.2: "Impacto em BRL tem preferência").
const UNIT_PREF: Record<string, number> = { BRL: 1.0, hours: 0.85, units: 0.85, percent: 0.85, score: 0.85 };

// Mapa sinal → ação recomendada (rótulo + action_type p/ resolver a aprovação).
const ACTION_MAP: Record<string, { actionType: string; label: string }> = {
  receivable_overdue: { actionType: "collection", label: "Cobrar recebíveis vencidos" },
  cash_below_minimum: { actionType: "collection", label: "Reforçar o caixa (cobrar/negociar)" },
  cash_break_risk: { actionType: "collection", label: "Antecipar entradas e postergar saídas" },
  payable_due_soon: { actionType: "prepare_purchase", label: "Revisar contas a vencer" },
  owner_draw_excess: { actionType: "create_task", label: "Revisar retiradas do proprietário" },
  data_quality_low: { actionType: "create_task", label: "Corrigir a qualidade dos dados" },
};

// Prazo sugerido por severidade (determinístico; sem calendário).
const DUE_HINT: Record<string, string> = { critical: "hoje", risk: "esta semana", attention: "este mês", info: "sem prazo" };

// Responsável sugerido por domínio (perfil, não pessoa).
const OWNER_HINT: Record<string, string> = { finance: "owner", procurement: "admin", inventory: "admin", sales: "admin", retail_ops: "admin", tasks: "admin" };

const clamp01 = (n: number) => Math.max(0, Math.min(1, Number(n) || 0));
const round4 = (n: number) => Math.round((Number(n) || 0) * 10000) / 10000;
const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

export class ImpactPrioritizationService {
  /**
   * Calcula as prioridades a partir dos sinais ABERTOS. Retorna `{ global, byDomain }`.
   * `global` = até 3 no total; `byDomain` = até 3 por domínio.
   */
  static prioritize(orgId: string, opts: { globalLimit?: number; perDomain?: number } = {}): any {
    const globalLimit = Math.max(1, Number(opts.globalLimit) || 3);
    const perDomain = Math.max(1, Number(opts.perDomain) || 3);

    const signals = db.prepare("SELECT * FROM business_signals WHERE organization_id = ? AND status = 'open'").all(orgId) as any[];
    if (!signals.length) return { global: [], byDomain: {}, generatedAt: nowIso() };

    // Máximo de |impacto| por unidade → normalização DENTRO da mesma unidade.
    const maxByUnit: Record<string, number> = {};
    for (const s of signals) {
      const unit = s.impact_unit || "_none";
      const amt = Math.abs(Number(s.impact_amount) || 0);
      if (amt > (maxByUnit[unit] || 0)) maxByUnit[unit] = amt;
    }

    // Agrupa "consequência do mesmo evento": por (domínio, tipo) fica o de maior score.
    const byGroup = new Map<string, any>();
    for (const s of signals) {
      const scored = this.scoreSignal(orgId, s, maxByUnit);
      const key = `${s.domain}:${s.signal_type}`;
      const prev = byGroup.get(key);
      if (!prev) { byGroup.set(key, { ...scored, groupedCount: 1 }); }
      else {
        prev.groupedCount += 1;
        if (scored.score > prev.score) { byGroup.set(key, { ...scored, groupedCount: prev.groupedCount }); }
      }
    }

    const all = Array.from(byGroup.values()).sort(rank);
    const global = all.slice(0, globalLimit).map((p, i) => ({ ...p, rank: i + 1 }));

    const byDomain: Record<string, any[]> = {};
    for (const p of all) {
      (byDomain[p.domain] ||= []).push(p);
    }
    for (const d of Object.keys(byDomain)) {
      byDomain[d] = byDomain[d].slice(0, perDomain).map((p, i) => ({ ...p, rank: i + 1 }));
    }

    return { global, byDomain, generatedAt: nowIso() };
  }

  /** Score determinístico de um sinal + a saída obrigatória do §9.3. */
  private static scoreSignal(orgId: string, s: any, maxByUnit: Record<string, number>): any {
    const severity = String(s.severity || "info");
    const urgency = URGENCY[severity] ?? 0.15;
    const confidence = clamp01(s.confidence);
    const strategicBase = STRATEGIC[s.domain] ?? STRATEGIC_DEFAULT;

    const unit = s.impact_unit || "_none";
    const amt = Math.abs(Number(s.impact_amount) || 0);
    const unitMax = maxByUnit[unit] || 0;
    const unitPref = UNIT_PREF[s.impact_unit] ?? 0.85;
    // Impacto normalizado DENTRO da unidade; sem valor → proxy pela urgência.
    const normalizedImpact = unitMax > 0 ? clamp01((amt / unitMax) * unitPref) : clamp01(urgency * 0.5);

    const action = ACTION_MAP[s.signal_type] || null;
    // Acionabilidade: fato > estimativa; ação conhecida soma.
    let actionability = s.basis === "fact" ? 0.9 : 0.6;
    if (action) actionability = clamp01(actionability + 0.1);

    // Override: crítico de segurança/compliance pode ultrapassar o financeiro.
    const override = (s.domain === "security" || s.domain === "compliance") && severity === "critical";
    const strategic = override ? 1.0 : strategicBase;

    const score = round4(
      normalizedImpact * WEIGHTS.impact +
      urgency * WEIGHTS.urgency +
      confidence * WEIGHTS.confidence +
      strategic * WEIGHTS.strategic +
      actionability * WEIGHTS.actionability
    );

    // Aprovação necessária p/ a ação recomendada (reusa a política da C2a).
    let approval: any = null;
    if (action) {
      const pol = ApprovalPolicyService.resolve(orgId, { domain: s.domain, actionType: action.actionType, expectedImpact: s.impact_amount });
      approval = { policy: pol.policy, requiredRole: pol.requiredRole };
    }

    const evidence = safeParse(s.evidence_json);
    return {
      signalId: s.id,
      domain: s.domain,
      signalType: s.signal_type,
      override,
      score,
      components: {
        normalizedImpact: round4(normalizedImpact),
        urgency: round4(urgency),
        confidence: round4(confidence),
        strategicWeight: round4(strategic),
        actionability: round4(actionability),
      },
      // Saída obrigatória (PRD §9.3):
      fact: s.signal_type,
      interpretation: interpret(s),
      impact: s.impact_amount != null ? { amount: round2(s.impact_amount), unit: s.impact_unit || null } : null,
      basis: s.basis,
      confidence,
      evidence,
      source: s.source_service,
      recommendedAction: action?.label || "Registrar e acompanhar",
      recommendedActionType: action?.actionType || null,
      suggestedOwner: OWNER_HINT[s.domain] || "admin",
      dueHint: DUE_HINT[severity] || "sem prazo",
      approvalNeeded: approval,
      howMeasured: "Resultado registrado como outcome (esperado × realizado) ao concluir a ação.",
      reason: reason(s, severity, override),
    };
  }
}

// Ordenação: overrides de segurança/compliance primeiro; depois por score;
// desempate por severidade e impacto (determinístico e reproduzível).
function rank(a: any, b: any): number {
  if (a.override !== b.override) return a.override ? -1 : 1;
  if (b.score !== a.score) return b.score - a.score;
  const sev = (URGENCY[b.signalType] || 0) - (URGENCY[a.signalType] || 0);
  if (sev !== 0) return sev;
  const ia = a.impact?.amount != null ? Math.abs(a.impact.amount) : 0;
  const ib = b.impact?.amount != null ? Math.abs(b.impact.amount) : 0;
  if (ib !== ia) return ib - ia;
  return String(a.signalId).localeCompare(String(b.signalId));
}

function interpret(s: any): string {
  const impact = s.impact_amount != null ? (s.impact_unit === "BRL" ? brl(s.impact_amount) : `${round2(s.impact_amount)} ${s.impact_unit || ""}`.trim()) : "impacto não quantificado";
  return `Sinal '${s.signal_type}' no domínio ${s.domain}, ${s.basis === "fact" ? "comprovado" : "estimado"}, com impacto de ${impact}.`;
}

function reason(s: any, severity: string, override: boolean): string {
  if (override) return `Evento crítico de ${s.domain}: prioridade máxima por segurança/compliance, acima do ranking financeiro.`;
  const parts: string[] = [];
  if (s.impact_amount != null) parts.push(`impacto ${s.impact_unit === "BRL" ? brl(s.impact_amount) : `${round2(s.impact_amount)} ${s.impact_unit || ""}`.trim()}`);
  parts.push(`severidade ${severity}`);
  parts.push(`confiança ${Math.round(clamp01(s.confidence) * 100)}%`);
  parts.push(s.basis === "fact" ? "fato" : "estimativa");
  return `Priorizado por ${parts.join(", ")}.`;
}

function brl(n: number): string { return `R$ ${(Number(n) || 0).toFixed(2).replace(".", ",")}`; }
function safeParse(s: string): any { try { return JSON.parse(s); } catch { return {}; } }
function nowIso(): string { return new Date().toISOString(); }

export default ImpactPrioritizationService;
