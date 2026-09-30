/**
 * Estados semânticos de informação (PRD Fase 1, F1.0) — função PURA (sem React/DB),
 * importável pelo servidor, pelas telas e pelos testes.
 *
 * O produto não pode tratar tudo como `0`. Cinco estados distintos:
 *   value          → valor CONHECIDO (inclui o ZERO REAL: `R$ 0,00` = o sistema sabe que foi zero)
 *   unknown        → informação ainda não disponível (`—`)
 *   not_computed   → não calculado porque faltam dados ("Não calculado")
 *   not_applicable → a métrica não se aplica (`N/A`)
 *   estimate       → estimativa, sempre com confiança/origem quando relevante
 *
 * Regras (RN-SEM-*):
 *  - null/undefined/NaN NUNCA viram 0 (zero real só entra como `known(0)`).
 *  - Total com parcela desconhecida NÃO é total: vira `not_computed` (o parcial fica à
 *    parte em `partialFact` para quem precisar exibir "até agora").
 *  - fato e estimativa NUNCA são somados (convenção do repo — fact ≠ estimate).
 *  - Razão (ex.: atingimento) com denominador desconhecido → `not_computed`; denominador
 *    zero → `not_applicable` (não existe % de uma meta zero). Nunca 0%/NaN/Infinity.
 * Um Metric é JSON puro — atravessa a API sem adaptação.
 */
export type MetricState = "value" | "unknown" | "not_computed" | "not_applicable" | "estimate";
export type MetricUnit = "brl" | "count" | "pct";

export interface Metric {
  state: MetricState;
  value: number | null;          // só preenchido em `value` e `estimate`
  unit?: MetricUnit;
  reason?: string | null;        // por que unknown/not_computed/not_applicable
  source?: string | null;        // origem do dado (ex.: "alterdata", "fechamento")
  confidence?: number | null;    // 0..1 — obrigatório pensar nele em `estimate`
}

type Opts = { unit?: MetricUnit; source?: string | null };

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Valor CONHECIDO (inclui 0). Não-finito vira `unknown` — nunca 0 silencioso. */
export function known(v: unknown, o: Opts = {}): Metric {
  if (!finite(v)) return unknown("valor inválido", o);
  return { state: "value", value: v, unit: o.unit, source: o.source ?? null };
}
export function unknown(reason?: string | null, o: Opts = {}): Metric {
  return { state: "unknown", value: null, unit: o.unit, reason: reason ?? null, source: o.source ?? null };
}
export function notComputed(reason: string, o: Opts = {}): Metric {
  return { state: "not_computed", value: null, unit: o.unit, reason, source: o.source ?? null };
}
export function notApplicable(reason?: string | null, o: Opts = {}): Metric {
  return { state: "not_applicable", value: null, unit: o.unit, reason: reason ?? null, source: o.source ?? null };
}
export function estimate(v: unknown, o: Opts & { confidence?: number | null } = {}): Metric {
  if (!finite(v)) return unknown("estimativa inválida", o);
  const c = finite(o.confidence) ? Math.max(0, Math.min(1, o.confidence)) : null;
  return { state: "estimate", value: v, unit: o.unit, source: o.source ?? null, confidence: c };
}
/** Ponte do legado: null/undefined/NaN/"" → unknown; número (ou string numérica) → known. */
export function fromNullable(v: unknown, o: Opts & { reason?: string | null } = {}): Metric {
  if (v === null || v === undefined || v === "") return unknown(o.reason ?? null, o);
  const n = typeof v === "string" ? Number(v.replace(",", ".")) : v;
  return finite(n) ? known(n, o) : unknown(o.reason ?? "valor inválido", o);
}

export const isKnown = (m: Metric | null | undefined): boolean => !!m && m.state === "value";
/** Tem número exibível (conhecido OU estimado). */
export const hasNumber = (m: Metric | null | undefined): boolean => !!m && (m.state === "value" || m.state === "estimate") && finite(m.value);

function group(n: number): string {
  const [int, dec] = Math.abs(n).toFixed(2).split(".");
  return `${int.replace(/\B(?=(\d{3})+(?!\d))/g, ".")},${dec}`;
}

/** BRL a partir de número BRUTO ou legado (null/undefined/"" → "—", nunca "R$ 0,00"). */
export function formatBRL(v: unknown): string {
  const m = fromNullable(v);
  if (m.state !== "value") return "—";
  const n = m.value as number;
  return `${n < 0 ? "-" : ""}R$ ${group(n)}`;
}

function fmtNumber(n: number, unit?: MetricUnit): string {
  if (unit === "brl") return `${n < 0 ? "-" : ""}R$ ${group(n)}`;
  if (unit === "pct") return `${Math.round(n * 10) / 10}%`.replace(".", ",");
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100).replace(".", ",");
}

/** Texto curto para a tela. O motivo/confiança ficam em `metricNote`. */
export function formatMetric(m: Metric | null | undefined, opts: { unit?: MetricUnit } = {}): string {
  if (!m) return "—";
  const unit = opts.unit ?? m.unit;
  switch (m.state) {
    case "value": return fmtNumber(m.value as number, unit);
    case "estimate": return `${fmtNumber(m.value as number, unit)} — estimativa`;
    case "not_computed": return "Não calculado";
    case "not_applicable": return "N/A";
    default: return "—";
  }
}

/** Contexto que acompanha o número: origem, confiança da estimativa ou por que não há valor. */
export function metricNote(m: Metric | null | undefined): string | null {
  if (!m) return null;
  const parts: string[] = [];
  if (m.state === "estimate" && finite(m.confidence)) parts.push(`confiança ${Math.round((m.confidence as number) * 100)}%`);
  if (m.reason && m.state !== "value") parts.push(m.reason);
  if (m.source) parts.push(`fonte: ${m.source}`);
  return parts.length ? parts.join(" · ") : null;
}

/**
 * Soma honesta. `fact` só é um total quando TODAS as parcelas aplicáveis são conhecidas;
 * senão `not_computed` (o que já se sabe fica em `partialFact`, para "até agora").
 * Estimativas somam à parte (`estimate`) — nunca dentro do fato. `not_applicable` é ignorado.
 */
export function combineMetrics(ms: Array<Metric | null | undefined>, o: Opts = {}): { fact: Metric; estimate: Metric; unresolved: number; partialFact: number | null } {
  const list = ms.map((m) => m ?? unknown());
  const facts = list.filter((m) => m.state === "value");
  const ests = list.filter((m) => m.state === "estimate");
  const unresolved = list.filter((m) => m.state === "unknown" || m.state === "not_computed").length;
  const sum = (a: Metric[]) => a.reduce((s, m) => s + (m.value as number), 0);
  const partialFact = facts.length ? sum(facts) : null;
  const fact = unresolved > 0
    ? notComputed(`faltam ${unresolved} fonte(s)`, o)
    : facts.length ? known(sum(facts), o) : unknown("sem dados", o);
  const estimate = ests.length
    ? estimateOf(sum(ests), ests, o)
    : notApplicable("sem estimativas", o);
  return { fact, estimate, unresolved, partialFact };
}
function estimateOf(total: number, ests: Metric[], o: Opts): Metric {
  const cs = ests.map((m) => m.confidence).filter(finite) as number[];
  // confiança do agregado = a MENOR (a corrente é tão forte quanto o elo mais fraco); sem confiança → null
  return estimate(total, { ...o, confidence: cs.length === ests.length ? Math.min(...cs) : null });
}

/** Razão (ex.: atingimento = vendido/meta). Nunca 0%/NaN/Infinity por dado ausente. */
export function ratioMetric(numerator: Metric | null | undefined, denominator: Metric | null | undefined, o: Opts = {}): Metric {
  const unit = o.unit ?? "pct";
  if (!hasNumber(numerator) || !hasNumber(denominator)) return notComputed("faltam dados para calcular", { ...o, unit });
  const d = denominator!.value as number;
  if (d === 0) return notApplicable("denominador zero", { ...o, unit });
  const r = ((numerator!.value as number) / d) * 100;
  // razão herda estimativa se qualquer lado for estimativa (mantém a honestidade)
  return numerator!.state === "estimate" || denominator!.state === "estimate"
    ? estimate(r, { ...o, unit, confidence: Math.min(...[numerator!, denominator!].map((m) => (finite(m.confidence) ? (m.confidence as number) : 1))) })
    : known(r, { ...o, unit });
}
