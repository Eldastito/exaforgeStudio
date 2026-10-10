/**
 * Cenário "e se?" (ADR-205 F4.14) — funções PURAS, sem React nem rede. Quem calcula é o `ScenarioEngine` (F4.1); aqui só se
 * converte o que o dono digitou em premissas e se traduz a resposta em frases. Nada aqui calcula, prevê ou recomenda.
 * Premissa inválida vira erro (nunca chuta); campo opcional em branco é OMITIDO (o servidor usa o padrão e diz qual).
 */
import { parseMoneyInput } from "../strategicplan/planLabels";

export interface ScenarioInputSpec { key: string; label: string; unit: string; required: boolean }
export interface ScenarioKindSpec { kind: string; label: string; inputs: ScenarioInputSpec[] }

/** Número com sinal ("-20", "+15", "12,5") → número, ou null. Usado só em variação percentual. */
export function parseSignedNumber(raw: unknown): number | null {
  const s = String(raw ?? "").replace(/\s/g, "").replace("%", "").replace(",", ".");
  if (!/^[+-]?\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Valor em reais que aceita ZERO (ex.: caixa mínimo 0). Vazio/lixo → null. */
function parseMoneyAllowZero(raw: unknown): number | null {
  const s = String(raw ?? "").replace(/R\$/gi, "").replace(/\s/g, "");
  if (/^0+([.,]0+)?$/.test(s)) return 0;
  return parseMoneyInput(raw);
}

/** O que o dono digitou → corpo do pedido. Obrigatório faltando/inválido → { ok:false, error } com a frase pra tela. */
export function buildScenarioInputs(spec: ScenarioKindSpec | undefined, raw: Record<string, string>): { ok: true; inputs: Record<string, number> } | { ok: false; error: string } {
  if (!spec) return { ok: false, error: "Escolha o que você quer simular." };
  const inputs: Record<string, number> = {};
  for (const f of spec.inputs) {
    const text = String(raw?.[f.key] ?? "").trim();
    if (!text) {
      if (f.required) return { ok: false, error: `Preencha: ${f.label}.` };
      continue;
    }
    const n = f.unit === "pct" ? parseSignedNumber(text)
      : f.unit === "BRL" ? (f.required ? parseMoneyInput(text) : parseMoneyAllowZero(text))
      : parseMoneyAllowZero(text);
    if (n == null) return { ok: false, error: `Não entendi o valor de "${f.label}". Use só números (ex.: ${f.unit === "pct" ? "-20" : "150.000"}).` };
    inputs[f.key] = n;
  }
  return { ok: true, inputs };
}

export const sourceLabel = (s: string | null | undefined): string =>
  s === "user" ? "informado por você" : s === "data" ? "medido na sua empresa" : s === "default" ? "padrão do sistema" : "";

export function confidenceLabel(level: string | null | undefined): string {
  return level === "alta" ? "confiança alta" : level === "media" ? "confiança média" : level === "baixa" ? "confiança baixa" : "";
}

const group = (n: number) => String(Math.round(Math.abs(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
/** Valor de uma premissa como o dono lê: R$, %, semanas… Ausente → "—" (null ≠ 0). Texto (ex.: "−30% / 0 / +30%") passa como veio. */
export function assumptionValue(a: { value: unknown; unit?: string }): string {
  const v = a?.value;
  if (v == null || v === "") return "—";
  if (typeof v === "string") return v;
  if (typeof v !== "number" || !Number.isFinite(v)) return "—";
  if (a.unit === "BRL") return `R$ ${v < 0 ? "-" : ""}${group(v)}`;
  if (a.unit === "pct") return `${v > 0 ? "+" : ""}${v}%`;
  if (a.unit === "semanas") return `semana ${v}`;
  return String(v);
}

/** Valor da métrica: a FAIXA arredondada que o motor devolveu; sem ela, "—" (nunca 0). */
export const metricDisplay = (m: { range?: { display?: string | null } | null } | null | undefined): string => m?.range?.display || "—";

/** Linha da sensibilidade: o que mais mexe no resultado, primeiro. */
export function sensitivityLine(r: { rank: number; label: string; lowCase: string; highCase: string; output: string; swing: number | null }): string {
  const sw = r.swing == null ? "sem como medir com os dados de hoje" : `muda o resultado em cerca de R$ ${group(r.swing)}`;
  return `${r.rank}º · ${r.label} (${r.lowCase} a ${r.highCase}): ${sw}`;
}
