/**
 * Utilidades de data LOCAL (YYYY-MM-DD) da Operação da Rede.
 *
 * BUG que isto corrige: formatar um dia com `Date.toISOString()` devolve a data
 * em UTC. No Brasil (UTC-3), à NOITE isso vira o DIA SEGUINTE — então a Escala
 * mostrava 24/08 como domingo (era segunda-feira) e o Fechamento do dia abria em
 * "amanhã". A correção é sempre formatar pelos componentes LOCAIS do Date.
 *
 * (O bug some em CI porque o runner roda em UTC — por isso o teste força
 * TZ=America/Sao_Paulo para reproduzir o cenário do lojista.)
 */

/** YYYY-MM-DD pelos componentes LOCAIS do Date (nunca UTC). */
export function isoLocal(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Hoje, na data LOCAL do navegador (não UTC). */
export function todayStr(): string {
  return isoLocal(new Date());
}

/** Domingo (início da semana) da data dada, como YYYY-MM-DD local. */
export function sundayOf(d: Date): string {
  const x = new Date(d);
  x.setHours(12, 0, 0, 0);              // âncora ao meio-dia: imune a borda/DST
  x.setDate(x.getDate() - x.getDay());  // getDay() local: 0=domingo
  return isoLocal(x);
}

/**
 * Soma n dias a uma data YYYY-MM-DD, ancorando ao MEIO-DIA UTC — assim o
 * toISOString().slice nunca "rola" para o dia vizinho. Determinístico e
 * independente de fuso (opera sobre a string, não sobre o relógio local).
 */
export function addDays(dateStr: string, n: number): string {
  const x = new Date(dateStr + "T12:00:00Z");
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
}

/** Soma n meses a um mês YYYY-MM (n pode ser negativo). */
export function addMonths(month: string, n: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, (m - 1) + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Dias YYYY-MM-DD de start..end INCLUSIVE (imune a fuso; cap de 40 p/ segurança). */
export function daysBetween(start: string, end: string): string[] {
  const out: string[] = [];
  let cur = start;
  for (let i = 0; i < 40 && cur <= end; i++) { out.push(cur); cur = addDays(cur, 1); }
  return out;
}

/**
 * Semanas de um MÊS (YYYY-MM) que FECHAM NO MÊS — espelho client-side de
 * RetailCommissionRaceService.weeksOfMonth (servidor): corte no domingo +
 * fusão do início curto (<4 dias) na semana seguinte. Garante que a semana da
 * escala NUNCA atravessa a virada de mês (bug do lojista: domingo→domingo
 * puxava a 1ª semana do mês seguinte). Usa UTC (igual ao servidor) — mesmo
 * corte que o `raceWeeks` das cotas, então escala e cotas ficam alinhadas.
 */
export function weeksOfMonthLocal(month: string): Array<{ start: string; end: string }> {
  const [y, m] = month.split("-").map(Number);
  if (!y || !m) return [];
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const weeks: Array<{ start: string; end: string }> = [];
  let cur: string[] = [];
  for (let d = 1; d <= days; d++) {
    const date = `${month}-${String(d).padStart(2, "0")}`;
    if (new Date(Date.UTC(y, m - 1, d)).getUTCDay() === 0 && cur.length) {
      weeks.push({ start: cur[0], end: cur[cur.length - 1] });
      cur = [];
    }
    cur.push(date);
  }
  if (cur.length) weeks.push({ start: cur[0], end: cur[cur.length - 1] });
  if (weeks.length > 1) {
    const firstLen = (Date.parse(weeks[0].end) - Date.parse(weeks[0].start)) / 86400000 + 1;
    if (firstLen < 4) { weeks[1] = { start: weeks[0].start, end: weeks[1].end }; weeks.shift(); }
  }
  return weeks;
}
