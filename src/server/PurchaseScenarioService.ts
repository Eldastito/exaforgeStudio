import { CashForecastService, ForecastWeek, Scenario } from "./CashForecastService.js";
import { DecisionSimulatorService } from "./DecisionSimulatorService.js";
import { HealthyReserveService } from "./HealthyReserveService.js";

/**
 * PurchaseScenarioService — ADR-204 F3.9 (compras, SÓ ANÁLISE — RN-F3-14).
 *
 * "Posso comprar R$ X de estoque?" em 3 cenários (conservador/base/otimista) que LIGAM o que já existe: caixa de 13 semanas
 * (`CashForecastService`, com a compra como saída), cobertura/encalhe do estoque (`DecisionSimulatorService.buyStock`/`RetailImpactService.stockCapital`)
 * e a reserva saudável (`HealthyReserveService`, ADR-201). READ-ONLY e determinístico: NÃO cria pedido, NÃO paga, NÃO fala com fornecedor, NÃO grava decisão/ação
 * (só a sincronização idempotente de vendas pagas no caixa que o próprio motor de caixa já faz ao projetar) — a contraproposta é um RASCUNHO de texto que o dono lê e decide (a IA só recomenda; RN-F3-3/14).
 *
 * Honestidade: caixa/margem/giro ausentes → o campo vem `null` e entra em `caveats` (nunca 0, nunca inventado). Os fatores dos cenários
 * (±30% na velocidade de venda e nos recebíveis) são PREMISSA declarada, a mesma do motor de caixa — não dado medido. Encalhe usa só o giro MEDIDO
 * (sem saídas registradas → null). "Orçamento máximo" = o menor entre o que o caixa conservador aguenta (sem furar o caixa mínimo) e o que mantém a
 * cobertura ≤ 120 dias; sem uma das bases, usa a outra e diz qual. Veredito é conselho, nunca ordem.
 */
const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
const brl = (n: number) => `R$ ${round2(n).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const COVERAGE_OK = 60, COVERAGE_MAX = 120;
const SCEN: Array<{ key: "conservador" | "base" | "otimista"; label: string; cash: Scenario; velocity: number }> = [
  { key: "conservador", label: "Conservador", cash: "pessimista", velocity: 0.7 },
  { key: "base", label: "Base", cash: "provavel", velocity: 1.0 },
  { key: "otimista", label: "Otimista", cash: "otimista", velocity: 1.3 },
];

export interface PurchaseScenario {
  key: string; label: string; cashScenario: string; velocityFactor: number;
  minEndingWith: number; minEndingWithout: number; firstRiskWith: { weekStart: string; weeksAhead: number; risk: string } | null; firstRiskWithout: { weekStart: string; weeksAhead: number; risk: string } | null; breachesMinCash: boolean;
  coverageDaysAfter: number | null; sellThroughDays: number | null; grossProfitIfSold: number | null;
}
export interface PurchaseAnalysis {
  ok: boolean; reason?: string; message?: string;
  amount?: number; minCash?: number; minCashSource?: "informado" | "padrao_zero"; payInWeeks?: number;
  scenarios?: PurchaseScenario[];
  stock?: { totalCapital: number; currentCoverageDays: number | null; giroMeasured: boolean; estIdle: number | null; slowPct: number | null };
  reserve?: { available: boolean; overallStatus: string; note: string };
  recommendedMaxBudget?: { amount: number | null; basis: string; byCash: number | null; byCoverage: number | null };
  verdict?: "ok" | "attention" | "not_recommended" | "insufficient_data"; reasons?: string[]; caveats?: string[]; assumptions?: string[];
  counterproposalDraft?: string | null; executes: false; generatedAt?: string;
}

function withPurchase(weeks: ForecastWeek[], amount: number, payWeek: number, minCash: number) {
  const adj = weeks.map((w, i) => {
    const ending = i >= payWeek ? round2(w.ending - amount) : w.ending;
    return { weekStart: w.weekStart, ending, risk: ending < 0 ? "negative" : ending < minCash ? "tight" : "ok" } as { weekStart: string; ending: number; risk: string };
  });
  const idx = adj.findIndex((w) => w.risk !== "ok");
  return { minEnding: Math.min(...adj.map((w) => w.ending)), firstRisk: idx < 0 ? null : { weekStart: adj[idx].weekStart, weeksAhead: idx, risk: adj[idx].risk } };
}

export class PurchaseScenarioService {
  static analyze(orgId: string, input: { amount: unknown; minCash?: unknown; payInWeeks?: unknown }): PurchaseAnalysis {
    const amount = Number(input?.amount);
    if (!(amount > 0) || !Number.isFinite(amount)) return { ok: false, reason: "valor_invalido", message: "Informe o valor da compra.", executes: false };
    const minCashRaw = input?.minCash;
    const hasMin = minCashRaw != null && minCashRaw !== "" && Number.isFinite(Number(minCashRaw)) && Number(minCashRaw) >= 0;
    const minCash = hasMin ? round2(Number(minCashRaw)) : 0;
    const payInWeeks = Math.min(12, Math.max(0, Math.floor(Number(input?.payInWeeks) || 0)));
    const caveats: string[] = [];
    if (!hasMin) caveats.push("Caixa mínimo não informado: considerei R$ 0,00 (só avisa se o caixa ficar NEGATIVO). Informe um mínimo pra uma análise mais prudente.");

    // ── estoque: reusa o simulador (cobertura, encalhe) ──
    const buy: any = DecisionSimulatorService.buyStock(orgId, { amount });
    const totalCapital = Number(buy.totalCapital) || 0;
    const cogsDaily: number | null = buy.coverageKnown && Number(buy.cogsDaily) > 0 ? Number(buy.cogsDaily) : null;
    const giroMeasured = buy.estIdle !== null && buy.estIdle !== undefined;
    const { marginFrac } = DecisionSimulatorService.marginContext(orgId);
    if (cogsDaily == null) caveats.push("Sem velocidade de venda (margem/vendas) o sistema não estima a cobertura em dias nem o payback.");
    if (!giroMeasured) caveats.push("O giro do estoque não é medido (sem saídas registradas): não estimo quanto ficaria parado.");

    // ── caixa: 3 cenários com a compra como saída ──
    const fc = CashForecastService.forecast(orgId, { minCash });
    if (fc.confidence === "baixa") caveats.push(`A projeção de caixa tem confiança BAIXA — faltam: ${fc.missing.join(", ") || "dados"}.`);
    const scenarios: PurchaseScenario[] = SCEN.map((s) => {
      const weeks = CashForecastService.buildWeeks(orgId, { scenario: s.cash, minCash });
      const without = withPurchase(weeks, 0, 0, minCash), withP = withPurchase(weeks, amount, payInWeeks, minCash);
      const v = cogsDaily != null ? cogsDaily * s.velocity : null;
      return {
        key: s.key, label: s.label, cashScenario: s.cash, velocityFactor: s.velocity,
        minEndingWith: withP.minEnding, minEndingWithout: without.minEnding, firstRiskWith: withP.firstRisk, firstRiskWithout: without.firstRisk,
        breachesMinCash: withP.minEnding < minCash && withP.minEnding < without.minEnding,
        coverageDaysAfter: v != null ? Math.round((totalCapital + amount) / v) : null,
        sellThroughDays: v != null ? Math.round(amount / v) : null,
        grossProfitIfSold: marginFrac > 0 && marginFrac < 1 ? round2((amount * marginFrac) / (1 - marginFrac)) : null,
      };
    });
    if (!(marginFrac > 0)) caveats.push("Sem margem cadastrada: não estimo o lucro bruto da compra.");

    // ── orçamento máximo: o menor entre o caixa conservador e a cobertura ≤120d ──
    const cons = CashForecastService.buildWeeks(orgId, { scenario: "pessimista", minCash });
    const byCash = (() => { const tail = cons.slice(payInWeeks).map((w) => w.ending - minCash); return tail.length ? Math.max(0, round2(Math.min(...tail))) : null; })();
    const byCoverage = cogsDaily != null ? Math.max(0, round2(COVERAGE_MAX * cogsDaily * 0.7 - totalCapital)) : null;   // velocidade conservadora
    const bases = [byCash, byCoverage].filter((x): x is number => x != null);
    const maxAmount = bases.length ? Math.min(...bases) : null;
    const maxBasis = byCash != null && byCoverage != null ? (byCash <= byCoverage ? "caixa conservador" : "cobertura de 120 dias (venda conservadora)") : byCash != null ? "caixa conservador (sem velocidade de venda pra cobertura)" : byCoverage != null ? "cobertura de 120 dias (sem projeção de caixa)" : "sem base";

    // ── reserva saudável (ADR-201): só contexto, nunca bloqueia ──
    let reserve = { available: false, overallStatus: "no_data", note: "Sem base pra avaliar a reserva saudável." };
    try {
      const p = HealthyReserveService.plan(orgId);
      reserve = { available: p.available, overallStatus: p.overallStatus, note: p.available ? (p.overallStatus === "ok" ? "A alocação do mês está dentro do saudável." : `A alocação do mês está fora do saudável (${p.overallStatus}) — comprar mais agora aperta ainda mais a reserva.`) : reserve.note };
    } catch { /* sem DRE */ }

    // ── veredito (conselho) ──
    const base = scenarios.find((s) => s.key === "base")!, cservative = scenarios.find((s) => s.key === "conservador")!;
    const reasons: string[] = [];
    let verdict: PurchaseAnalysis["verdict"] = "ok";
    const cashKnown = fc.confidence !== "baixa";
    if (cservative.breachesMinCash) { verdict = "not_recommended"; reasons.push(`No cenário conservador o caixa fica em ${brl(cservative.minEndingWith)}, abaixo do mínimo (${brl(minCash)}).`); }
    if (base.coverageDaysAfter != null && base.coverageDaysAfter > COVERAGE_MAX) { verdict = "not_recommended"; reasons.push(`A cobertura iria a ${base.coverageDaysAfter} dias (> ${COVERAGE_MAX}) — muito estoque pro ritmo de venda.`); }
    if (verdict === "ok") {
      if (base.breachesMinCash) { verdict = "attention"; reasons.push(`No cenário base o caixa encosta no mínimo (${brl(base.minEndingWith)}).`); }
      if (base.coverageDaysAfter != null && base.coverageDaysAfter > COVERAGE_OK) { verdict = "attention"; reasons.push(`A cobertura iria a ${base.coverageDaysAfter} dias (> ${COVERAGE_OK}).`); }
      if (reserve.overallStatus === "baixo" || reserve.overallStatus === "excesso") { verdict = "attention"; reasons.push("A reserva saudável do mês já está fora do ideal."); }
      if (giroMeasured && buy.slowPct != null && buy.slowPct >= 30) { verdict = "attention"; reasons.push(`~${buy.slowPct}% do estoque hoje não gira — risco de encalhe (~${brl(buy.estIdle)}).`); }
    }
    if (!cashKnown && cogsDaily == null) { verdict = "insufficient_data"; reasons.unshift("Faltam dados de caixa e de velocidade de venda pra concluir."); }
    else if (verdict === "ok" && (!cashKnown || cogsDaily == null)) { verdict = "attention"; reasons.push("Análise incompleta (faltam dados de " + (!cashKnown ? "caixa" : "velocidade de venda") + ") — confirme antes de decidir."); }
    if (verdict === "ok") reasons.push("Dentro do caixa e da cobertura nos três cenários.");

    const counterproposalDraft = maxAmount != null && amount > maxAmount && verdict !== "insufficient_data"
      ? `RASCUNHO (não enviado — você decide): "Hoje consigo fechar um pedido de até ${brl(maxAmount)} neste ciclo. Podemos reduzir o pedido de ${brl(amount)} para esse valor, ou manter o volume com pagamento parcelado/prazo maior? Posso complementar no próximo ciclo."`
      : null;

    return {
      ok: true, amount: round2(amount), minCash, minCashSource: hasMin ? "informado" : "padrao_zero", payInWeeks, scenarios,
      stock: { totalCapital, currentCoverageDays: cogsDaily != null ? Math.round(totalCapital / cogsDaily) : null, giroMeasured, estIdle: buy.estIdle ?? null, slowPct: buy.slowPct ?? null },
      reserve, recommendedMaxBudget: { amount: maxAmount, basis: maxBasis, byCash, byCoverage },
      verdict, reasons, caveats,
      assumptions: ["Cenários variam ±30% na velocidade de venda e nos recebíveis (premissa do motor de caixa, não dado medido).", `A compra sai do caixa na semana ${payInWeeks} (0 = esta semana).`, "Encalhe usa só o giro medido; sem saídas registradas fica sem estimativa.", "Orçamento máximo = o menor entre o que o caixa conservador aguenta e a cobertura de 120 dias com venda conservadora."],
      counterproposalDraft, executes: false, generatedAt: new Date().toISOString(),
    };
  }
}

export default PurchaseScenarioService;
