/**
 * "Hoje" no fuso de São Paulo (YYYY-MM-DD).
 *
 * A Retail Ops é operação de lojas no Brasil: o dia de trabalho acaba às 22h (BRT), que é 01h do dia SEGUINTE em UTC.
 * `new Date().toISOString().slice(0, 10)` devolve a data UTC — entre 21h e 24h BRT isso é AMANHÃ, e as telas/prévias que
 * não mandam `?date=` (cabeçalho do Insights, `/day-brief`) mostravam o dia seguinte justo na hora de conferir o fechamento.
 */
export function todaySP(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const g = (t: string) => parts.find((p) => p.type === t)?.value || "00";
  return `${g("year")}-${g("month")}-${g("day")}`;
}
