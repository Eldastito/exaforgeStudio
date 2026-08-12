/**
 * CapacityRecommendationService — PRD 7 / ADR-164 F10 (§75-§79, CA15/CA16, D6): motor de
 * recomendação ADVISÓRIA e explicável.
 *
 * Junta as três leituras já existentes — headroom AGORA (F7), forecast FUTURO (F8) e causa
 * provável (F9) — e produz recomendações que o operador LÊ e decide. Cada recomendação
 * CITA a evidência que a gerou (§77/CA15 — explicável) e carrega a confiança da fonte.
 *
 * GUARDRAILS DUROS (o coração do PRD 7):
 *   - D6 / CA16 / RN-PRC — **V1 NUNCA executa**: não redimensiona, não migra, não compra.
 *     Toda recomendação é `requiresHuman:true`, `autoExecuted:false`. Recomendar ≠ agir.
 *   - RN-PRC-1 — nunca recomenda a partir de pico único: só zona SUSTENTADA (F7) ou
 *     tendência com confiança ≥ média (F8). Pico isolado não vira recomendação.
 *   - RN-PRC-6 / §59 — sem sinal → sem recomendação (`all_clear`); dado insuficiente é
 *     declarado, não vira urgência inventada.
 *   - §35 — recomendação sobre causa é hipótese ("investigar antes de agir"), não veredito.
 *   - Sem LLM (§56/§57 — determinístico). GLOBAL/Admin Master (§46).
 * Entradas injetáveis (headroom/forecast/rootCause) → determinismo total nos testes.
 */
import { CapacityHeadroomService } from "./CapacityHeadroomService.js";
import { CapacityForecastService } from "./CapacityForecastService.js";
import { PlatformRootCauseService } from "./PlatformRootCauseService.js";

type Priority = "alta" | "média" | "baixa";
const PRIO_RANK: Record<Priority, number> = { alta: 3, média: 2, baixa: 1 };

export class CapacityRecommendationService {
  static recommend(opts: {
    now?: number; days?: number; horizonDays?: number;
    headroom?: any; forecast?: any; rootCause?: any;
  } = {}): any {
    const now = opts.now ?? Date.now();
    const headroom = opts.headroom ?? CapacityHeadroomService.snapshot({ now });
    const forecast = opts.forecast ?? CapacityForecastService.forecastCapacity({ now, days: opts.days, horizonDays: opts.horizonDays });
    const rootCause = opts.rootCause ?? PlatformRootCauseService.analyze({ now, days: opts.days });

    const recs: any[] = [];

    // 1) Headroom AGORA — recurso em zona sustentada insegura (ACT/CRITICAL/PLAN).
    for (const r of headroom?.resources ?? []) {
      if (!r.available) continue;
      if (r.zone === "CRITICAL" || r.zone === "ACT") {
        recs.push(this.rec({
          id: `headroom:${r.resource}`, priority: r.zone === "CRITICAL" ? "alta" : "média",
          title: `${r.label} em zona ${r.zone}`,
          action: `Investigar a carga de ${r.label} e planejar folga — sem redimensionar automaticamente.`,
          rationale: `Valor atual ${r.value}${r.unit ?? ""} na zona ${r.zone} (headroom até o crítico: ${r.headroomToCritical}).`,
          confidence: "alta", evidence: [{ source: "headroom", resource: r.resource, zone: r.zone, value: r.value }],
        }));
      }
    }

    // 2) Forecast FUTURO — gargalo se aproximando com confiança ≥ média (nunca pico único).
    for (const f of forecast?.forecasts ?? []) {
      if (!f.available) continue;
      const tc = f.targetCrossing;
      if (!tc?.approaching || tc.daysToTarget == null) continue;
      if (f.confidence === "baixa") continue;                    // RN-PRC-1/§59 — não age em baixa confiança
      const prio: Priority = tc.daysToTarget <= 7 ? "alta" : tc.daysToTarget <= 30 ? "média" : "baixa";
      recs.push(this.rec({
        id: `forecast:${f.metric}`, priority: prio,
        title: `${f.label} cruza o crítico em ~${Math.round(tc.daysToTarget)} dia(s)`,
        action: `Planejar capacidade de ${f.label} com antecedência — decisão humana, sem compra automática.`,
        rationale: `Tendência (confiança ${f.confidence}) projeta cruzar ${tc.target}${f.unit ?? ""} por volta de ${tc.crossingAt}.`,
        confidence: f.confidence, evidence: [{ source: "forecast", metric: f.metric, daysToTarget: tc.daysToTarget, confidence: f.confidence }],
      }));
    }

    // 3) Causa provável — investigar ANTES de mexer em capacidade (§35, hipótese).
    for (const h of rootCause?.hypotheses ?? []) {
      recs.push(this.rec({
        id: `rootcause:${h.cause}`, priority: "média",
        title: `Hipótese: ${h.label}`,
        action: h.hint,
        rationale: `Correlação entre ${h.evidence.map((e: any) => e.metric).join(" + ")} — ${h.note}`,
        confidence: h.confidence === "média-alta" ? "média" : "baixa", // hipótese: teto conservador
        evidence: [{ source: "root_cause", cause: h.cause, metrics: h.evidence.map((e: any) => e.metric) }],
      }));
    }

    recs.sort((a, b) => PRIO_RANK[b.priority as Priority] - PRIO_RANK[a.priority as Priority]);
    const summary = { alta: 0, média: 0, baixa: 0 } as Record<Priority, number>;
    for (const r of recs) summary[r.priority as Priority]++;

    return {
      generatedAt: new Date(now).toISOString(),
      recommendations: recs,
      summary,
      note: recs.length ? "advisory_only" : "all_clear",
      disclaimer: "Recomendações são ADVISÓRIAS (§CA16/D6): o ZapFlow nunca redimensiona, migra ou compra sozinho. Decisão e execução são humanas.",
    };
  }

  private static rec(x: { id: string; priority: Priority; title: string; action: string; rationale: string; confidence: string; evidence: any[] }): any {
    return { ...x, basis: "advisory", requiresHuman: true, autoExecuted: false, reversible: true };
  }
}

export default CapacityRecommendationService;
