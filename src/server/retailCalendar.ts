/**
 * retailCalendar — datas ESPECIAIS do varejo brasileiro (ADR-204 F3.4). Função PURA (sem DB/rede), determinística.
 *
 * Cobre feriados NACIONAIS (fixos + móveis a partir da Páscoa) e as datas comerciais que mexem com a venda (Dia das Mães,
 * Namorados, Pais, Crianças, Black Friday, véspera de Natal). NÃO cobre feriado MUNICIPAL/ESTADUAL (ex.: São Jorge no RJ):
 * isso depende da cidade da loja e não é inventado — o resultado sempre avisa esse limite.
 *
 * Uso: a previsão NÃO usa estas datas pra "adivinhar um efeito" (não há fator inventado): ela (1) tira esses dias do padrão
 * do dia da semana e (2) marca os que ainda vêm no mês pra alargar a faixa e baixar a confiança.
 */
export interface SpecialDay { date: string; name: string; kind: "holiday" | "retail_event" }

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400e3).toISOString().slice(0, 10);
const dowOf = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();

/** Páscoa (algoritmo de Meeus/Jones/Butcher) — domingo de Páscoa do ano, em YYYY-MM-DD. */
export function easterSunday(year: number): string {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return ymd(year, month, day);
}

/** N-ésimo `weekday` (0=dom) do mês. */
function nthWeekday(year: number, month: number, weekday: number, n: number): string {
  const first = ymd(year, month, 1);
  const shift = (weekday - dowOf(first) + 7) % 7;
  return addDays(first, shift + (n - 1) * 7);
}

/** Todas as datas especiais de um ano, ordenadas. */
export function specialDaysOfYear(year: number): SpecialDay[] {
  const easter = easterSunday(year);
  const h = (date: string, name: string): SpecialDay => ({ date, name, kind: "holiday" });
  const e = (date: string, name: string): SpecialDay => ({ date, name, kind: "retail_event" });
  const out: SpecialDay[] = [
    h(ymd(year, 1, 1), "Confraternização Universal"),
    h(addDays(easter, -48), "Carnaval (segunda)"), h(addDays(easter, -47), "Carnaval (terça)"),
    h(addDays(easter, -2), "Sexta-feira Santa"),
    h(ymd(year, 4, 21), "Tiradentes"), h(ymd(year, 5, 1), "Dia do Trabalho"),
    h(addDays(easter, 60), "Corpus Christi"),
    h(ymd(year, 9, 7), "Independência"), h(ymd(year, 10, 12), "Nossa Senhora Aparecida"),
    h(ymd(year, 11, 2), "Finados"), h(ymd(year, 11, 15), "Proclamação da República"),
    h(ymd(year, 12, 25), "Natal"),
    e(nthWeekday(year, 5, 0, 2), "Dia das Mães"), e(ymd(year, 6, 12), "Dia dos Namorados"),
    e(nthWeekday(year, 8, 0, 2), "Dia dos Pais"), e(ymd(year, 10, 12), "Dia das Crianças"),
    e(addDays(nthWeekday(year, 11, 4, 4), 1), "Black Friday"), e(ymd(year, 12, 24), "Véspera de Natal"),
  ];
  if (year >= 2024) out.push(h(ymd(year, 11, 20), "Consciência Negra"));
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/** Datas especiais num intervalo [from, to] (inclusive). Mesmo dia com 2 nomes (12/10) vira UM item com os dois. */
export function specialDaysBetween(from: string, to: string): SpecialDay[] {
  const y0 = Number(from.slice(0, 4)), y1 = Number(to.slice(0, 4));
  const byDate = new Map<string, SpecialDay>();
  for (let y = y0; y <= y1; y++) {
    for (const s of specialDaysOfYear(y)) {
      if (s.date < from || s.date > to) continue;
      const cur = byDate.get(s.date);
      byDate.set(s.date, cur ? { date: s.date, name: `${cur.name} / ${s.name}`, kind: cur.kind === "holiday" || s.kind === "holiday" ? "holiday" : "retail_event" } : s);
    }
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}
