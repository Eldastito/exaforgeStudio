import { PeriodicBriefingService } from "./PeriodicBriefingService.js";
import { StrategicPlanService, periodRange } from "./StrategicPlanService.js";
import { StrategicDecisionService } from "./StrategicDecisionService.js";
import { StoreBenchmarkService } from "./StoreBenchmarkService.js";
import { SupplierIntelligenceService } from "./SupplierIntelligenceService.js";
import { ExternalDecisionContextService } from "./ExternalDecisionContextService.js";
import { ContextProjectionService } from "./ContextProjectionService.js";
import { PILOT_VALIDATED } from "./ScenarioEngine.js";
import { todaySP } from "./spDate.js";

/**
 * BoardReviewService — ADR-205 F4.10 (Board Review mensal / QBR trimestral).
 *
 * COMPOSIÇÃO read-only de uma pauta executiva sobre o que já existe: briefing mensal (F3.10) + plano × realizado (F4.4) + decisões
 * estratégicas e calibração (F4.2) + benchmark interno (F4.3) + concentração de fornecedores (F4.6) + contexto externo (F4.9).
 * NÃO recalcula nada, NÃO grava, NÃO envia, NÃO executa e NÃO cria tabela/canal/motor.
 *
 * Regras:
 *  - Cada seção traz o próprio `available` + `reason`; fonte que falha ou não tem dado vira seção indisponível — nunca preenchida (null ≠ 0).
 *  - A pauta ("pendências") só lista FATOS já medidos pelas fontes (decisão com revisão vencida, plano fora do ritmo, meta fora do ritmo,
 *    concentração alta, cobertura baixa, seção sem dado). Não conclui, não recomenda e não ranqueia causas.
 *  - Herda as lacunas do briefing (margem confiável, estoque, clientes, campanhas) e as DECLARA em `notCovered`.
 *  - O piloto NÃO rodou: `pilot.validated` espelha `PILOT_VALIDATED` e a confiança geral nunca passa de "media" nem é "alta".
 *  - Dinheiro é do gestor (§73): sem visão completa, a revisão inteira é recusada (a rota também barra).
 *  - Período: mês FECHADO anterior ou trimestre FECHADO anterior (nunca o corrente, que ainda não fechou).
 */
export type ReviewPeriod = "month" | "quarter";
export interface ReviewSection { key: string; title: string; available: boolean; reason: string | null; source: string; data: any }

const bad = (code: string, message: string) => Object.assign(new Error(message), { code });
const dayAfter = (d: string) => { const t = new Date(`${d}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + 1); return t.toISOString().slice(0, 10); }; // track só considera "encerrado" no dia seguinte ao fim
const pad = (n: number) => String(n).padStart(2, "0");

/** Período FECHADO mais recente em relação a `today`: mês → mês anterior; trimestre → trimestre anterior. */
export function closedPeriod(period: ReviewPeriod, today: string): { key: string; from: string; to: string } {
  const y = +today.slice(0, 4), m = +today.slice(5, 7);
  if (period === "month") { const py = m === 1 ? y - 1 : y, pm = m === 1 ? 12 : m - 1; const key = `${py}-${pad(pm)}`; return { key, ...periodRange("month", key)! }; }
  const q = Math.ceil(m / 3), py = q === 1 ? y - 1 : y, pq = q === 1 ? 4 : q - 1; const key = `${py}-Q${pq}`;
  return { key, ...periodRange("quarter", key)! };
}

export class BoardReviewService {
  static review(orgId: string, user: any, opts: { period?: ReviewPeriod | string; now?: Date } = {}) {
    if (!ContextProjectionService.hasFullBusinessVisibility(orgId, user)) throw bad("forbidden", "O Board Review mostra números do negócio — é do gestor.");
    const period = (opts.period ?? "month") as string;
    if (period !== "month" && period !== "quarter") throw bad("invalid_period", "Período inválido (month ou quarter).");
    const now = opts.now || new Date();
    const range = closedPeriod(period, todaySP(now));
    const lastMonth = range.to.slice(0, 7);
    const sections: ReviewSection[] = [];
    const sec = (key: string, title: string, source: string, f: () => { reason?: string | null; data?: any } | null) => {
      try {
        const r = f();
        if (!r || r.reason) sections.push({ key, title, available: false, reason: r?.reason || "sem dado pra concluir", source, data: null });
        else sections.push({ key, title, available: true, reason: null, source, data: r.data });
      } catch (e: any) { sections.push({ key, title, available: false, reason: e?.message ? String(e.message).slice(0, 160) : "fonte indisponível", source, data: null }); }
    };

    // Briefing é sempre do mês FECHADO anterior ao "agora" (é o que o serviço sabe compor); no QBR ele cobre só o último mês do trimestre.
    let briefing: any = null;
    sec("resultado", "Resultado e metas", "PeriodicBriefingService (F3.10)", () => {
      briefing = PeriodicBriefingService.compose(orgId, user, { period: "month", now });
      const avail = briefing.sections.filter((s: any) => s.available && !s.restricted);
      if (!avail.length) return { reason: "sem fechamentos, metas ou ações medidas no período", data: null };
      return { data: { asOf: briefing.asOf, periodKey: briefing.periodKey, coversOnly: period === "quarter" ? "último mês fechado (o briefing é mensal)" : "mês fechado", sections: avail.map((s: any) => ({ key: s.key, title: s.title, lines: s.lines })), unavailable: briefing.sections.filter((s: any) => !s.available && !s.restricted).map((s: any) => ({ key: s.key, reason: s.reason })) } };
    });

    let planTrack: any = null;
    sec("plano", "Plano × realizado", "StrategicPlanService (F4.4)", () => {
      const p = StrategicPlanService.list(orgId, { periodType: period }).find((x: any) => x.periodKey === range.key && x.status !== "draft");
      if (!p) return { reason: `não há plano ${period === "month" ? "mensal" : "trimestral"} ativo ou encerrado para ${range.key}` };
      planTrack = StrategicPlanService.track(orgId, p.id, { asOf: dayAfter(range.to) });
      return { data: { planId: p.id, periodKey: range.key, title: p.title, version: p.version, status: p.status, track: planTrack } };
    });

    let due: any[] = [];
    sec("decisoes", "Decisões estratégicas", "StrategicDecisionService (F4.2)", () => {
      due = StrategicDecisionService.due(orgId, todaySP(now));
      const calibration = StrategicDecisionService.calibration(orgId);
      const decided = StrategicDecisionService.list(orgId, { status: "decided" });
      if (!decided.length && !due.length) return { reason: "nenhuma decisão estratégica registrada" };
      return { data: { decidedCount: decided.length, reviewsDue: due.map((d: any) => ({ id: d.id, title: d.title, category: d.category, reviewOn: d.reviewOn ?? null })), calibration } };
    });

    let bench: any = null;
    sec("lojas", "Benchmark interno das lojas", "StoreBenchmarkService (F4.3)", () => {
      bench = StoreBenchmarkService.benchmark(orgId, { period: lastMonth });
      const ranked = bench.metrics.filter((m: any) => m.ranked);
      if (!ranked.length) return { reason: `sem comparação possível em ${lastMonth} (amostra mínima de lojas ou dados de m²/equipe/custo faltando)` };
      return { data: { period: bench.period, coversOnly: period === "quarter" ? "último mês do trimestre" : "mês fechado", metrics: ranked.map((m: any) => ({ key: m.key, label: m.label, median: m.median, confidence: m.confidence, questions: m.questions })), caveats: bench.caveats } };
    });

    let conc: any = null;
    sec("fornecedores", "Fornecedores", "SupplierIntelligenceService (F4.6)", () => {
      conc = SupplierIntelligenceService.concentration(orgId, { from: range.from, to: range.to });
      if (conc.totalSpend == null) return { reason: "nenhuma ordem de compra com valor no período" };
      return { data: { from: conc.from, to: conc.to, totalSpend: conc.totalSpend, topSharePct: conc.topSharePct, hhi: conc.hhi, band: conc.band, coverage: conc.coverage, caveats: conc.caveats } };
    });

    sec("externo", "Contexto de mercado", "ExternalDecisionContextService (F4.9)", () => {
      const ctx: any = ExternalDecisionContextService.forDecision(orgId, { kind: "plan" });
      if (!ctx.items?.some((i: any) => i.available)) return { reason: "sem contexto de mercado publicado/válido para o nicho" };
      return { data: { items: ctx.items.filter((i: any) => i.available), questions: ctx.questions, confidence: ctx.confidence, affectsCalculations: false } };
    });

    // Pauta: só FATOS vindos das fontes acima.
    const agenda: Array<{ kind: string; text: string; source: string }> = [];
    for (const d of due) agenda.push({ kind: "decision_review_due", text: `Revisão vencida: ${d.title}${d.reviewOn ? ` (era pra ${d.reviewOn})` : ""}.`, source: "decisoes" });
    const rev = planTrack?.revenue;
    if (rev?.paceStatus === "missed") agenda.push({ kind: "plan_missed", text: `Meta de faturamento do plano ${range.key} não foi atingida (${rev.progressPct}% da meta).`, source: "plano" });
    else if (rev?.paceStatus === "behind") agenda.push({ kind: "plan_behind", text: `Faturamento do plano ${range.key} abaixo do ritmo (${rev.progressPct}% da meta com ${rev.elapsedPct}% do período).`, source: "plano" });
    if (briefing?.summary?.goalsBehind > 0) agenda.push({ kind: "goals_behind", text: `${briefing.summary.goalsBehind} meta(s) fora do ritmo.`, source: "resultado" });
    if (briefing?.summary?.storesBelow > 0) agenda.push({ kind: "stores_below", text: `${briefing.summary.storesBelow} loja(s) abaixo da meta no último dia fechado.`, source: "resultado" });
    if (conc && (conc.band === "high" || conc.band === "single_supplier")) agenda.push({ kind: "supplier_concentration", text: conc.band === "single_supplier" ? "Um único fornecedor concentra as compras do período." : `Maior fornecedor concentra ${conc.topSharePct}% das compras.`, source: "fornecedores" });
    if (conc?.coverage?.orderCoveragePct != null && conc.coverage.orderCoveragePct < 70) agenda.push({ kind: "purchase_coverage_low", text: `Só ${conc.coverage.orderCoveragePct}% das compras lançadas passam por ordem — a leitura de fornecedores é parcial.`, source: "fornecedores" });
    for (const s of sections.filter((x) => !x.available)) agenda.push({ kind: "section_unavailable", text: `${s.title}: ${s.reason}.`, source: s.key });

    return {
      type: "board_review" as const, period, periodKey: range.key, from: range.from, to: range.to, isForecast: false, executes: false, sends: false,
      sections, agenda,
      pilot: { validated: PILOT_VALIDATED, statement: PILOT_VALIDATED ? "Limiares e dados conferidos em uso real." : "O piloto na loja ainda NÃO rodou: limiares e dados não foram conferidos em uso real. Leia como pauta de perguntas, não como veredito." },
      confidence: { level: "baixa" as const, reasons: [`${sections.filter((s) => s.available).length} de ${sections.length} seção(ões) com dado.`, ...(PILOT_VALIDATED ? [] : ["Piloto não validado (ADR-204 §28)."])] },
      notCovered: [...(briefing?.notCovered || [{ topic: "margem confiável" }, { topic: "estoque" }, { topic: "clientes e campanhas" }]), { topic: "benchmark entre empresas", reason: "exigiria amostra mínima e anonimização entre empresas, fora desta etapa" }],
      caveats: [
        "A pauta lista fatos medidos pelas fontes; não conclui causa nem recomenda ação.",
        "Nada é executado nem enviado a ninguém: decisões seguem humanas e registradas em /strategic/decisions.",
        ...(period === "quarter" ? ["O briefing de resultado é mensal: no trimestre ele cobre só o último mês fechado."] : []),
      ],
      generatedAt: now.toISOString(),
    };
  }
}
export default BoardReviewService;
