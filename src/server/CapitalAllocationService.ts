import { ScenarioEngine, toRange, type Range } from "./ScenarioEngine.js";

/**
 * CapitalAllocationService — ADR-205 F4.5: COMPARA alternativas de investimento lado a lado. NÃO escolhe, NÃO ranqueia, NÃO recomenda.
 *
 * O dono tem R$ X e três usos possíveis (reformar a loja, comprar coleção, contratar). O sistema não sabe quanto cada um vai render — e inventar esse número
 * seria exatamente o erro que o PRD proíbe. Então o RETORNO ESPERADO é entrada ESTRUTURADA e OBRIGATÓRIA do dono: faixa mensal (pior–melhor), de onde vem
 * (`source`), quão firme é (`basis`: fact|estimate|hypothesis), o risco e se é reversível. O serviço só faz a aritmética e mostra os trade-offs.
 *
 * Regras (RN-F4):
 *  - Compara, não decide (RN-F4-2): não há "melhor", "vencedor" nem "recomendado" — só `byCriterion` (quem lidera EM CADA critério, com empates) e as combinações que cabem no capital (sem ordem de preferência).
 *    A decisão é de uma pessoa; depois de decidir, registra-se em `POST /strategic/decisions` (F4.2), que guarda a hipótese e depois confronta com o real.
 *  - Retorno é do DONO, nunca do sistema: sem faixa, sem origem, sem `basis`, sem risco ou sem reversibilidade → recusa (nada é preenchido por padrão). Retorno declarado como `hypothesis`/`estimate` baixa a confiança.
 *  - Faixa, não ponto (RN-F4-5): resultado em pior–melhor caso, arredondado. Payback "pode não se pagar" (null) quando o pior caso não tem retorno positivo — nunca um número otimista fingido.
 *  - Caixa: o desembolso de CADA opção é rodado no `ScenarioEngine` (reuso — RN-F4-11; nada de cálculo de caixa novo) e mostra o menor caixa projetado em 13 semanas; sem dado → null.
 *  - Combinações somam as faixas (pior com pior, melhor com melhor) e NÃO modelam interação entre investimentos (canibalização, mesma equipe, mesmo cliente) — dito nos avisos.
 *  - Dominância é só lógica: A domina B quando custa ≤, rende ≥ nos dois extremos, começa ≤, tem risco ≤ e é tão reversível quanto B (com ao menos uma vantagem estrita). Informação, não ordem.
 *  - Confiança só `baixa`/`media`: nunca "alta" — os retornos são declarados, o piloto não validou o motor de caixa.
 *  - Read-only e stateless: não grava, não cria ação/tarefa/pedido/mensagem.
 */
export const MAX_OPTIONS = 8;
export const MIN_OPTIONS = 2;
export const MAX_BUNDLES = 40;
const BASES = ["fact", "estimate", "hypothesis"] as const;
const RISKS = ["low", "medium", "high"] as const;
const RISK_RANK: Record<string, number> = { low: 0, medium: 1, high: 2 };
const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
const bad = (code: string, message: string) => Object.assign(new Error(message), { code });
const clean = (v: unknown, max: number): string | null => { const s = String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max); return s || null; };
const finite = (v: unknown): number | null => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

interface Option { label: string; amount: number; low: number; high: number; startInMonths: number; horizonMonths: number; basis: string; source: string; risk: string; reversible: boolean }

function normalize(raw: any, i: number): Option {
  const where = `Opção ${i + 1}`;
  const label = clean(raw?.label, 80);
  if (!label || label.length < 3) throw bad("invalid_label", `${where}: dê um nome (mínimo 3 letras).`);
  const amount = finite(raw?.amount);
  if (amount == null || amount <= 0) throw bad("invalid_amount", `${where} (${label}): o valor do investimento deve ser maior que zero.`);
  const low = finite(raw?.expectedMonthlyReturn?.low), high = finite(raw?.expectedMonthlyReturn?.high);
  if (low == null || high == null) throw bad("missing_return", `${where} (${label}): informe o retorno mensal esperado em faixa (pior e melhor caso). O sistema não estima isso por você.`);
  if (low > high) throw bad("invalid_return", `${where} (${label}): o pior caso não pode ser maior que o melhor caso.`);
  const startInMonths = raw?.startInMonths === undefined ? 0 : finite(raw.startInMonths);
  if (startInMonths == null || !Number.isInteger(startInMonths) || startInMonths < 0 || startInMonths > 24) throw bad("invalid_start", `${where} (${label}): início do retorno deve ser 0 a 24 meses.`);
  const horizonMonths = raw?.horizonMonths === undefined ? 12 : finite(raw.horizonMonths);
  if (horizonMonths == null || !Number.isInteger(horizonMonths) || horizonMonths < 1 || horizonMonths > 60) throw bad("invalid_horizon", `${where} (${label}): horizonte deve ser 1 a 60 meses.`);
  if (!(BASES as readonly string[]).includes(String(raw?.basis))) throw bad("missing_basis", `${where} (${label}): diga se o retorno é fact, estimate ou hypothesis.`);
  const source = clean(raw?.source, 200);
  if (!source || source.length < 3) throw bad("missing_source", `${where} (${label}): diga de onde vem o número do retorno (ex.: "média das últimas 3 coleções").`);
  if (!(RISKS as readonly string[]).includes(String(raw?.risk))) throw bad("missing_risk", `${where} (${label}): informe o risco (low, medium ou high).`);
  if (typeof raw?.reversible !== "boolean") throw bad("missing_reversible", `${where} (${label}): diga se é reversível (true/false).`);
  return { label, amount: round2(amount), low: round2(low), high: round2(high), startInMonths, horizonMonths, basis: String(raw.basis), source, risk: String(raw.risk), reversible: raw.reversible };
}

const leaders = (items: Array<{ label: string; v: number | null }>, dir: "max" | "min"): string[] => {
  const ok = items.filter((x) => x.v != null) as Array<{ label: string; v: number }>;
  if (!ok.length) return [];
  const best = dir === "max" ? Math.max(...ok.map((x) => x.v)) : Math.min(...ok.map((x) => x.v));
  return ok.filter((x) => x.v === best).map((x) => x.label);
};

export class CapitalAllocationService {
  static compare(orgId: string, input: any) {
    const rawOptions = input?.options;
    if (!Array.isArray(rawOptions) || rawOptions.length < MIN_OPTIONS) throw bad("too_few_options", `Compare pelo menos ${MIN_OPTIONS} alternativas.`);
    if (rawOptions.length > MAX_OPTIONS) throw bad("too_many_options", `No máximo ${MAX_OPTIONS} alternativas por comparação.`);
    const options = rawOptions.map(normalize);
    const labels = options.map((o) => o.label.toLowerCase());
    if (new Set(labels).size !== labels.length) throw bad("duplicate_label", "Duas alternativas têm o mesmo nome — use nomes diferentes.");
    let capital: number | null = null;
    if (input?.capitalAvailable !== undefined && input.capitalAvailable !== null && input.capitalAvailable !== "") {
      capital = finite(input.capitalAvailable);
      if (capital == null || capital <= 0) throw bad("invalid_capital", "O capital disponível deve ser maior que zero.");
      capital = round2(capital);
    }

    const rows = options.map((o) => {
      const returnMonths = Math.max(0, o.horizonMonths - o.startInMonths);
      const netLow = round2(o.low * returnMonths - o.amount), netHigh = round2(o.high * returnMonths - o.amount);
      const payback = {
        bestMonths: o.high > 0 ? Math.ceil(o.startInMonths + o.amount / o.high) : null,
        worstMonths: o.low > 0 ? Math.ceil(o.startInMonths + o.amount / o.low) : null,
      };
      const paysBackInHorizon = payback.worstMonths != null ? payback.worstMonths <= o.horizonMonths : (payback.bestMonths != null && payback.bestMonths <= o.horizonMonths ? "only_in_best_case" : false);
      let cash: any = { minCash: null as Range | null, confidence: null as string | null, note: "" };
      try {
        const sc = ScenarioEngine.run(orgId, "purchase", { amount: o.amount, payInWeeks: 0 });
        const m = sc.ok ? (sc.metrics || []).find((x) => x.key === "min_cash_with_purchase") : null;
        cash = m ? { minCash: m.range, confidence: sc.confidence?.level ?? null, note: "Menor caixa projetado em 13 semanas se o valor sair do caixa agora." } : { minCash: null, confidence: null, note: sc.ok ? "Sem dado de caixa para projetar." : (sc.message || "Não foi possível projetar o caixa.") };
      } catch { cash = { minCash: null, confidence: null, note: "Não foi possível projetar o caixa." }; }
      const reasons: string[] = [];
      if (o.basis !== "fact") reasons.push(`Retorno declarado como ${o.basis === "estimate" ? "estimativa" : "hipótese"} — não é dado medido.`);
      reasons.push("Faixa de retorno informada pelo dono; o sistema não a verificou.");
      return {
        label: o.label, amount: o.amount, fitsCapital: capital == null ? null : o.amount <= capital,
        expectedMonthlyReturn: toRange([o.low, o.high], "BRL"), startInMonths: o.startInMonths, horizonMonths: o.horizonMonths, returnMonths,
        net: toRange([netLow, netHigh], "BRL"), netLow, netHigh,
        roiPct: { low: Math.round((netLow / o.amount) * 100), high: Math.round((netHigh / o.amount) * 100) },
        payback: { ...payback, paysBackInHorizon, note: payback.worstMonths == null ? "No pior caso o retorno não é positivo: pode não se pagar." : null },
        cash, risk: o.risk, reversible: o.reversible,
        declared: { basis: o.basis, source: o.source },
        confidence: { level: o.basis === "fact" ? "media" : "baixa", reasons },
      };
    });

    const byCriterion = {
      smallestOutlay: leaders(rows.map((r) => ({ label: r.label, v: r.amount })), "min"),
      highestUpside: leaders(rows.map((r) => ({ label: r.label, v: r.netHigh })), "max"),
      bestWorstCase: leaders(rows.map((r) => ({ label: r.label, v: r.netLow })), "max"),
      fastestBestCasePayback: leaders(rows.map((r) => ({ label: r.label, v: r.payback.bestMonths })), "min"),
      lowestRisk: leaders(rows.map((r) => ({ label: r.label, v: RISK_RANK[r.risk] })), "min"),
      reversible: rows.filter((r) => r.reversible).map((r) => r.label),
    };

    const dominations: Array<{ dominant: string; dominated: string; reason: string }> = [];
    for (const a of options) for (const b of options) {
      if (a === b) continue;
      const noWorse = a.amount <= b.amount && a.low >= b.low && a.high >= b.high && a.startInMonths <= b.startInMonths && a.horizonMonths === b.horizonMonths && RISK_RANK[a.risk] <= RISK_RANK[b.risk] && (a.reversible || !b.reversible);
      const better = a.amount < b.amount || a.low > b.low || a.high > b.high || a.startInMonths < b.startInMonths || RISK_RANK[a.risk] < RISK_RANK[b.risk] || (a.reversible && !b.reversible);
      if (noWorse && better) dominations.push({ dominant: a.label, dominated: b.label, reason: `"${a.label}" custa o mesmo ou menos, rende o mesmo ou mais nos dois extremos, começa antes ou junto, e não é mais arriscada nem menos reversível.` });
    }

    let bundles: any[] | null = null, bundlesTruncated = false;
    if (capital != null) {
      bundles = [];
      const n = options.length;
      for (let mask = 1; mask < (1 << n); mask++) {
        const pick = options.map((o, i) => ((mask >> i) & 1 ? { o, r: rows[i] } : null)).filter(Boolean) as Array<{ o: Option; r: typeof rows[number] }>;
        const total = round2(pick.reduce((a, p) => a + p.o.amount, 0));
        if (total > capital) continue;
        if (bundles.length >= MAX_BUNDLES) { bundlesTruncated = true; break; }
        const nl = round2(pick.reduce((a, p) => a + p.r.netLow, 0)), nh = round2(pick.reduce((a, p) => a + p.r.netHigh, 0));
        const horizons = new Set(pick.map((p) => p.o.horizonMonths));
        bundles.push({ options: pick.map((p) => p.o.label), totalAmount: total, leftover: round2(capital - total), net: toRange([nl, nh], "BRL"), sameHorizon: horizons.size === 1, maxRisk: pick.reduce((m, p) => (RISK_RANK[p.o.risk] > RISK_RANK[m] ? p.o.risk : m), "low"), allReversible: pick.every((p) => p.o.reversible) });
      }
    }

    const caveats = [
      "Comparação de alternativas, não recomendação: o sistema não escolhe e não ordena. A decisão é sua — depois registre-a em /strategic/decisions para confrontar com o resultado real.",
      "Os retornos são os que VOCÊ informou (com origem e firmeza declaradas). O sistema só faz a conta; se o número de entrada estiver otimista, o resultado também estará.",
      "O caixa mostra só o efeito do desembolso nas próximas 13 semanas; não considera o retorno de cada opção chegando.",
      "Combinações somam pior com pior e melhor com melhor e NÃO modelam interação entre as opções (canibalização, mesma equipe, mesmo cliente).",
      "Confiança nunca é alta: retornos declarados e motor de caixa ainda não validados em uso real.",
    ];
    if (options.some((o) => o.horizonMonths !== options[0].horizonMonths)) caveats.push("As opções têm horizontes diferentes — o resultado líquido não é diretamente comparável entre elas.");
    if (capital == null) caveats.push("Sem capital disponível informado, não há combinações a mostrar.");

    return {
      type: "capital_comparison" as const, isForecast: false, executes: false, decisionOwner: "human" as const,
      statement: "Se os retornos que você informou ocorrerem, estes são os resultados de cada alternativa. Não é previsão nem recomendação.",
      capitalAvailable: capital, options: rows, byCriterion, dominations, bundles, bundlesTruncated,
      bundlesNote: bundles ? "As combinações estão em ordem de cadastro, não de preferência." : null, caveats,
    };
  }
}
export default CapitalAllocationService;
