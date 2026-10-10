/**
 * Plano do mês (ADR-205 F4.12) — funções PURAS, sem React nem rede. O plano é a INTENÇÃO do dono (F4.4): a tela só grava o que ele digitou e mostra
 * o que o servidor derivou; nada aqui calcula previsão, sugere meta ou conclui. Dado ausente vira "—"/frase honesta (null ≠ 0).
 */
import { brlOrDash, pctOrDash, paceLabel } from "../boardreview/boardReviewLabels";

/** "AAAA-MM" do mês corrente em São Paulo (o servidor também fecha o mês em SP) — não depende do fuso do navegador. */
export function currentMonthKeySP(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(now).slice(0, 7);
}

/** Valor digitado em reais → número > 0, ou null (nunca chuta). Aceita "150000", "150.000", "150.000,50", "150000,5", "R$ 150.000". */
export function parseMoneyInput(raw: unknown): number | null {
  let s = String(raw ?? "").replace(/R\$/gi, "").replace(/\s/g, "");
  if (!s || /[^0-9.,]/.test(s)) return null;
  if (s.includes(",")) s = s.replace(/\./g, "").replace(",", ".");
  else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, "");
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}

/** Linha como o servidor devolve → corpo de uma revisão (a revisão SUBSTITUI todas as linhas, então tudo que o dono já cadastrou tem que voltar junto). */
const toInput = (l: any) => ({ kind: l.kind, label: l.label, category: l.category ?? undefined, amount: l.amount ?? undefined, eventDate: l.eventDate ?? undefined, cashImpact: l.cashImpact ?? undefined, note: l.note ?? undefined });
const asLines = (lines: any[] | null | undefined): any[] => (Array.isArray(lines) ? lines : []);

/** Linhas do plano (como o servidor devolve) → corpo da revisão: troca SÓ a meta de faturamento e preserva orçamento e eventos do dono. */
export function withRevenueTarget(lines: any[] | null | undefined, amount: number): any[] {
  const keep = asLines(lines).filter((l) => l?.kind !== "revenue_target").map(toInput);
  return [{ kind: "revenue_target", label: "Faturamento", amount }, ...keep];
}

/** Categorias de orçamento aceitas pelo servidor (mesma lista de `BUDGET_CATEGORIES`), com o nome que o dono lê. */
export const BUDGET_CATEGORY_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "compras", label: "Compras" }, { value: "marketing", label: "Marketing" }, { value: "pessoal", label: "Pessoal" },
  { value: "estoque", label: "Estoque" }, { value: "aluguel", label: "Aluguel" }, { value: "outros", label: "Outros" },
];
export const budgetCategoryLabel = (c: string | null | undefined): string => BUDGET_CATEGORY_OPTIONS.find((o) => o.value === c)?.label ?? String(c ?? "");

/** Define o orçamento de UMA categoria: se já existe, troca o valor (duas linhas da mesma categoria contariam o gasto lançado em dobro). Preserva o resto. */
export function withBudget(lines: any[] | null | undefined, category: string, amount: number): any[] {
  const keep = asLines(lines).filter((l) => !(l?.kind === "budget" && l.category === category)).map(toInput);
  return [...keep, { kind: "budget", label: budgetCategoryLabel(category), category, amount }];
}
export function withoutBudget(lines: any[] | null | undefined, category: string): any[] {
  return asLines(lines).filter((l) => !(l?.kind === "budget" && l.category === category)).map(toInput);
}

/** Evento do calendário (mesmo nome + mesma data = o mesmo evento: troca em vez de duplicar). `cashImpact` null = o dono não declarou. */
export function withEvent(lines: any[] | null | undefined, ev: { label: string; eventDate: string; cashImpact: number | null }): any[] {
  const keep = asLines(lines).filter((l) => !(l?.kind === "event" && l.label === ev.label && l.eventDate === ev.eventDate)).map(toInput);
  return [...keep, { kind: "event", label: ev.label, eventDate: ev.eventDate, ...(ev.cashImpact != null ? { cashImpact: ev.cashImpact } : {}) }];
}
export function withoutEvent(lines: any[] | null | undefined, label: string, eventDate: string): any[] {
  return asLines(lines).filter((l) => !(l?.kind === "event" && l.label === label && l.eventDate === eventDate)).map(toInput);
}

/** Impacto de caixa DECLARADO pelo dono: "entra" (+), "sai" (−) ou não informar (null). Valor inválido → ok:false (nunca vira 0). */
export function parseCashImpact(direction: string, raw: unknown): { ok: true; value: number | null } | { ok: false } {
  if (direction !== "in" && direction !== "out") return { ok: true, value: null };
  const n = parseMoneyInput(raw);
  return n == null ? { ok: false } : { ok: true, value: direction === "out" ? -n : n };
}

/** Valida o evento antes de enviar (o servidor valida de novo): nome ≥ 3 letras e data dentro do período do plano. Devolve a mensagem ou null. */
export function eventError(label: string, eventDate: string, from: string, to: string): string | null {
  if (String(label || "").trim().length < 3) return "Dê um nome ao evento (mínimo 3 letras).";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(eventDate || ""))) return "Escolha a data do evento.";
  if (eventDate < from || eventDate > to) return `A data deve estar dentro do período do plano (${from.split("-").reverse().join("/")} a ${to.split("-").reverse().join("/")}).`;
  return null;
}

export function budgetItemsOf(plan: any): Array<{ category: string; label: string; amount: number }> {
  return asLines(plan?.lines).filter((l) => l?.kind === "budget").map((l) => ({ category: l.category, label: budgetCategoryLabel(l.category), amount: Number(l.amount) || 0 }));
}
export function eventItemsOf(plan: any): Array<{ label: string; eventDate: string; cashImpact: number | null }> {
  return asLines(plan?.lines).filter((l) => l?.kind === "event").map((l) => ({ label: l.label, eventDate: l.eventDate, cashImpact: l.cashImpact ?? null }))
    .sort((a, b) => String(a.eventDate).localeCompare(String(b.eventDate)));
}

export function revenueTargetOf(plan: any): number | null {
  const t = (Array.isArray(plan?.lines) ? plan.lines : []).filter((l: any) => l?.kind === "revenue_target");
  return t.length ? t.reduce((a: number, l: any) => a + (Number(l.amount) || 0), 0) : null;
}

export function revenueLine(track: any): string | null {
  const r = track?.revenue;
  if (!r || r.target == null) return null;
  if (r.actual == null) return `Meta de ${brlOrDash(r.target)}. Ainda sem fechamento de loja no período — não dá para dizer quanto foi realizado.`;
  const pace = paceLabel(r.paceStatus);
  return `${brlOrDash(r.actual)} de ${brlOrDash(r.target)} (${pctOrDash(r.progressPct)} da meta, com ${pctOrDash(r.elapsedPct)} do período)${pace ? ` — ${pace}` : ""}.`;
}

export function previousLine(track: any): string | null {
  const r = track?.revenue;
  if (!r?.previousPeriod || r.previousPeriod.actual == null) return null;
  return `Período anterior: ${brlOrDash(r.previousPeriod.actual)}${r.targetVsPreviousPct != null ? ` (a meta é ${pctOrDash(Math.abs(r.targetVsPreviousPct), 1)} ${r.targetVsPreviousPct >= 0 ? "acima" : "abaixo"})` : ""}.`;
}

export function budgetLines(track: any): string[] {
  return (Array.isArray(track?.budgets) ? track.budgets : []).map((b: any) => {
    if (b.committed == null) return `${b.label}: orçamento de ${brlOrDash(b.planned)} — contas a pagar não lançadas, não dá para acompanhar.`;
    return `${b.label}: ${brlOrDash(b.committed)} lançados de ${brlOrDash(b.planned)}${b.overBudget ? " — acima do orçamento" : ""}.`;
  });
}

export function eventLines(track: any): string[] {
  return (Array.isArray(track?.calendar?.events) ? track.calendar.events : []).map((e: any) => {
    const when = e.passed ? "já passou" : e.daysUntil === 0 ? "hoje" : `em ${e.daysUntil} dia${e.daysUntil === 1 ? "" : "s"}`;
    return `${e.label} — ${String(e.eventDate).split("-").reverse().join("/")} (${when})${e.cashImpact != null ? ` · caixa declarado ${brlOrDash(e.cashImpact)}` : ""}`;
  });
}
