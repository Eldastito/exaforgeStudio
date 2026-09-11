import { SurvivalIndexService } from "./SurvivalIndexService.js";
import { RecoveryDebtService } from "./RecoveryDebtService.js";
import { ExecutiveFinanceService } from "./ExecutiveFinanceService.js";

/**
 * RecoveryViabilityService — IRF (Índice de Recuperabilidade Financeira) + diagnóstico
 * estrutural (Financial Recovery OS, PRD-ZF-UNIFIED-GAP-CLOSURE-03 F3.6/F3.7 / PR-6).
 *
 * DECISÃO DE DESIGN (0-regressão — auditoria F0): o IRF NÃO é um 2º índice de saúde. Ele
 * ESTENDE o `SurvivalIndexService` (ADR-127, placar 0-100 já em produção) — REUSA o score
 * de sobrevivência como componente-base (saúde operacional) e ACRESCENTA as dimensões que o
 * índice de sobrevivência não tem: peso da dívida (cobertura do serviço) e estrutura da
 * dívida (vencido + negociabilidade), vindas do Mapa da Dívida (PR-5). O
 * `SurvivalIndexService` NÃO é modificado (seus consumidores continuam vendo o mesmo número).
 *
 * DETERMINÍSTICO (RN-FR-10, F3.6): o IRF é 100% calculado por regra — o LLM NUNCA calcula o
 * índice; só pode narrar o resultado já calculado. Zero-token, testável sem chave de IA.
 *
 * IRF ≠ previsão de falência / parecer contábil ou jurídico (F3.6). É orientativo.
 *
 * Diagnóstico estrutural (F3.7): distingue crise OPERACIONAL (a operação perde dinheiro antes
 * da dívida), crise FINANCEIRA (operação positiva, mas o serviço da dívida destrói o caixa) e
 * MISTA. Honesto: sem resultado operacional afirmável → `undetermined` (não chuta a causa).
 *
 * Não expõe dinheiro (só score/%/labels/razões qualitativas) → não precisa de money-gating;
 * os valores em R$ ficam no assessment (PR-5), que já redige. Read-only, isolado por org.
 */

export type CrisisShape = "operational" | "financial" | "mixed" | "stable" | "undetermined";

interface VComp { key: string; label: string; weight: number; score: number; hasData: boolean; note: string }

export interface RecoveryViability {
  generatedAt: string;
  irf: number | null;              // 0-100 (null se base indisponível)
  faixa: "recuperavel" | "dificil" | "critico" | "indefinido";
  confidence: "alta" | "media" | "baixa";
  components: VComp[];
  crisis: { shape: CrisisShape; reason: string };
  caveats: string[];
  disclaimer: string;
}

const clamp = (n: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));
const round1 = (n: number) => Math.round((Number(n) || 0) * 10) / 10;
const NEUTRAL = 50;
const BAND_VALUE: Record<string, number> = { high: 100, medium: 50, low: 0 };
const DISCLAIMER = "O IRF é orientativo (0-100), não é previsão de falência nem parecer contábil/jurídico. Situações graves exigem validação profissional.";

function safe<T>(fn: () => T, fallback: T): T { try { return fn(); } catch { return fallback; } }

export class RecoveryViabilityService {
  /**
   * Calcula o IRF + o diagnóstico estrutural. Determinístico. `includeMoney` só afeta a
   * leitura interna do financeiro (a saída não carrega R$), então o default é seguro.
   */
  static viability(orgId: string, opts: { period?: string } = {}): RecoveryViability {
    const caveats: string[] = [];

    // ── Base: saúde operacional = índice de sobrevivência EXISTENTE (não recalcula) ──
    const si = safe(() => SurvivalIndexService.score(orgId), null as any);
    const operationalHealthScore = si ? Number(si.score) : NEUTRAL;
    const operationalHasData = !!si && si.confidence !== "baixa";
    if (!si) caveats.push("Índice de sobrevivência indisponível — base operacional neutra.");

    // Resultado operacional (para servibilidade da dívida + diagnóstico estrutural).
    // includeMoney:true só para a LÓGICA interna (a saída deste service não expõe R$).
    const fin = safe(() => ExecutiveFinanceService.read(orgId, { includeMoney: true, period: opts.period }), null as any);
    const opResult: number | null = fin?.profitability?.available ? (fin.profitability.operatingResultCore ?? null) : null;
    const opResultAffirmable = opResult != null && fin?.profitability?.unknownCostRisk !== true;
    const survivalDays: number | null = fin?.liquidity?.survivalDays ?? null;

    // ── Dimensões de dívida (Mapa da Dívida, PR-5) ──
    const debt = RecoveryDebtService.summary(orgId);
    const hasDebt = debt.itemsCount > 0;

    // Servibilidade: geração de caixa (proxy: resultado operacional mensal) cobre o serviço?
    let serviceabilityScore = NEUTRAL, serviceabilityData = false, serviceabilityNote = "";
    let coverage: number | null = null;
    if (!hasDebt) {
      serviceabilityScore = 100; serviceabilityData = true; serviceabilityNote = "Sem dívida cadastrada.";
    } else if (debt.monthlyServiceKnown <= 0) {
      serviceabilityNote = "Parcelas mensais não informadas — servibilidade não avaliável.";
      caveats.push(serviceabilityNote);
    } else if (!opResultAffirmable) {
      serviceabilityNote = "Resultado operacional não afirmável (custo desconhecido) — servibilidade neutra.";
      caveats.push(serviceabilityNote);
    } else {
      serviceabilityData = true;
      coverage = (opResult as number) / debt.monthlyServiceKnown;
      serviceabilityScore = coverage >= 1.5 ? 100 : coverage >= 1 ? 80 : coverage >= 0.5 ? 50 : coverage > 0 ? 25 : 0;
    }

    // Estrutura: fatia vencida (penaliza) + negociabilidade (recuperável se negociável).
    let structureScore = NEUTRAL, structureData = false, structureNote = "";
    if (hasDebt) {
      structureData = true;
      const overdueShare = debt.totalKnown > 0 ? Math.min(1, debt.totalOverdue / debt.totalKnown) : 0;
      const overdueScore = clamp(100 * (1 - overdueShare));
      // Negociabilidade média das linhas ativas que a informam.
      const items = RecoveryDebtService.list(orgId).filter((r: any) => (r.status === "open" || r.status === "renegotiating") && r.negotiability);
      let negScore: number | null = null;
      if (items.length) negScore = clamp(items.reduce((s: number, r: any) => s + (BAND_VALUE[r.negotiability] ?? NEUTRAL), 0) / items.length);
      structureScore = negScore == null ? overdueScore : clamp(0.7 * overdueScore + 0.3 * negScore);
      structureNote = overdueShare > 0 ? `${Math.round(overdueShare * 100)}% da dívida conhecida está vencida.` : "Sem parcela vencida.";
    } else {
      structureScore = 100; structureData = true; structureNote = "Sem dívida cadastrada.";
    }

    const components: VComp[] = [
      { key: "operational_health", label: "Saúde operacional (índice de sobrevivência)", weight: 55, score: round1(operationalHealthScore), hasData: operationalHasData, note: operationalHasData ? "" : "Base operacional com pouco dado." },
      { key: "debt_serviceability", label: "Servibilidade da dívida", weight: 30, score: round1(serviceabilityScore), hasData: serviceabilityData, note: serviceabilityNote },
      { key: "debt_structure", label: "Estrutura da dívida (vencido + negociabilidade)", weight: 15, score: round1(structureScore), hasData: structureData, note: structureNote },
    ];

    const totalWeight = components.reduce((s, c) => s + c.weight, 0); // 100
    const irf = round1(components.reduce((s, c) => s + (c.weight * c.score) / totalWeight, 0));
    const dataWeight = components.filter((c) => c.hasData).reduce((s, c) => s + c.weight, 0);
    const confidence = dataWeight >= 80 ? "alta" : dataWeight >= 50 ? "media" : "baixa";
    const faixa: RecoveryViability["faixa"] =
      !operationalHasData && !hasDebt ? "indefinido" : irf >= 65 ? "recuperavel" : irf >= 40 ? "dificil" : "critico";

    return {
      generatedAt: new Date().toISOString(),
      irf: si || hasDebt ? irf : null,
      faixa,
      confidence,
      components,
      crisis: this.classifyCrisis({ opResult, opResultAffirmable, hasDebt, coverage, survivalDays, totalOverdue: debt.totalOverdue, totalKnown: debt.totalKnown }),
      caveats,
      disclaimer: DISCLAIMER,
    };
  }

  /**
   * Diagnóstico estrutural (F3.7) — determinístico. Distingue crise operacional (operação
   * perde dinheiro), financeira (operação positiva, serviço da dívida aperta o caixa) e mista.
   * Honesto: sem resultado operacional afirmável → `undetermined`.
   */
  static classifyCrisis(x: {
    opResult: number | null; opResultAffirmable: boolean; hasDebt: boolean;
    coverage: number | null; survivalDays: number | null; totalOverdue: number; totalKnown: number;
  }): { shape: CrisisShape; reason: string } {
    if (!x.opResultAffirmable) {
      return { shape: "undetermined", reason: "Resultado operacional não afirmável (custo desconhecido) — não é possível separar causa operacional de financeira." };
    }
    const opNegative = (x.opResult as number) < 0;
    // Pressão da dívida: serviço não coberto pela operação, OU fôlego de caixa curto com dívida vencida.
    const debtPressure = x.hasDebt && (
      (x.coverage != null && x.coverage < 1) ||
      (x.survivalDays != null && x.survivalDays < 60 && x.totalOverdue > 0)
    );
    if (opNegative && debtPressure) return { shape: "mixed", reason: "A operação consome caixa E o serviço da dívida agrava — renegociar sozinho não resolve." };
    if (opNegative) return { shape: "operational", reason: "A operação perde dinheiro antes da dívida — o problema começa na operação." };
    if (debtPressure) return { shape: "financial", reason: "A operação gera caixa, mas o serviço/atraso da dívida aperta o caixa — foco em renegociação/alongamento." };
    return { shape: "stable", reason: x.hasDebt ? "Operação positiva e dívida sob controle no momento." : "Operação positiva e sem dívida cadastrada." };
  }
}

export default RecoveryViabilityService;
