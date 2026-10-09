/**
 * Rótulos e formatação da aba "Inteligência" do Grupo (ADR-205 F4.8) — funções PURAS, sem React nem rede, para a tela não inventar nada
 * e para o texto ser testável. Dado ausente vira "—" (null ≠ 0); motivo desconhecido nunca vira silêncio.
 */
export type GroupMetricUnit = "BRL/m²" | "BRL/pessoa" | "%" | string;

export function previousMonth(today: string): string {
  const [y, m] = today.slice(0, 7).split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}

export function formatMetricValue(unit: GroupMetricUnit, v: number | null | undefined): string {
  if (v == null || !Number.isFinite(Number(v))) return "—";
  const n = Number(v);
  if (unit === "%") return `${n.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%`;
  return n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

/** Por que NÃO há ranking — sempre em palavras do dono, nunca o código cru. */
export function reasonLabel(reason: string | null | undefined): string {
  switch (reason) {
    case "amostra_minima": return "Preciso de pelo menos 3 operações do mesmo nicho com este dado para posicionar contra a mediana. Aqui estão os valores lado a lado.";
    case "nichos_diferentes": return "As operações são de nichos diferentes — comparar uma com a outra enganaria. Aqui estão os valores lado a lado, sem ranking.";
    case "nicho_desconhecido": return "Falta cadastrar o nicho de alguma operação, então não dá para saber se são comparáveis. Aqui estão os valores lado a lado, sem ranking.";
    case "mes_incompleto": return "O mês ainda não fechou: faturamento parcial contra custo fixo cheio distorce a comparação. Escolha um mês já fechado.";
    default: return reason ? "Sem ranking para este indicador." : "";
  }
}

/** A posição já vem normalizada pelo servidor: "above" = MELHOR que a mediana (inclusive no custo fixo, onde menor é melhor). */
export function positionLabel(position: string | null | undefined): { text: string; tone: "good" | "neutral" | "warn" } | null {
  if (position === "above_median") return { text: "melhor que a mediana", tone: "good" };
  if (position === "near_median") return { text: "perto da mediana", tone: "neutral" };
  if (position === "below_median") return { text: "pior que a mediana", tone: "warn" };
  return null;
}

export function confidenceLabel(level: string | null | undefined): string {
  switch (level) {
    case "insuficiente": return "sem ranking";
    case "baixa": return "confiança baixa";
    case "media": return "confiança média";
    default: return "";
  }
}

export function coverageLabel(c: { used: number; of: number } | null | undefined): string | null {
  if (!c || !c.of) return null;
  return c.used === c.of ? null : `${c.used} de ${c.of} loja(s) com dado`;
}
