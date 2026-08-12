/**
 * statsWilson — intervalo de confiança de WILSON para proporção binária.
 * PRD 9 / ADR-166 F6 (§9, RN-EL-3/5).
 *
 * PROBLEMA: a `assuredEffectiveness` (F2) é uma taxa pontual. "1/1 deu certo" e
 * "40/45 deu certo" viram efetividades parecidas (1.0 × 0.89), mas a CONFIANÇA é
 * abissalmente diferente. O intervalo de Wilson dá a banda honesta: com n pequeno
 * ela é larga (pouca prova), com n grande é estreita (muita prova).
 *
 * Wilson é preferível ao intervalo normal (Wald) porque se comporta bem com n
 * pequeno e p perto de 0/1 — exatamente o caso do aprendizado no começo. Função
 * PURA e DETERMINÍSTICA (sem I/O, sem LLM). n ≤ 0 → null (RN-EL-5 null ≠ zero:
 * sem prova não há banda, não é [0,0]).
 */

// z para 95% de confiança (bicaudal). Constante — determinístico, sem libs.
const Z_95 = 1.959963984540054;

export interface WilsonInterval {
  lower: number;   // limite inferior 0..1
  upper: number;   // limite superior 0..1
  center: number;  // centro ajustado de Wilson (≠ p̂ pontual)
  z: number;
  n: number;
  successes: number;
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
const round4 = (n: number) => Math.round(n * 10000) / 10000;

/**
 * Intervalo de Wilson para `successes` de `n` tentativas. `z` default = 95%.
 * Retorna null se n ≤ 0 (sem dado — não inventa banda).
 */
export function wilsonInterval(successes: number, n: number, z: number = Z_95): WilsonInterval | null {
  const N = Math.floor(Number(n) || 0);
  const k = Math.floor(Number(successes) || 0);
  if (N <= 0) return null;
  const kk = Math.max(0, Math.min(N, k)); // successes nunca > n nem < 0
  const p = kk / N;
  const z2 = z * z;
  const denom = 1 + z2 / N;
  const center = (p + z2 / (2 * N)) / denom;
  const margin = (z / denom) * Math.sqrt((p * (1 - p)) / N + z2 / (4 * N * N));
  return {
    lower: round4(clamp01(center - margin)),
    upper: round4(clamp01(center + margin)),
    center: round4(clamp01(center)),
    z, n: N, successes: kk,
  };
}

/**
 * Rótulo de confiança pela LARGURA da banda (upper - lower): quanto mais estreita,
 * mais forte a prova. Determinístico. Sem intervalo (null) → 'insufficient'.
 */
export function intervalConfidenceLabel(iv: WilsonInterval | null): "insufficient" | "low" | "moderate" | "high" {
  if (!iv) return "insufficient";
  const width = iv.upper - iv.lower;
  if (width >= 0.5) return "low";
  if (width >= 0.25) return "moderate";
  return "high";
}
