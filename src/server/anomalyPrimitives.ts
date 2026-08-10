/**
 * anomalyPrimitives — PRD 2 F4.1 (§21-26): as primitivas DETERMINÍSTICAS de
 * detecção de anomalia, extraídas do código inline repetido pelos detectores
 * (`ConsumptionSignalPublisher` ×1.5, `RetailFloor.conversionDrop` 20%/min20, …).
 *
 * Princípio §22: NÃO começar com IA. Anomalia é média/desvio/percentil vs período
 * comparável — cálculo puro. LLM só INTERPRETA depois; nunca calcula média.
 *
 * Este módulo é uma biblioteca pura (sem DB, sem I/O): baseline + deviation +
 * minSample + threshold + cooldown + TTL. A F4.2 (registry) e a F4.3 (detector
 * piloto migrado) constroem sobre ela. Determinístico → testável sem chave de IA.
 */

export function mean(values: number[]): number {
  if (!values.length) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function stdDev(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  const variance = values.reduce((a, b) => a + (b - m) * (b - m), 0) / (values.length - 1); // amostral (n-1)
  return Math.sqrt(variance);
}

/** Percentil p∈[0,100] por interpolação linear. Aceita valores não ordenados. */
export function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const rank = (Math.max(0, Math.min(100, p)) / 100) * (sorted.length - 1);
  const lo = Math.floor(rank), hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo);
}

export type AnomalyMethod = "relative" | "absolute" | "zscore";
export type AnomalyDirection = "drop" | "spike" | "both";

export interface AnomalyInput {
  current: number;
  baseline?: number;          // baseline pré-computado; OU
  sample?: number[];          // série pra derivar baseline (média) + desvio
  minSample?: number;         // §25 — não dispara com amostra pequena
  method?: AnomalyMethod;     // como comparar (default relative)
  threshold: number;          // relative: fração (0.2=20%); absolute: unidades; zscore: sigmas
  direction?: AnomalyDirection; // qual lado conta como anomalia (default both)
}

export interface AnomalyResult {
  isAnomaly: boolean;
  belowMinSample: boolean;
  baseline: number | null;
  current: number;
  deltaAbsolute: number | null;
  deltaRelative: number | null;   // fração vs |baseline|
  zscore: number | null;
  direction: "drop" | "spike" | "flat" | null;
  magnitude: number;              // a métrica comparada ao threshold
  reason: string;
}

/**
 * Avalia se `current` é anômalo vs baseline/amostra. Guarda de minSample (§25),
 * direção (drop/spike/both), e método (relativo/absoluto/z-score, §22-23).
 * Fail-safe: sem baseline ou amostra insuficiente → NÃO é anomalia.
 */
export function evaluateAnomaly(input: AnomalyInput): AnomalyResult {
  const { current } = input;
  const method: AnomalyMethod = input.method || "relative";
  const direction: AnomalyDirection = input.direction || "both";
  const minSample = input.minSample ?? 1;

  let baseline = input.baseline ?? null;
  let stddev: number | null = null;
  let belowMinSample = false;

  if (input.sample) {
    if (input.sample.length < minSample) belowMinSample = true;
    if (baseline == null) baseline = input.sample.length ? mean(input.sample) : null;
    stddev = input.sample.length >= 2 ? stdDev(input.sample) : null;
  }

  const nil = (reason: string): AnomalyResult => ({ isAnomaly: false, belowMinSample, baseline, current, deltaAbsolute: null, deltaRelative: null, zscore: null, direction: null, magnitude: 0, reason });
  if (belowMinSample) return nil("amostra insuficiente");
  if (baseline == null) return nil("sem baseline");

  const deltaAbsolute = current - baseline;
  const deltaRelative = baseline !== 0 ? deltaAbsolute / Math.abs(baseline) : null;
  const zscore = stddev && stddev > 0 ? deltaAbsolute / stddev : null;
  const dir: "drop" | "spike" | "flat" = deltaAbsolute < 0 ? "drop" : deltaAbsolute > 0 ? "spike" : "flat";

  let magnitude = 0;
  if (method === "absolute") magnitude = Math.abs(deltaAbsolute);
  else if (method === "zscore") magnitude = zscore != null ? Math.abs(zscore) : 0;
  else magnitude = deltaRelative != null ? Math.abs(deltaRelative) : 0;

  const dirMatch = direction === "both" || direction === dir;
  const isAnomaly = dirMatch && dir !== "flat" && magnitude >= input.threshold;
  const fmt = method === "relative" ? `${(magnitude * 100).toFixed(1)}%` : method === "zscore" ? `${magnitude.toFixed(2)}σ` : magnitude.toFixed(2);
  return {
    isAnomaly, belowMinSample: false, baseline, current, deltaAbsolute, deltaRelative, zscore, direction: dir, magnitude,
    reason: isAnomaly ? `${dir === "drop" ? "queda" : "alta"} de ${fmt} vs baseline` : "dentro do normal",
  };
}

/** §56 — há cooldown ativo? true = ainda dentro da janela desde o último disparo. */
export function cooldownActive(lastFiredAt: string | null | undefined, cooldownMs: number, now = Date.now()): boolean {
  if (!lastFiredAt) return false;
  const t = Date.parse(lastFiredAt);
  if (!Number.isFinite(t)) return false;
  return now - t < cooldownMs;
}

/** §25 — TTL: instante de expiração (ISO) a partir de agora + ttlMs. */
export function ttlIso(ttlMs: number, now = Date.now()): string {
  return new Date(now + ttlMs).toISOString();
}
