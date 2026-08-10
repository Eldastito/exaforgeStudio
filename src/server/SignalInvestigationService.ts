/**
 * SignalInvestigationService — PRD 2 F6.1 (§32-34, §76): o pipeline de
 * INVESTIGAÇÃO determinístico. Responde "por que isso provavelmente está
 * acontecendo?" sem LLM (a síntese por IA fica pra F6.2, atrás do gate §83).
 *
 * Pipeline econômico (§32): sinal → consultas determinísticas → correlações
 * (reusa a espinha da F3: mesmo sujeito / correlation_id) → contexto → CAUSAS
 * CANDIDATAS com evidência A FAVOR e CONTRA + confiança (§34).
 *
 * Guardrail duro (§13): NUNCA promove hipótese a fato. As causas saem como
 * `basis: 'hypothesis'` (o valor que a F2.1 introduziu) e a manchete é sempre
 * "a causa MAIS PROVÁVEL é…", nunca "a causa é…". Evidência contra baixa a
 * confiança — o sistema mostra a incerteza, não a esconde.
 */
import db from "./db.js";

interface CauseTemplate {
  cause: string;
  supportsIf: string[];      // signal_type OU domain de sinais correlatos que SUSTENTAM
  contradictsIf: string[];   // …que apontam pra OUTRA causa (baixam a confiança)
  base: number;              // confiança base (0..1)
}

// Registry extensível de hipóteses por tipo de sinal (§33). Determinístico.
const CAUSE_HYPOTHESES: Record<string, CauseTemplate[]> = {
  conversion_drop: convDrop(),
  sales_conversion_drop: convDrop(),
  retail_floor_conversion_drop: convDrop(),
  churn_risk_high: [
    { cause: "Silêncio prolongado somado a inadimplência", supportsIf: ["receivable_overdue", "promise_broken", "finance"], contradictsIf: [], base: 0.5 },
  ],
  stockout_risk: [
    { cause: "Fornecedor atrasado", supportsIf: ["supplier_delay", "procurement"], contradictsIf: [], base: 0.5 },
    { cause: "Demanda acima do padrão", supportsIf: ["consumo_acima_padrao", "demand_spike", "sales"], contradictsIf: [], base: 0.4 },
  ],
};
function convDrop(): CauseTemplate[] {
  return [
    { cause: "Demora no follow-up (tempo de resposta acima do normal)", supportsIf: ["response_delay", "sla_breach", "stalled_opportunities", "sales_stalled"], contradictsIf: ["traffic_drop", "price_change"], base: 0.5 },
    { cause: "Queda de tráfego/demanda", supportsIf: ["traffic_drop", "demand_drop"], contradictsIf: [], base: 0.3 },
    { cause: "Ruptura de estoque no item procurado", supportsIf: ["stockout_risk", "stockout_confirmed", "retail_floor_unmet_demand"], contradictsIf: [], base: 0.35 },
  ];
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

export class SignalInvestigationService {
  /**
   * Investiga um sinal: reúne sinais de contexto (mesmo sujeito / correlation_id,
   * na janela) e deriva causas-candidatas com evidência a favor/contra. Sem IA.
   */
  static investigate(orgId: string, signalId: string, opts: { windowHours?: number; now?: number } = {}): {
    signalId: string; found: boolean; aiUsed: false; headline: string;
    candidateCauses: Array<{ cause: string; confidence: number; basis: "hypothesis"; supportingEvidence: any[]; contradictingEvidence: any[] }>;
    contextSignalCount: number; note: string | null; investigatedAt: string;
  } {
    const now = opts.now || Date.now();
    const windowMs = Math.max(1, opts.windowHours ?? 72) * 3600e3;
    const sig = db.prepare(`SELECT * FROM business_signals WHERE id = ? AND organization_id = ?`).get(signalId, orgId) as any;
    const empty = (found: boolean, note: string | null) => ({ signalId, found, aiUsed: false as const, headline: "Sem causa provável determinística.", candidateCauses: [], contextSignalCount: 0, note, investigatedAt: new Date(now).toISOString() });
    if (!sig) return empty(false, "Sinal não encontrado.");

    // Contexto: sinais abertos do MESMO sujeito ou da MESMA cadeia, na janela.
    const ctx = (db.prepare(
      `SELECT * FROM business_signals
        WHERE organization_id = ? AND id != ? AND status = 'open'
          AND ( (subject_type IS NOT NULL AND subject_type = ? AND subject_id = ?) OR (correlation_id IS NOT NULL AND correlation_id = ?) )`
    ).all(orgId, signalId, sig.subject_type, sig.subject_id, sig.correlation_id) as any[])
      .filter((r) => (now - (Date.parse(r.detected_at || "") || now)) <= windowMs);

    const templates = CAUSE_HYPOTHESES[sig.signal_type] || null;
    if (!templates) return { ...empty(true, "Sem hipótese determinística pra este tipo; síntese por IA fica pra F6.2."), contextSignalCount: ctx.length };

    const matches = (r: any, keys: string[]) => keys.includes(r.signal_type) || keys.includes(r.domain);
    const brief = (r: any) => ({ signalId: r.id, type: r.signal_type, domain: r.domain, severity: r.severity, subjectId: r.subject_id ?? null });

    const candidateCauses = templates.map((t) => {
      const supportingEvidence = ctx.filter((r) => matches(r, t.supportsIf)).map(brief);
      const contradictingEvidence = ctx.filter((r) => matches(r, t.contradictsIf)).map(brief);
      // Confiança: base + evidência a favor − evidência contra. Determinístico.
      const confidence = Math.round(clamp01(t.base + 0.15 * supportingEvidence.length - 0.2 * contradictingEvidence.length) * 100) / 100;
      return { cause: t.cause, confidence, basis: "hypothesis" as const, supportingEvidence, contradictingEvidence };
    }).filter((c) => c.confidence > 0).sort((a, b) => b.confidence - a.confidence);

    // §13 — manchete sempre PROVÁVEL, nunca afirmada; só se houver apoio real.
    const top = candidateCauses[0];
    const headline = top && top.supportingEvidence.length > 0
      ? `A causa mais provável é: ${top.cause} (confiança ${Math.round(top.confidence * 100)}%). Correlação, não causalidade comprovada.`
      : "Correlações insuficientes pra apontar uma causa provável — apenas candidatas.";

    return { signalId, found: true, aiUsed: false, headline, candidateCauses, contextSignalCount: ctx.length, note: null, investigatedAt: new Date(now).toISOString() };
  }
}
