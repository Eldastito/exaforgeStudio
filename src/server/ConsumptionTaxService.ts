/**
 * ConsumptionTaxService — ADR-181 F3: motor de cálculo CBS/IBS/IS (Reforma do Consumo).
 *
 * O núcleo da prontidão: dado um valor-base + data do fato gerador + o perfil fiscal da org,
 * devolve o breakdown dos novos tributos DA FASE VIGENTE na data. É a junção de F1 (perfil) e
 * F2 (base curada) — e NÃO carrega nenhuma regra de lei própria: toda alíquota vem do
 * `TaxReferenceService.rateFor`. Determinístico (aritmética pura, roda em CI).
 *
 * O regime da org decide o RECORTE e o MODO de recolhimento:
 *   - mei              → recorte 'mei'         · recolhe DENTRO do DAS · sem crédito
 *   - simples          → recorte 'simples_das' · recolhe DENTRO do DAS · sem crédito
 *   - simples_hibrido  → recorte geral         · recolhe POR FORA (regular) · gera crédito
 *   - presumido | real → recorte geral         · recolhe POR FORA (regular) · gera crédito
 *
 * Guardrails RN-FISCAL:
 *  - 1 (nunca inventa): tributo sem alíquota vigente → `unknown` (amount null), NUNCA 0.
 *  - 3 (date-effective): a fase vem da data do fato gerador (via rateFor).
 *  - 4 (honesto quando falta dado): sem regime declarado → `profile_incomplete`, não calcula.
 *  - 5 (determinístico antes de LLM): puro; nenhuma chamada de modelo.
 *  - IS só incide em item SELETIVO explícito (`selective:true`) — não presume seletivo.
 */
import { FiscalProfileService, FiscalRegime } from "./FiscalProfileService.js";
import { TaxReferenceService } from "./TaxReferenceService.js";

export type CollectionMode = "das_embedded" | "separate";

export interface ConsumptionTaxInput {
  baseValue: number;               // valor-base em R$ (reais)
  date: string;                    // YYYY-MM-DD (data do fato gerador)
  itemType?: "goods" | "service";  // contexto (não altera alíquota neste modelo)
  selective?: boolean;             // item sujeito ao Imposto Seletivo (default false)
}

export interface TaxLine {
  rate: number | null;             // alíquota % (null = desconhecida)
  amount: number | null;           // valor em R$ (null = desconhecido — RN-FISCAL-1)
  phase: string | null;            // rótulo da fase vigente
  status: "computed" | "unknown" | "not_applicable";
  reason?: string;                 // ex.: no_rate_for_period | not_selective
}

export interface ConsumptionTaxResult {
  status: "computed" | "profile_incomplete";
  missing?: string[];
  baseValue: number;
  date: string;
  regime: FiscalRegime | null;
  scope: "mei" | "simples_das" | "geral" | null;
  collectionMode: CollectionMode | null;   // dentro do DAS × por fora
  creditEligible: boolean;                  // só regime regular/híbrido (LC 214 art. 47 §9)
  taxes: { cbs: TaxLine; ibs: TaxLine; is: TaxLine };
  totalTax: number | null;                  // soma dos conhecidos; null se nada conhecido
  partial: boolean;                         // true se algum tributo ficou unknown
  note: string;
}

function round2(n: number): number { return Math.round((n + Number.EPSILON) * 100) / 100; }

/** Mapeia o regime → (recorte, modo de recolhimento, elegível a crédito). */
function regimeScope(regime: FiscalRegime): { scope: "mei" | "simples_das" | "geral"; mode: CollectionMode; credit: boolean } {
  switch (regime) {
    case "mei": return { scope: "mei", mode: "das_embedded", credit: false };
    case "simples": return { scope: "simples_das", mode: "das_embedded", credit: false };
    case "simples_hibrido": return { scope: "geral", mode: "separate", credit: true };
    case "presumido":
    case "real": return { scope: "geral", mode: "separate", credit: true };
  }
}

export class ConsumptionTaxService {
  /**
   * Calcula CBS/IBS/IS de um valor-base numa data, pelo perfil fiscal da org. Honesto: sem
   * regime declarado → não calcula (RN-FISCAL-4); tributo sem alíquota curada → unknown, não 0.
   */
  static compute(orgId: string, input: ConsumptionTaxInput): ConsumptionTaxResult {
    const base = Number(input.baseValue);
    if (!Number.isFinite(base) || base < 0) throw new Error("base_value_invalid");
    const date = String(input.date || "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("date_invalid");

    const profile = FiscalProfileService.get(orgId);
    const regime = profile.regime;

    // RN-FISCAL-4: o mínimo pro CÁLCULO é o regime (decide recorte/modo). Sem ele, honesto.
    if (!regime) {
      return {
        status: "profile_incomplete", missing: ["regime"],
        baseValue: round2(base), date, regime: null, scope: null, collectionMode: null,
        creditEligible: false,
        taxes: {
          cbs: { rate: null, amount: null, phase: null, status: "unknown", reason: "profile_incomplete" },
          ibs: { rate: null, amount: null, phase: null, status: "unknown", reason: "profile_incomplete" },
          is: { rate: null, amount: null, phase: null, status: "unknown", reason: "profile_incomplete" },
        },
        totalTax: null, partial: true,
        note: "Declare o regime tributário da empresa para calcular os tributos da Reforma.",
      };
    }

    const { scope, mode, credit } = regimeScope(regime);

    const lineFor = (tribute: "cbs" | "ibs", applies: string): TaxLine => {
      const r = TaxReferenceService.rateFor(tribute, date, { appliesTo: applies === "geral" ? null : applies });
      if (!r) return { rate: null, amount: null, phase: null, status: "unknown", reason: "no_rate_for_period" };
      return { rate: r.ratePercent, amount: round2(base * r.ratePercent / 100), phase: r.phase, status: "computed" };
    };

    const cbs = lineFor("cbs", scope);
    const ibs = lineFor("ibs", scope);

    // IS: só incide em item SELETIVO explícito; senão not_applicable (não presume — RN-FISCAL).
    let is: TaxLine;
    if (!input.selective) {
      is = { rate: null, amount: null, phase: null, status: "not_applicable", reason: "not_selective" };
    } else {
      const r = TaxReferenceService.rateFor("is", date, { appliesTo: null });
      is = r ? { rate: r.ratePercent, amount: round2(base * r.ratePercent / 100), phase: r.phase, status: "computed" }
             : { rate: null, amount: null, phase: null, status: "unknown", reason: "no_rate_for_period" };
    }

    const known = [cbs, ibs, is].filter((l) => l.status === "computed").map((l) => l.amount as number);
    const anyUnknown = [cbs, ibs, is].some((l) => l.status === "unknown");
    const totalTax = known.length ? round2(known.reduce((a, b) => a + b, 0)) : null;

    const note = mode === "das_embedded"
      ? "Simples/MEI: CBS e IBS são recolhidos DENTRO do DAS — o valor é informativo (não é cobrança à parte)."
      : "Regime regular: CBS e IBS destacados por fora; geram/aproveitam crédito.";

    return {
      status: "computed", baseValue: round2(base), date, regime, scope, collectionMode: mode,
      creditEligible: credit, taxes: { cbs, ibs, is }, totalTax, partial: anyUnknown, note,
    };
  }
}

export default ConsumptionTaxService;
