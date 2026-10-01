/**
 * Valor de uma célula da "Conferência da semana" (loja × dia). Fechamento que EXISTE mas ainda não tem valor informado (linha criada
 * quando alguém abre o fechamento, ou o PDV ainda não chegou) é "aguardando", não R$ 0,00 — mesma regra do Informe diário (F1.0).
 * Retorna null = "—". Só a diferença informado−sistema pode ser 0 de verdade (os dois > 0 e iguais).
 */
export type WeekMetric = "informed" | "system" | "variance";

export function weekCellValue(c: any, metric: WeekMetric | string): number | null {
  if (!c) return null;
  const informed = Number(c.informed_total || 0);
  const system = Number(c.system_total || 0);
  if (metric === "system") return system > 0 ? system : null;
  if (metric === "variance") return informed > 0 && system > 0 ? informed - system : null;
  return informed > 0 ? informed : null;
}
