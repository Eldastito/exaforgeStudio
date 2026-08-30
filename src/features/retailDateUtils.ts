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
