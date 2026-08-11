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
import { isAIConfigured, chat } from "./llm.js";
import { ImpactPrioritizationService } from "./ImpactPrioritizationService.js";
import { DetectorBudgetService } from "./DetectorBudgetService.js";

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

  /**
   * F6.2 (§81-83) — investigação PROFUNDA: sobre as causas-candidatas
   * determinísticas (F6.1), o LLM SINTETIZA a explicação — mas só quando o nível
   * de impacto justifica (analysisFor.deepAnalysis = L3+, reusa a DI-1) e a IA
   * está disponível. IA NUNCA é o loop principal (§81): o determinístico é o
   * default; o LLM é opt-in por impacto e apenas COMPÕE (não recalcula, §22).
   * `synthesize` é INJETÁVEL (roda em CI sem chave). Fail-safe: sem gate/sem IA/
   * erro → devolve só o determinístico (aiUsed false).
   */
  static async investigateDeep(orgId: string, signalId: string, opts: { synthesize?: (payload: any) => Promise<string | null>; now?: number; force?: boolean } = {}): Promise<any> {
    const base = this.investigate(orgId, signalId, { now: opts.now });
    if (!base.found) return { ...base, synthesis: null, aiGate: "not_found", impactLevel: null };

    const sig = db.prepare(`SELECT severity, impact_amount, impact_unit, source_service FROM business_signals WHERE id = ? AND organization_id = ?`).get(signalId, orgId) as any;
    const lvl = ImpactPrioritizationService.levelFor({ severity: sig?.severity, impactAmount: sig?.impact_amount, impactUnit: sig?.impact_unit });
    const deepWarranted = opts.force || !!lvl.analysis?.deepAnalysis; // §83 — só L3+

    if (!base.candidateCauses.length) return { ...base, synthesis: null, aiGate: "no_causes", impactLevel: lvl.level };
    if (!deepWarranted) return { ...base, synthesis: null, aiGate: "below_threshold", impactLevel: lvl.level };

    // F12.2 (§84, CA17) — teto diário de investigação por DETECTOR. Antes de
    // gastar IA, checa o saldo do detector do sinal; esgotado → devolve só o
    // determinístico (um detector barulhento não drena a verba da org). O teto
    // NÃO é gate de segurança: em falha de contabilidade o check é fail-safe
    // (permite), o gate real de execução segue no RBAC (§35).
    const detector = sig?.source_service || "?";
    const budget = DetectorBudgetService.check(orgId, detector, opts.now || Date.now());
    if (!budget.allowed) return { ...base, synthesis: null, aiUsed: false, aiGate: "budget_exhausted", impactLevel: lvl.level, detectorBudget: budget };

    const payload = { signalId, headline: base.headline, candidateCauses: base.candidateCauses, impactLevel: lvl.level };
    const synth = opts.synthesize || SignalInvestigationService.defaultSynthesize;
    let synthesis: string | null = null;
    try { synthesis = await synth(payload); } catch { synthesis = null; }

    // Só consome o budget se a IA de fato rodou (síntese produzida) — falha/
    // indisponibilidade de IA não gasta a cota do detector.
    if (synthesis) DetectorBudgetService.consume(orgId, detector);

    return { ...base, synthesis: synthesis || null, aiUsed: !!synthesis, aiGate: synthesis ? "synthesized" : "ai_unavailable", impactLevel: lvl.level, detectorBudget: DetectorBudgetService.check(orgId, detector, opts.now || Date.now()) };
  }

  // Sintetizador padrão (§83): só chama o LLM se a IA está configurada; do
  // contrário devolve null (CI sem chave → sem síntese, sem quebrar). O LLM
  // COMPÕE sobre os fatos dados; nunca inventa causa nem afirma causalidade (§13).
  private static async defaultSynthesize(payload: any): Promise<string | null> {
    if (!isAIConfigured()) return null;
    const causes = (payload.candidateCauses || []).slice(0, 4)
      .map((c: any, i: number) => `${i + 1}. ${c.cause} (confiança ${Math.round(c.confidence * 100)}%; a favor: ${c.supportingEvidence.map((e: any) => e.type).join(", ") || "—"}; contra: ${c.contradictingEvidence.map((e: any) => e.type).join(", ") || "—"})`).join("\n");
    const prompt = `Causas-candidatas já calculadas (determinísticas) para um sinal empresarial:\n${causes}\n\nSintetize, em 2-3 frases e em português, a explicação MAIS PROVÁVEL, citando a evidência. Use "provável"/"indica"; NUNCA afirme causalidade nem invente causas fora da lista.`;
    const system = "Você sintetiza uma explicação a partir de causas-candidatas JÁ calculadas por regras determinísticas. Nunca invente causas novas, nunca afirme causalidade comprovada, sempre trate como correlação/probabilidade.";
    return await chat(prompt, { system, temperature: 0.3 });
  }
}
