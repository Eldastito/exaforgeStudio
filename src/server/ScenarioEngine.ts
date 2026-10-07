import { createHash } from "node:crypto";
import { PurchaseScenarioService } from "./PurchaseScenarioService.js";
import { DecisionSimulatorService } from "./DecisionSimulatorService.js";

/**
 * ScenarioEngine — ADR-205 F4.1: UM contrato de simulação ("e se eu fizer isso?") sobre os simuladores que JÁ existem.
 *
 * NÃO é um 2º simulador (RN-F4-11): os cálculos de caixa, cobertura de estoque, margem e contratação continuam em
 * `PurchaseScenarioService` / `CashForecastService` / `DecisionSimulatorService`. O motor só (a) padroniza a SAÍDA, (b) separa dado de premissa,
 * (c) devolve FAIXA em vez de número pontual, (d) calcula sensibilidade re-rodando o cálculo canônico, (e) declara a confiança.
 *
 * Regras (RN-F4):
 *  - CENÁRIO ≠ PREVISÃO (RN-F4-3): toda saída é `type:"scenario"`, `isForecast:false`, com a frase "se estas premissas ocorrerem…". Nunca "vai acontecer".
 *  - Premissas visíveis, editáveis e versionadas (RN-F4-4): `assumptions[]` marca a origem (`data` medido · `default` do sistema · `user` informado por quem simulou);
 *    refazer a simulação com outro valor é "alterar a premissa". `assumptionsVersion` = hash das premissas (F4.2 persiste e compara com o real).
 *  - FAIXA, não ponto (RN-F4-5): `range.display` arredonda (2 algarismos significativos; 3 a partir de 1 milhão: "R$ 1,15 mi", nunca "R$ 1.283.472,19").
 *  - Dado ausente → null + confiança menor, nunca 0 (RN-F4-6).
 *  - NUNCA executa (RN-F4-1): `executes:false`; nada é gravado, criado, pago ou enviado.
 *  - CONFIANÇA limitada a "media" enquanto `PILOT_VALIDATED=false` (ADR-204 §28.5: os limiares/dados não foram conferidos em uso real). Virar `true` é decisão do dono.
 * Fora desta fatia (declarado, não fingido): nova loja, fechamento, canibalização, orçamento, backtest — dependem de dado que o sistema não tem (ver ADR-205).
 */
export const SCENARIO_ENGINE_VERSION = "4.1.0";
export const PILOT_VALIDATED = false;

export type ScenarioKind = "purchase" | "sales_change" | "hire";
export type ConfidenceLevel = "alta" | "media" | "baixa";
export interface Assumption { key: string; label: string; value: number | string | null; unit: string; source: "data" | "default" | "user"; editable: boolean; note?: string }
export interface Range { low: number | null; high: number | null; display: string | null }
export interface ScenarioMetric { key: string; label: string; unit: "BRL" | "dias" | "pct" | "count"; conservative: number | null; base: number | null; favorable: number | null; range: Range }
export interface SensitivityRow { rank: number; driver: string; label: string; lowCase: string; highCase: string; output: string; swing: number | null }
export interface ScenarioOutcome {
  ok: boolean; reason?: string; message?: string;
  type: "scenario"; isForecast: false; executes: false; kind: string; engineVersion: string;
  statement?: string; horizon?: string; cases?: "three" | "single";
  assumptions?: Assumption[]; assumptionsVersion?: string;
  metrics?: ScenarioMetric[]; sensitivity?: SensitivityRow[];
  confidence?: { level: ConfidenceLevel; reasons: string[] }; caveats?: string[]; verdict?: string | null;
  generatedAt?: string;
}

const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
const fail = (kind: string, reason: string, message: string): ScenarioOutcome => ({ ok: false, reason, message, type: "scenario", isForecast: false, executes: false, kind, engineVersion: SCENARIO_ENGINE_VERSION });
const num = (v: unknown): number | null => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

/** Arredonda p/ tirar a falsa precisão: 2 algarismos significativos (3 a partir de 1 milhão, p/ "R$ 1,15 mi"): 12.345 → 12.000; 1.283.472 → 1.280.000. */
function sig(v: number): number {
  if (v === 0) return 0;
  const digits = Math.abs(v) >= 1e6 ? 3 : 2;
  const m = Math.pow(10, Math.floor(Math.log10(Math.abs(v))) - (digits - 1));
  return Math.round(v / m) * m;
}
const group = (n: number) => String(Math.round(Math.abs(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
function fmt(v: number, unit: ScenarioMetric["unit"]): string {
  const s = sig(v), neg = s < 0 ? "-" : "";
  if (unit === "BRL") {
    if (Math.abs(s) >= 1e6) return `R$ ${neg}${(Math.abs(s) / 1e6).toFixed(2).replace(".", ",").replace(/,?0+$/, "").replace(/,$/, "")} mi`;
    return `R$ ${neg}${group(s)}`;
  }
  if (unit === "pct") return `${neg}${group(s)}%`;
  if (unit === "dias") return `${neg}${group(s)} dias`;
  return `${neg}${group(s)}`;
}
export function toRange(values: Array<number | null | undefined>, unit: ScenarioMetric["unit"]): Range {
  const v = values.filter((x): x is number => typeof x === "number" && Number.isFinite(x));
  if (!v.length) return { low: null, high: null, display: null };
  const low = Math.min(...v), high = Math.max(...v);
  const a = fmt(low, unit), b = fmt(high, unit);
  return { low: round2(low), high: round2(high), display: a === b ? `≈ ${a}` : `${a} – ${b}` };
}
const metric = (key: string, label: string, unit: ScenarioMetric["unit"], conservative: number | null, base: number | null, favorable: number | null): ScenarioMetric =>
  ({ key, label, unit, conservative, base, favorable, range: toRange([conservative, base, favorable], unit) });

function version(a: Assumption[]): string {
  const canon = JSON.stringify(a.map((x) => [x.key, x.value, x.source]).sort((p, q) => String(p[0]).localeCompare(String(q[0]))));
  return createHash("sha256").update(canon).digest("hex").slice(0, 12);
}
function rank(rows: Array<Omit<SensitivityRow, "rank">>): SensitivityRow[] {
  return [...rows].sort((a, b) => (b.swing ?? -1) - (a.swing ?? -1)).map((r, i) => ({ rank: i + 1, ...r }));
}
/** Confiança do adaptador, limitada pelo gate do piloto. */
function confidence(raw: ConfidenceLevel, reasons: string[]): { level: ConfidenceLevel; reasons: string[] } {
  let level = raw; const out = [...reasons];
  if (!PILOT_VALIDATED && level === "alta") { level = "media"; out.push("Limitada a média: os limiares e os dados ainda não foram conferidos em uso real na loja (ADR-204 §28)."); }
  return { level, reasons: out };
}
const KINDS: Array<{ kind: ScenarioKind; label: string; inputs: Array<{ key: string; label: string; unit: string; required: boolean }> }> = [
  { kind: "purchase", label: "Compra de estoque", inputs: [{ key: "amount", label: "Valor da compra", unit: "BRL", required: true }, { key: "minCash", label: "Caixa mínimo", unit: "BRL", required: false }, { key: "payInWeeks", label: "Semana do pagamento (0 = esta semana)", unit: "semanas", required: false }] },
  { kind: "sales_change", label: "Vendas sobem ou caem", inputs: [{ key: "changePct", label: "Variação das vendas (%)", unit: "pct", required: true }, { key: "baseRevenue30", label: "Receita de 30 dias (se quiser usar outra base)", unit: "BRL", required: false }] },
  { kind: "hire", label: "Contratação", inputs: [{ key: "monthlyCost", label: "Custo mensal da contratação", unit: "BRL", required: true }] },
];

export class ScenarioEngine {
  static kinds() { return KINDS; }

  static run(orgId: string, kind: string, inputs: Record<string, unknown> = {}): ScenarioOutcome {
    const spec = KINDS.find((k) => k.kind === kind);
    if (!spec) return fail(kind, "unknown_kind", `Tipo de cenário desconhecido: ${kind}.`);
    const inp = inputs && typeof inputs === "object" ? inputs : {};
    const unknown = Object.keys(inp).filter((k) => !spec.inputs.some((i) => i.key === k));
    if (unknown.length) return fail(kind, "unknown_assumption", `Premissa(s) desconhecida(s) para ${kind}: ${unknown.join(", ")}.`);
    if (kind === "purchase") return this.purchase(orgId, inp);
    if (kind === "sales_change") return this.salesChange(orgId, inp);
    return this.hire(orgId, inp);
  }

  // ── COMPRA — caixa, cobertura e lucro bruto vêm do PurchaseScenarioService; aqui só padroniza e mede a sensibilidade ──
  private static purchase(orgId: string, inp: Record<string, unknown>): ScenarioOutcome {
    const amount = num(inp.amount), minCashIn = num(inp.minCash), payIn = num(inp.payInWeeks);
    const a: any = PurchaseScenarioService.analyze(orgId, { amount: inp.amount, minCash: inp.minCash, payInWeeks: inp.payInWeeks });
    if (!a.ok) return fail("purchase", a.reason || "invalid", a.message || "Não foi possível simular.");
    const [c, b, f] = a.scenarios as any[];
    const { marginFrac } = DecisionSimulatorService.marginContext(orgId);
    const assumptions: Assumption[] = [
      { key: "amount", label: "Valor da compra", value: a.amount, unit: "BRL", source: "user", editable: true },
      { key: "minCash", label: "Caixa mínimo", value: a.minCash, unit: "BRL", source: minCashIn != null ? "user" : "default", editable: true, note: minCashIn != null ? undefined : "Não informado: considerei R$ 0 (só avisa se o caixa ficar negativo)." },
      { key: "payInWeeks", label: "Semana do pagamento", value: a.payInWeeks, unit: "semanas", source: payIn != null ? "user" : "default", editable: true },
      { key: "salesSpeedFactor", label: "Velocidade de venda nos cenários (conservador/base/favorável)", value: "−30% / 0 / +30%", unit: "", source: "default", editable: false, note: "Premissa do motor de caixa, não dado medido." },
      { key: "margin", label: "Margem média", value: marginFrac > 0 ? Math.round(marginFrac * 100) : null, unit: "pct", source: "data", editable: false, note: marginFrac > 0 ? undefined : "Sem margem cadastrada." },
      { key: "horizon", label: "Horizonte do caixa", value: 13, unit: "semanas", source: "default", editable: false },
    ];
    const metrics = [
      metric("min_cash_with_purchase", "Menor caixa projetado com a compra", "BRL", c.minEndingWith, b.minEndingWith, f.minEndingWith),
      metric("coverage_days_after", "Cobertura do estoque depois da compra", "dias", c.coverageDaysAfter, b.coverageDaysAfter, f.coverageDaysAfter),
      metric("gross_profit_if_sold", "Lucro bruto se vender tudo", "BRL", b.grossProfitIfSold, b.grossProfitIfSold, b.grossProfitIfSold),
    ];
    // Sensibilidade: re-roda o CÁLCULO CANÔNICO variando um driver por vez; saída = menor caixa no cenário conservador.
    const out = (over: Record<string, unknown>) => { const x: any = PurchaseScenarioService.analyze(orgId, { amount: a.amount, minCash: a.minCash, payInWeeks: a.payInWeeks, ...over }); return x.ok ? Number(x.scenarios[0].minEndingWith) : null; };
    const diff = (x: number | null, y: number | null) => (x == null || y == null ? null : round2(Math.abs(x - y)));
    const pay = a.payInWeeks as number;
    const sens = rank([
      { driver: "amount", label: "Valor da compra (preço do fornecedor)", lowCase: "−20%", highCase: "+20%", output: "Menor caixa no cenário conservador", swing: diff(out({ amount: a.amount * 0.8 }), out({ amount: a.amount * 1.2 })) },
      { driver: "payInWeeks", label: "Prazo de pagamento", lowCase: `semana ${Math.max(0, pay - 4)}`, highCase: `semana ${Math.min(12, pay + 4)}`, output: "Menor caixa no cenário conservador", swing: diff(out({ payInWeeks: Math.max(0, pay - 4) }), out({ payInWeeks: Math.min(12, pay + 4) })) },
    ]);
    const caveats: string[] = [...(a.caveats || []), "Sensibilidade cobre só valor e prazo: entrada, margem final e remarcação (markdown) não são modelados pelo sistema hoje."];
    const reasons = (a.caveats || []).filter((x: string) => !/Caixa mínimo não informado/.test(x));
    const raw: ConfidenceLevel = a.verdict === "insufficient_data" || reasons.some((x: string) => /BAIXA/.test(x)) || reasons.length >= 3 ? "baixa" : reasons.length ? "media" : "alta";
    const lo = metrics[0].range.display;
    return {
      ok: true, type: "scenario", isForecast: false, executes: false, kind: "purchase", engineVersion: SCENARIO_ENGINE_VERSION, cases: "three",
      statement: `Se as premissas abaixo ocorrerem (compra de ${fmt(a.amount, "BRL")} paga na semana ${a.payInWeeks}), o menor caixa projetado ficaria ${lo ? `em ${lo}` : "indeterminado (faltam dados)"}. Não é uma previsão.`,
      horizon: "13 semanas", assumptions, assumptionsVersion: version(assumptions), metrics, sensitivity: sens,
      confidence: confidence(raw, reasons.length ? reasons : ["Dados de caixa e venda disponíveis."]), caveats, verdict: a.verdict ?? null, generatedAt: new Date().toISOString(),
    };
  }

  // ── VENDAS ± X% — receita de 30 dias e margem vêm do simulador; o motor só aplica a premissa e mostra o efeito no lucro bruto ──
  private static salesChange(orgId: string, inp: Record<string, unknown>): ScenarioOutcome {
    const change = num(inp.changePct);
    if (change == null) return fail("sales_change", "premissa_invalida", "Informe a variação das vendas em % (ex.: -20 ou 20).");
    if (change < -95 || change > 200) return fail("sales_change", "premissa_fora_da_faixa", "A variação deve ficar entre -95% e +200%.");
    const baseIn = num(inp.baseRevenue30);
    const ctx = DecisionSimulatorService.marginContext(orgId);
    const base = baseIn != null && baseIn > 0 ? baseIn : ctx.revenue30;
    if (!(base > 0)) return fail("sales_change", "sem_vendas", "Sem vendas nos últimos 30 dias para usar como base. Informe a receita de 30 dias (baseRevenue30) para simular.");
    const m = ctx.marginFrac > 0 && ctx.marginFrac < 1 ? ctx.marginFrac : null;
    const shock = DecisionSimulatorService.scenarios(orgId, { base, conservativePct: 1 + change / 100, aggressivePct: 1 + change / 100 }).conservative.value as number;
    const gp = (rev: number) => (m != null ? round2(rev * m) : null);
    const gpToday = gp(base), gpShock = gp(shock);
    const assumptions: Assumption[] = [
      { key: "changePct", label: "Variação das vendas", value: change, unit: "pct", source: "user", editable: true },
      { key: "baseRevenue30", label: "Receita dos últimos 30 dias (base)", value: round2(base), unit: "BRL", source: baseIn != null && baseIn > 0 ? "user" : "data", editable: true },
      { key: "margin", label: "Margem média", value: m != null ? Math.round(m * 100) : null, unit: "pct", source: "data", editable: false, note: m != null ? "Mantida igual nos dois casos." : "Sem margem cadastrada." },
    ];
    const metrics = [
      metric("revenue_today", "Receita de 30 dias hoje", "BRL", null, round2(base), null),
      metric("revenue_with_change", "Receita de 30 dias com a variação", "BRL", null, round2(shock), null),
      metric("gross_profit_delta", "Variação do lucro bruto no mês", "BRL", null, gpToday != null && gpShock != null ? round2(gpShock - gpToday) : null, null),
    ];
    const deltaAt = (chg: number, mm: number | null) => (mm == null ? null : round2(base * (chg / 100) * mm));
    const sens = rank([
      { driver: "changePct", label: "Variação das vendas", lowCase: `${change - 10}%`, highCase: `${change + 10}%`, output: "Variação do lucro bruto", swing: m != null ? round2(Math.abs((deltaAt(change + 10, m) as number) - (deltaAt(change - 10, m) as number))) : null },
      { driver: "margin", label: "Margem média", lowCase: m != null ? `${Math.round(m * 100) - 5} p.p.` : "—", highCase: m != null ? `${Math.round(m * 100) + 5} p.p.` : "—", output: "Variação do lucro bruto", swing: m != null ? round2(Math.abs((deltaAt(change, m + 0.05) as number) - (deltaAt(change, Math.max(0, m - 0.05)) as number))) : null },
    ]);
    const reasons: string[] = m != null ? ["Receita de 30 dias e margem disponíveis."] : ["Sem margem cadastrada: o efeito no lucro não pode ser estimado."];
    const caveats = ["Custos fixos não entram: o sistema não tem custo fixo estruturado para o varejo, então não afirmo se o resultado do mês fica positivo ou negativo nem o ponto de equilíbrio.", "A margem é mantida igual nos dois casos; desconto para vender mais não é modelado."];
    const lp = metrics[2].range.display;
    return {
      ok: true, type: "scenario", isForecast: false, executes: false, kind: "sales_change", engineVersion: SCENARIO_ENGINE_VERSION, cases: "single",
      statement: `Se as vendas variarem ${change > 0 ? "+" : ""}${change}% sobre os últimos 30 dias, o lucro bruto do mês ${lp ? `variaria ${lp}` : "não pode ser estimado (falta margem)"}. Não é uma previsão.`,
      horizon: "1 mês (base: últimos 30 dias)", assumptions, assumptionsVersion: version(assumptions), metrics, sensitivity: sens,
      confidence: confidence(m != null ? "alta" : "baixa", reasons), caveats, verdict: null, generatedAt: new Date().toISOString(),
    };
  }

  // ── CONTRATAÇÃO — a conta (custo ÷ margem) é do DecisionSimulatorService.hire ──
  private static hire(orgId: string, inp: Record<string, unknown>): ScenarioOutcome {
    const cost = num(inp.monthlyCost);
    const h: any = DecisionSimulatorService.hire(orgId, { monthlyCost: cost as number });
    if (!h.ok) return fail("hire", h.reason || "invalid", h.message || "Não foi possível simular.");
    const assumptions: Assumption[] = [
      { key: "monthlyCost", label: "Custo mensal da contratação", value: h.monthlyCost, unit: "BRL", source: "user", editable: true },
      { key: "margin", label: "Margem média", value: h.marginPct, unit: "pct", source: "data", editable: false },
      { key: "monthlyRevenue", label: "Receita do mês", value: h.monthlyRevenue > 0 ? h.monthlyRevenue : null, unit: "BRL", source: "data", editable: false },
    ];
    const metrics = [
      metric("extra_revenue_needed", "Venda extra por mês para pagar a contratação", "BRL", null, h.extraRevenueNeeded, null),
      metric("pct_of_current", "Equivale a quanto sobre a receita de hoje", "pct", null, h.pctOfCurrent, null),
      metric("extra_tickets_per_day", "Atendimentos extras por dia", "count", null, h.extraTicketsPerDay, null),
    ];
    const swingFor = (k: number) => { const x: any = DecisionSimulatorService.hire(orgId, { monthlyCost: h.monthlyCost * k }); return x.ok ? x.extraRevenueNeeded : null; };
    const s1 = swingFor(0.8), s2 = swingFor(1.2);
    const sens = rank([{ driver: "monthlyCost", label: "Custo mensal da contratação", lowCase: "−20%", highCase: "+20%", output: "Venda extra necessária", swing: s1 != null && s2 != null ? round2(Math.abs(s2 - s1)) : null }]);
    const reasons = h.pctOfCurrent != null ? ["Margem e receita do mês disponíveis."] : ["Sem receita do mês: não comparo com o faturamento atual."];
    const caveats = ["Não estima o quanto o novo funcionário realmente gera de venda — só quanto precisa gerar para se pagar.", "Encargos, benefícios e custo de contratação entram só se você incluir no custo mensal informado.", "A margem é fixa nesta simulação; a sensibilidade à margem não está disponível."];
    const ex = metrics[0].range.display;
    return {
      ok: true, type: "scenario", isForecast: false, executes: false, kind: "hire", engineVersion: SCENARIO_ENGINE_VERSION, cases: "single",
      statement: `Se a contratação custar ${fmt(h.monthlyCost, "BRL")} por mês, ela precisa gerar ${ex ? ex : "—"} a mais em vendas por mês com a margem de hoje para se pagar. Não é uma previsão de que isso aconteça.`,
      horizon: "1 mês", assumptions, assumptionsVersion: version(assumptions), metrics, sensitivity: sens,
      confidence: confidence(h.pctOfCurrent != null ? "alta" : "media", reasons), caveats, verdict: null, generatedAt: new Date().toISOString(),
    };
  }
}

export default ScenarioEngine;
