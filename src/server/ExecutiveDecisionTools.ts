/**
 * ExecutiveDecisionTools — "decision_analysis" e "panorama da operação" como FERRAMENTAS do Diretor IA (PRD Fase 1 §24 e §25).
 *
 * §24: "Estou pensando em comprar R$ 180 mil de coleção. 30% de entrada e o restante em 60 dias. Vale a pena?" → intenção
 * `decision_analysis` que usa o MOTOR EXISTENTE (`DecisionEngine.analyze` — pré-mortem/red team/advocate por nível de impacto,
 * DI-2). NÃO cria segundo motor: aqui só (1) extrai o que a pessoa disse (valor, entrada, prazo) por regra, (2) entrega isso ao
 * motor como decisão + premissas e (3) traduz o resultado pro gestor. Roda sem LLM (a borda de NL é opcional, como no roteador).
 * §25: "Como está minha operação?" → panorama que COMPÕE o que o gestor precisa sem ele saber de onde vem (lojas hoje, o que
 * precisa de atenção, exceções, aprovações, divergência de estoque) — cada pedaço vem do serviço que já o calcula.
 *
 * Honestidade (F1.0 / RN-DIR):
 *  - o motor modela o VALOR TOTAL; entrada e prazo entram como PREMISSAS declaradas e como CRONOGRAMA comparado ao caixa — e o
 *    caixa só é comparado quando é SALDO (`cashBasis==='caixa'`); com só vendas/entradas registradas diz que NÃO sabe o saldo;
 *  - cenários/"upside" do motor usam o valor da compra como base (não há retorno esperado informado) → NÃO são exibidos;
 *  - advisório: nunca executa nem cria ação (o gate segue em RBAC/ApprovalPolicy); dinheiro é role-gated (ferramenta `money`);
 *  - read-only, isola por organização.
 */
import { DecisionEngine } from "./DecisionEngine.js";
import { FinancialLedgerService } from "./FinancialLedgerService.js";
import { CashForecastService } from "./CashForecastService.js";
import { BusinessHealthService } from "./BusinessHealthService.js";
import { DecisionActionService } from "./DecisionActionService.js";
import { NegativeStockDiagnosisService } from "./NegativeStockDiagnosisService.js";
import { RetailExceptionSignalService } from "./RetailExceptionSignalService.js";
import { RetailQuestionTools } from "./RetailQuestionTools.js";
import { SellerDiagnosisService } from "./SellerDiagnosisService.js";
import { normalizeAlias } from "./RetailSellerIdentityService.js";
import db from "./db.js";

type Res = { ok: boolean; tool: string; summary?: string; data?: any; clarify?: string };

const round2 = (n: number) => Math.round(n * 100) / 100;
const brl = (v: number) => `R$ ${round2(v).toLocaleString("pt-BR", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
const norm = (s: string) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
const addDays = (d: string, k: number) => new Date(Date.parse(`${d}T12:00:00Z`) + k * 86400000).toISOString().slice(0, 10);
const ddmm = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: process.env.TZ_DISPLAY || "America/Sao_Paulo" });

export type ParsedDecision = { amount: number | null; downPct: number | null; downAmount: number | null; termDays: number | null; installments: number | null };

export class ExecutiveDecisionTools {
  /** Valores em R$ do texto ("R$ 180 mil", "54k", "1,5 milhão", "180.000") — fora % / dias / vezes. */
  private static moneyTokens(text: string): Array<{ value: number; index: number; end: number }> {
    const t = norm(text);
    const out: Array<{ value: number; index: number; end: number }> = [];
    const re = /(r\$\s*)?(\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+(?:[.,]\d+)?)\s*(milhoes|milhao|mil|mi|k)?(?![\d])/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(t))) {
      const after = t.slice(m.index + m[0].length, m.index + m[0].length + 12);
      if (/^\s*(%|por ?cento|dias?|meses|mes|x\b|vezes|parcelas?)/.test(after)) continue;       // porcentagem / prazo / nº de parcelas
      if (!m[1] && !m[3] && !/\./.test(m[2]) && Number(m[2]) < 1000) continue;                  // "30", "60" soltos não são dinheiro
      const num = Number(m[2].replace(/\./g, "").replace(",", "."));
      if (!Number.isFinite(num) || num <= 0) continue;
      const mult = m[3] === "mil" || m[3] === "k" ? 1000 : m[3] ? 1_000_000 : 1;
      out.push({ value: round2(num * mult), index: m.index, end: m.index + m[0].length });
    }
    return out;
  }

  /** Extrai valor da compra, entrada (% ou R$), prazo (dias) e nº de parcelas do que a pessoa disse. Nunca inventa o que não disse. */
  static parse(text: string): ParsedDecision {
    const t = norm(text);
    const money = this.moneyTokens(text);
    // entrada: "30% de entrada" / "entrada de 30%" / "entrada de R$ 54 mil"
    let downPct: number | null = null, downAmount: number | null = null;
    const p1 = t.match(/(\d{1,3}(?:[.,]\d+)?)\s*%\s*(?:de\s*|na\s*)?entrada/) || t.match(/entrada\s*(?:de|:)?\s*(\d{1,3}(?:[.,]\d+)?)\s*%/);
    if (p1) { const v = Number(p1[1].replace(",", ".")); if (v > 0 && v <= 100) downPct = v; }
    // O valor da entrada é o que está LIGADO à palavra: "54 mil de entrada" / "entrada de R$ 54 mil" — vírgula/ponto no meio quebra a ligação
    // (em "comprar 180k, entrada de R$ 54 mil" o 180k é a compra, não a entrada).
    const entradaAt = [...t.matchAll(/entrada/g)].map((x) => ({ s: x.index as number, e: (x.index as number) + 7 }));
    const linkedToEntrada = (tok: { index: number; end: number }) => entradaAt.some((w) =>
      (tok.end <= w.s && /^\s*(de|na|para|como|em)?\s*$/.test(t.slice(tok.end, w.s))) ||
      (tok.index >= w.e && /^\s*(de|:|=|-)?\s*(r\$)?\s*$/.test(t.slice(w.e, tok.index))));
    const downTok = downPct === null ? money.find(linkedToEntrada) : undefined;
    if (downTok) downAmount = downTok.value;
    // valor da compra: o maior valor que NÃO é a entrada
    const rest = money.filter((x) => x !== downTok);
    const amount = rest.length ? Math.max(...rest.map((x) => x.value)) : null;
    // prazo: último "N dias" / "N meses"
    let termDays: number | null = null;
    for (const m of t.matchAll(/(\d{1,3})\s*(dias?|meses|mes)\b/g)) termDays = Number(m[1]) * (/mes/.test(m[2]) ? 30 : 1);
    const inst = t.match(/(\d{1,2})\s*(?:x\b|vezes|parcelas?)/);
    return { amount, downPct, downAmount, termDays: termDays && termDays > 0 ? termDays : null, installments: inst ? Number(inst[1]) : null };
  }

  /** §24 — análise de decisão de COMPRA/INVESTIMENTO pelo motor existente. Advisória: não executa nada. */
  static analisarDecisao(orgId: string, input: { text?: string; amount?: number; downPct?: number; downAmount?: number; termDays?: number }): Res {
    const p = { ...this.parse(input.text || ""), ...Object.fromEntries(Object.entries({ amount: input.amount, downPct: input.downPct, downAmount: input.downAmount, termDays: input.termDays }).filter(([, v]) => v != null && Number(v) > 0)) } as ParsedDecision;
    if (!(p.amount && p.amount > 0)) return { ok: true, tool: "analisar_decisao", clarify: "Qual o valor da compra/investimento? (ex.: R$ 180 mil)" };
    const amount = p.amount;
    const down = p.downAmount ?? (p.downPct != null ? round2(amount * p.downPct / 100) : null);
    const remaining = down != null ? round2(Math.max(0, amount - down)) : null;
    const dueDate = p.termDays ? addDays(today(), p.termDays) : null;

    const premises: Array<{ label: string; basis: "fact" | "estimate"; confidence?: number; hasEvidence?: boolean }> = [];
    if (down != null) premises.push({ label: `entrada de ${brl(down)} no ato (condição informada por você)`, basis: "fact", hasEvidence: true });
    if (remaining != null && p.termDays) premises.push({ label: `restante de ${brl(remaining)} em ${p.termDays} dias (condição informada por você)`, basis: "fact", hasEvidence: true });
    premises.push({ label: "o giro da compra cobre o desembolso no prazo", basis: "estimate", hasEvidence: false });

    const out = DecisionEngine.analyze(orgId, { title: `Comprar ${brl(amount)} de mercadoria`, decisionType: "purchase", impactAmount: amount, impactUnit: "BRL", premises, learningDomain: "inventory" }, { mode: "auto" });

    // ── caixa: só compara quando é SALDO ──
    const sum = FinancialLedgerService.summary(orgId) as any;
    const basis = sum?.tracking?.cashBasis ?? "caixa";
    const lines: string[] = [];
    lines.push(`Análise da compra de ${brl(amount)}${down != null ? ` — entrada ${p.downPct != null ? `${p.downPct}% = ` : ""}${brl(down)} no ato` : ""}${remaining != null && p.termDays ? `; ${brl(remaining)} em ${p.termDays} dias (vence ${ddmm(dueDate!)})` : ""}.`);
    if (!down && !p.termDays) lines.push("(Você não falou entrada nem prazo — analiso o valor total.)");
    if (p.installments) lines.push(`Obs.: parcelamento em ${p.installments}x — considero só o total e as condições acima; não simulo o cronograma de cada parcela.`);
    lines.push(`Nível da decisão: ${out.levelLabel || out.level}.`);

    if (out.skipped) {
      lines.push(out.reason || "Baixo impacto — sem análise profunda.");
    } else {
      // caixa e cronograma
      if (basis === "caixa") {
        const caixa = Number(sum?.caixaAtual) || 0;
        const aPagar = Number(sum?.aPagar) || 0;
        // null ≠ zero: sem nenhuma conta a pagar cadastrada no ZapFlow, "a pagar" não é R$ 0 — é "sem registro".
        const pagarTxt = sum?.tracking?.payables === false ? "não há contas a pagar cadastradas no ZapFlow" : `a pagar em aberto: ${brl(aPagar)}`;
        lines.push(`Caixa hoje: ${brl(caixa)}${down != null ? ` (a entrada de ${brl(down)} usa ${caixa > 0 ? Math.round((down / caixa) * 100) : "—"}% dele)` : ""}; ${pagarTxt}.`);
        try {
          const fc = CashForecastService.forecast(orgId, { minCash: 0 }) as any;
          if (fc?.firstRisk) lines.push(`Pela previsão de caixa, o saldo fica negativo a partir da semana de ${ddmm(String(fc.firstRisk.weekStart))}${dueDate ? ` — o restante vence em ${ddmm(dueDate)}` : ""}.`);
          else if (fc) lines.push("A previsão de caixa não indica ruptura nas próximas semanas (sem contar esta compra).");
        } catch { /* previsão indisponível: não afirma */ }
      } else {
        lines.push(`Não tenho o saldo real do caixa: o ZapFlow só tem as vendas/entradas registradas e nenhuma saída lançada — por isso NÃO consigo dizer se o caixa suporta a entrada${down != null ? ` de ${brl(down)}` : ""}. Informe o saldo real (ou lance as saídas) que eu refaço.`);
      }
      const risks = (out.premortem?.risks || []) as any[];
      if (risks.length) lines.push("Riscos (pré-mortem):", ...risks.slice(0, 4).map((r) => `- ${r.description}${r.mitigation ? ` → ${r.mitigation}` : ""}`));
      const ch = (out.redTeam?.challenges || []) as any[];
      if (ch.length) lines.push("Premissas frágeis (red team):", ...ch.slice(0, 3).map((c) => `- ${c.premise}: ${c.issue}`));
      const rec = out.recommendation || {};
      if (rec.headline) lines.push(`Recomendação (advisória): ${rec.headline}`);
      for (const w of (rec.why || []).slice(0, 2)) if (!risks.some((r) => r.description === w)) lines.push(`- ${w}`);
      lines.push("Não projeto retorno nem cenários: você não informou o retorno esperado da coleção.");
    }
    lines.push("É uma análise de apoio — a decisão e qualquer execução continuam com você.");
    return { ok: true, tool: "analisar_decisao", data: { parsed: p, down, remaining, dueDate, cashBasis: basis, engine: { level: out.level, applied: out.applied, skipped: out.skipped, recommendation: out.recommendation || null } }, summary: lines.join("\n") };
  }

  /** §25 — "Como está minha operação?": lojas hoje + o que precisa de atenção + exceções + aprovações + divergência. Cada pedaço vem do serviço dono. */
  static panoramaOperacao(orgId: string, date: string = today()): Res {
    const parts: string[] = [];
    const data: any = {};
    try {
      const m = RetailQuestionTools.metaDoDia(orgId, date);
      if (m.summary) { parts.push(`Lojas hoje:\n${m.summary}`); data.lojas = m.data ?? null; }
    } catch { /* sem varejo: segue */ }
    const shownTypes = new Set<string>();
    try {
      const att = BusinessHealthService.attention(orgId);
      for (const i of att.items) if (i.signalType) shownTypes.add(i.signalType);
      data.atencao = att.count;
      if (att.count > 0) parts.push(`${att.count} assunto${att.count === 1 ? "" : "s"} precisa${att.count === 1 ? "" : "m"} de atenção:\n${att.items.slice(0, 5).map((i, n) => `${n + 1}. ${i.title}`).join("\n")}`);
      else parts.push("Nenhuma ação humana necessária — operação sob controle.");
    } catch { /* atenção indisponível: não afirma "sob controle" */ }
    try {
      // O que já saiu na lista de atenção (como sinal) não repete aqui; o que ainda não virou sinal (o publicador roda de hora em hora) entra.
      const ex = RetailExceptionSignalService.items(orgId, date).filter((x) => !shownTypes.has(x.type)).map((x) => x.text);
      if (ex.length) { parts.push(`Exceções: ${ex.join(" ")}`); data.excecoes = ex; }
    } catch { /* sem varejo */ }
    try {
      const pend = DecisionActionService.list(orgId, { status: "awaiting_approval" }).length;
      data.aprovacoes = pend;
      if (pend > 0) parts.push(`${pend} decisão${pend === 1 ? "" : "ões"} aguardando a sua aprovação.`);
    } catch { /* noop */ }
    try {
      const d = NegativeStockDiagnosisService.diagnose(orgId);
      if (d.total) { parts.push(`Estoque: ${d.headline}.`); data.divergenciaEstoque = d.total; }
    } catch { /* noop */ }
    if (!parts.length) return { ok: true, tool: "panorama_operacao", summary: "Não encontrei dados da operação pra resumir agora.", data };
    return { ok: true, tool: "panorama_operacao", data, summary: `Panorama da operação (${ddmm(date)}):\n\n${parts.join("\n\n")}` };
  }
}

/** PRD §18 (S5) — acha o vendedor citado na pergunta. Nome completo OU primeiro nome único; ambíguo/inexistente → clarify (nunca chuta). */
export function resolveSellerInText(orgId: string, text: string): { id?: string; clarify?: string } {
  const q = ` ${normalizeAlias(text)} `;
  const rows = (db.prepare(`SELECT id, name FROM retail_sellers WHERE organization_id = ? AND active = 1 AND merged_into_seller_id IS NULL AND name IS NOT NULL AND TRIM(name) <> ''`).all(orgId) as any[]);
  const full = rows.filter((r) => q.includes(` ${normalizeAlias(r.name)} `));
  if (full.length === 1) return { id: full[0].id };
  if (full.length > 1) return { clarify: `Encontrei mais de uma pessoa: ${full.map((r) => r.name).join(", ")}. De qual delas?` };
  const first = rows.filter((r) => { const f = normalizeAlias(r.name).split(" ")[0]; return f.length >= 3 && q.includes(` ${f} `); });
  if (first.length === 1) return { id: first[0].id };
  if (first.length > 1) return { clarify: `Há mais de uma pessoa com esse nome: ${first.map((r) => r.name).join(", ")}. Qual delas?` };
  return { clarify: "De qual vendedor? Diga o nome (ex.: \"analisar desempenho de Maria Souza\")." };
}

export function diagnosticoVendedor(orgId: string, args: { text?: string; date?: string }): Res {
  const r = resolveSellerInText(orgId, String(args?.text || ""));
  if (!r.id) return { ok: true, tool: "diagnostico_vendedor", clarify: r.clarify };
  const d = SellerDiagnosisService.diagnose(orgId, r.id, args?.date || today());
  if (!d.found) return { ok: false, tool: "diagnostico_vendedor", summary: d.error };
  if (!d.enough) return { ok: true, tool: "diagnostico_vendedor", data: d, summary: `${d.seller?.name}: ${d.reason}` };
  const lines = d.findings.map((f) => `${f.kind === "hypothesis" ? "Hipótese" : "Fato"}: ${f.text}`);
  return { ok: true, tool: "diagnostico_vendedor", data: d, summary: `Desempenho de ${d.seller?.name} (últimos 30 dias contra os 30 anteriores):\n\n${lines.join("\n")}\n\nHipótese é leitura dos números, não é causa comprovada.` };
}

export default ExecutiveDecisionTools;
