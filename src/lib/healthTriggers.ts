/**
 * Gatilhos do status geral que JÁ estão ditos na síntese não se repetem embaixo dela (S7).
 * Puro — testado em scripts/test-central-polish.ts.
 */
export function visibleTriggers<T extends { label: string }>(triggers: T[] | null | undefined, synthesis: string | null | undefined): T[] {
  const s = String(synthesis || "");
  return (triggers || []).filter((t) => !(t.label && s.includes(t.label)));
}

/** Quantos assuntos de atenção existem além dos mostrados (0 quando todos já aparecem). */
export function hiddenAttention(count: number | null | undefined, shown: number): number {
  const c = Number(count);
  return Number.isFinite(c) && c > shown ? c - shown : 0;
}
