/**
 * ResultProjectionService — ADR-188 F1: PROJEÇÃO do resultado do mês & ponto de equilíbrio pleno.
 *
 * Capstone FORWARD do arco de reconciliação de P&L (ADR-182 receita → ADR-184 custo → ADR-185 centro
 * de custo → ADR-186 consolidado — todos BACKWARD). Responde, no meio do mês, "no ritmo atual, vou
 * bater meu resultado?" — o análogo em LUCRO do alerta de ruptura de CAIXA (ADR-125).
 *
 * A conta (comportamento de custo, não "margem ÷ receita" ingênua):
 *   contribuição   = receitaLiquida − cmv − despesasVariaveis     (o que sobra por real vendido)
 *   razão          = contribuição / receitaLiquida                (margem de contribuição)
 *   breakEven      = despesasFixas ÷ razão                        (receita que zera o resultado)
 *   receitaProj.   = receitaLiquidaMTD × (diasNoMês ÷ diasDecorridos)   (run-rate)
 *   resultadoProj. = receitaProj. × razão − despesasFixas
 *
 * ASSIMETRIA (o coração da honestidade, RN-RP-3): só receita/CMV/despesa variável são MTD e sofrem
 * run-rate; o custo fixo vem do mês INTEIRO (competência — `ManagerialDreService` já agrega o período
 * todo) e NÃO é escalonado. Reusa o motor de DRE; zero tabela nova.
 *
 * Guardrails RN-RP: 1 (nunca inventa dinheiro — sem receita → razão/breakEven null, nunca 0/∞) ·
 * 2 (premissa + confiança explícitas) · 3 (assimetria fixo × variável) · 4 (derivado/RN-004) ·
 * 5 (advisory — não corta custo, F2) · 6 (isolado/determinístico — asOf explícito) · 7 (reusa o DRE).
 */
import { ManagerialDreService } from "./ManagerialDreService.js";

const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

function daysInMonth(period: string): number {
  const [y, m] = period.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}
/** Dias DECORRIDOS do período até asOf (0 se asOf antes do mês; totalDays se depois — fechado). */
function elapsedDaysOf(period: string, asOf: string, totalDays: number): number {
  const p = period;                    // YYYY-MM
  const asOfMonth = asOf.slice(0, 7);
  if (asOfMonth < p) return 0;         // mês ainda não começou
  if (asOfMonth > p) return totalDays; // mês já fechou
  return Math.min(totalDays, Number(asOf.slice(8, 10)) || 0);
}

export type ProjectionConfidence = "no_revenue" | "not_started" | "insufficient_elapsed" | "medium" | "high" | "actual";

export interface ResultProjection {
  period: string;
  asOf: string;
  totalDays: number;
  elapsedDays: number;
  mtd: {
    receitaLiquida: number; cmv: number; despesasVariaveis: number; despesasFixas: number;
    resultadoOperacional: number;
  };
  contributionRatio: number | null;   // margem de contribuição (null sem receita — RN-RP-1)
  breakEvenRevenue: number | null;    // receita que zera o resultado (null sem razão)
  projected: { receita: number | null; resultado: number | null };
  pctToBreakEven: number | null;      // receita projetada ÷ ponto de equilíbrio (× 100)
  onTrack: boolean | null;            // resultado projetado ≥ 0
  confidence: ProjectionConfidence;
  assumptions: string[];
  note: string;
}

export class ResultProjectionService {
  static project(orgId: string, opts: { period?: string; asOf?: string } = {}): ResultProjection {
    const period = opts.period || new Date().toISOString().slice(0, 7);
    const asOf = opts.asOf || new Date().toISOString().slice(0, 10);
    const totalDays = daysInMonth(period);
    const elapsedDays = elapsedDaysOf(period, asOf, totalDays);

    const linhas = ManagerialDreService.monthly(orgId, period).linhas as any;
    const receitaLiquida = Number(linhas.receitaLiquida) || 0;
    const cmv = Number(linhas.cmv) || 0;
    const despesasVariaveis = Number(linhas.despesasVariaveis) || 0;
    const despesasFixas = Number(linhas.despesasFixas) || 0;
    const resultadoOperacional = Number(linhas.resultadoOperacional) || 0;
    const mtd = { receitaLiquida, cmv, despesasVariaveis, despesasFixas, resultadoOperacional };

    const assumptions = [
      "Ritmo de receita constante até o fim do mês (projeção por dias corridos).",
      "Custo fixo do mês inteiro (competência) — não escalonado pelo ritmo.",
      "CMV e despesa variável proporcionais à receita.",
    ];

    // ── Sem receita → não há razão de contribuição nem ponto de equilíbrio (RN-RP-1) ──
    if (receitaLiquida <= 0) {
      return {
        period, asOf, totalDays, elapsedDays, mtd,
        contributionRatio: null, breakEvenRevenue: null,
        projected: { receita: null, resultado: null },
        pctToBreakEven: null, onTrack: null,
        confidence: "no_revenue", assumptions,
        note: "Sem receita líquida no mês ainda — sem base pra projetar resultado ou ponto de equilíbrio. O sistema não chuta.",
      };
    }

    const contribuicao = receitaLiquida - cmv - despesasVariaveis;
    const contributionRatio = round2(contribuicao / receitaLiquida);
    const breakEvenRevenue = contributionRatio > 0 ? round2(despesasFixas / contributionRatio) : null;

    // ── Mês ainda não começou → não projeta (RN-RP-2) ──
    if (elapsedDays <= 0) {
      return {
        period, asOf, totalDays, elapsedDays, mtd,
        contributionRatio, breakEvenRevenue,
        projected: { receita: null, resultado: null },
        pctToBreakEven: null, onTrack: null,
        confidence: "not_started", assumptions,
        note: "O mês ainda não começou — nada a projetar.",
      };
    }

    const runRate = totalDays / elapsedDays;
    const projReceita = round2(receitaLiquida * runRate);
    const projResultado = round2(projReceita * contributionRatio - despesasFixas);
    const pctToBreakEven = breakEvenRevenue && breakEvenRevenue > 0 ? round2((projReceita / breakEvenRevenue) * 100) : null;
    const onTrack = projResultado >= 0;

    // Confiança: fechado → actual; poucos dias → insuficiente; senão média/alta (RN-RP-2).
    let confidence: ProjectionConfidence;
    if (elapsedDays >= totalDays) confidence = "actual";
    else if (elapsedDays < 5) confidence = "insufficient_elapsed";
    else if (elapsedDays < totalDays * 0.5) confidence = "medium";
    else confidence = "high";

    const brl = (n: number) => `R$ ${n.toFixed(2).replace(".", ",")}`;
    const note = confidence === "actual"
      ? `Mês fechado: resultado ${brl(projResultado)} (ponto de equilíbrio ${breakEvenRevenue != null ? brl(breakEvenRevenue) : "—"}).`
      : `No ritmo atual (${elapsedDays}/${totalDays} dias), o mês projeta ${brl(projResultado)} de resultado — ${onTrack ? "acima" : "ABAIXO"} do equilíbrio${breakEvenRevenue != null ? ` (${brl(breakEvenRevenue)})` : ""}. ${confidence === "insufficient_elapsed" ? "Poucos dias decorridos — confiança baixa." : "Premissa: ritmo constante."}`;

    return {
      period, asOf, totalDays, elapsedDays, mtd,
      contributionRatio, breakEvenRevenue,
      projected: { receita: projReceita, resultado: projResultado },
      pctToBreakEven, onTrack, confidence, assumptions, note,
    };
  }
}

export default ResultProjectionService;
