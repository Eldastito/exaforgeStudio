/**
 * schedulingOverlap — primitiva ÚNICA de sobreposição de intervalo de tempo,
 * compartilhada pelos detectores de conflito de agenda (F1.2 / convergência,
 * PRD-ZF-UNIFIED-GAP-CLOSURE-03).
 *
 * ACHADO da auditoria F1.2: os detectores de conflito do repo — `ClinicAgendaService`
 * (profissional+sala, capacity, grupo), `ComigoAgendaService` (agenda solo),
 * `ProfessionalAvailabilityService` (vínculo federado, holds+TTL) e `ReservationService`
 * (recurso, capacity por unidade) — NÃO compartilham semântica de conflito. Cada um tem
 * seu próprio recurso, tabela, filtro de status e regras. Unificá-los atrás de uma
 * fachada seria abstração prematura (forçaria o solo a herdar profissional/sala, ou o
 * clínico a perder capacity/grupo). A ÚNICA coisa genuinamente duplicada entre eles é o
 * PREDICADO de sobreposição de dois intervalos — este módulo é só isso.
 *
 * Convenção MEIA-ABERTA [start, end): dois intervalos se sobrepõem quando cada um começa
 * antes do outro terminar. Encostar (a.end === b.start) NÃO é conflito. É exatamente a
 * convenção que os quatro já usavam — in-memory (`en > start && st < end`) e no SQL
 * (`startCol < :candidateEnd AND endCol > :candidateStart`). Os detectores que filtram no
 * banco seguem com o mesmo predicado no WHERE (não dá pra chamar JS lá dentro); a verdade
 * da convenção mora aqui.
 */

/**
 * `true` se [aStart, aEnd) e [bStart, bEnd) se sobrepõem (meia-aberto). Puro, sem I/O.
 * Unidade dos argumentos é livre (ms-epoch ou qualquer número monotônico), desde que os
 * quatro venham na mesma unidade — os chamadores já normalizam antes de comparar.
 */
export function intervalsOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && aEnd > bStart;
}
