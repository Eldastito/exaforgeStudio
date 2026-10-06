import db from "./db.js";
import { OutcomeMeasurementService } from "./OutcomeMeasurementService.js";
import { OutcomeAssuranceService } from "./OutcomeAssuranceService.js";
import { wilsonInterval, intervalConfidenceLabel } from "./statsWilson.js";

/**
 * InterventionEffectivenessService — ADR-204 F3.7 (Learning Loop).
 *
 * "O que funciona" por INTERVENÇÃO = (domínio, tipo de ação): o esperado × realizado das ações que o negócio
 * executou, lido do Impact Ledger que já existe (`OutcomeMeasurementService.ledger`). READ-ONLY, determinístico,
 * sem tabela nova (RN-004: tudo derivado por query).
 *
 * Regras (RN-F3):
 *  - Só ação `assured` (PRD 8: efeito confirmado + impacto medido) ENSINA. Medida-mas-não-assegurada aparece
 *    como contagem (`measuredNotAssured`), nunca entra na taxa — DONE ≠ exemplo de sucesso.
 *  - Só base `fact` entra em esperado/realizado. `estimate`/`influenced` ficam de fora e nunca são somados
 *    com fato (só contados em `estimateOnly`).
 *  - "Atingiu o esperado" = realizado ≥ esperado, e só conta quem tinha esperado > 0 (sem meta → sem veredito, null≠0).
 *  - Amostra mínima (MIN_SAMPLE): abaixo dela NÃO há taxa nem veredito — só os números de contagem. Com amostra,
 *    a taxa vem com banda de Wilson 95% e veredito conservador pela banda: works (piso ≥ 50%), weak (teto < 50%),
 *    senão inconclusive. Nada vira "regra" sozinho: é evidência pro gestor (RN-F3-4 / IA só recomenda).
 *  - Dinheiro (esperado/realizado em R$) só com `canSeeMoney` (§73); taxa e contagens são sempre visíveis.
 *  - NÃO cobre "% do objetivo": exige elo ação→meta, que não existe hoje (declarado em `notes`).
 */
export const INTERVENTION_MIN_SAMPLE = 5;

export interface InterventionStat {
  domain: string; actionType: string; label: string;
  actions: number; assured: number; measuredNotAssured: number; estimateOnly: number;
  sample: number; hits: number;
  hitRate: number | null; interval: { lower: number; upper: number } | null; confidence: string | null;
  verdict: "works" | "weak" | "inconclusive" | "insufficient_sample";
  expectedTotal: number | null; realizedTotal: number | null; realizationPct: number | null;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

export class InterventionEffectivenessService {
  static summary(orgId: string, opts: { canSeeMoney?: boolean; domain?: string } = {}): { items: InterventionStat[]; minSample: number; notes: string[] } {
    const led: any = OutcomeMeasurementService.ledger(orgId, { domain: opts.domain, limit: 500 });
    // agrupa por ação (já deduplicado por event_key no ledger)
    const byAction = new Map<string, { domain: string; actionType: string; title: string; exp: number; real: number; hasFact: boolean; hasExpected: boolean; hasOther: boolean }>();
    for (const o of led.items as any[]) {
      if (!o.action_id) continue;
      const a = byAction.get(o.action_id) || { domain: o.domain || "outros", actionType: o.action_type || "desconhecido", title: o.title || "", exp: 0, real: 0, hasFact: false, hasExpected: false, hasOther: false };
      if (o.basis === "fact") {
        a.hasFact = true;
        if (o.expected_value != null && Number(o.expected_value) > 0) { a.hasExpected = true; a.exp += Number(o.expected_value); }
        a.real += Number(o.realized_value) || 0;
      } else a.hasOther = true;
      byAction.set(o.action_id, a);
    }
    const groups = new Map<string, InterventionStat & { _exp: number; _real: number }>();
    for (const [actionId, a] of byAction) {
      const key = `${a.domain}|${a.actionType}`;
      const g = groups.get(key) || { domain: a.domain, actionType: a.actionType, label: a.actionType, actions: 0, assured: 0, measuredNotAssured: 0, estimateOnly: 0, sample: 0, hits: 0, hitRate: null, interval: null, confidence: null, verdict: "insufficient_sample" as const, expectedTotal: null, realizedTotal: null, realizationPct: null, _exp: 0, _real: 0 };
      g.actions++;
      if (!a.hasFact) { g.estimateOnly++; groups.set(key, g); continue; }
      let state = "unknown";
      try { state = OutcomeAssuranceService.assessAction(orgId, actionId)?.assuranceState; } catch { /* sem prova → não ensina */ }
      if (state !== "assured") { g.measuredNotAssured++; groups.set(key, g); continue; }
      g.assured++;
      if (a.hasExpected) { g.sample++; g._exp += a.exp; g._real += a.real; if (a.real >= a.exp) g.hits++; }
      groups.set(key, g);
    }
    const items: InterventionStat[] = [];
    for (const g of groups.values()) {
      const { _exp, _real, ...pub } = g;
      if (g.sample >= INTERVENTION_MIN_SAMPLE) {
        const w = wilsonInterval(g.hits, g.sample)!;
        pub.hitRate = r2(g.hits / g.sample); pub.interval = { lower: w.lower, upper: w.upper }; pub.confidence = intervalConfidenceLabel(w);
        pub.verdict = w.lower >= 0.5 ? "works" : w.upper < 0.5 ? "weak" : "inconclusive";
        pub.realizationPct = _exp > 0 ? r2((_real / _exp) * 100) : null;
        if (opts.canSeeMoney) { pub.expectedTotal = r2(_exp); pub.realizedTotal = r2(_real); }
      }
      items.push(pub);
    }
    const order = { works: 0, inconclusive: 1, weak: 2, insufficient_sample: 3 } as const;
    items.sort((a, b) => order[a.verdict] - order[b.verdict] || (b.hitRate ?? -1) - (a.hitRate ?? -1) || b.assured - a.assured);
    return {
      items, minSample: INTERVENTION_MIN_SAMPLE,
      notes: [
        `Só ações com efeito confirmado e impacto medido ensinam; abaixo de ${INTERVENTION_MIN_SAMPLE} casos com meta, não há taxa nem veredito.`,
        "Estimativa nunca é somada com fato. '% do objetivo' ainda não existe (falta ligar ação → meta).",
      ],
    };
  }
}
