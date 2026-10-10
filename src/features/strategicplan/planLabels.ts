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

/** Linhas do plano (como o servidor devolve) → corpo da revisão: troca SÓ a meta de faturamento e preserva orçamento e eventos do dono. */
export function withRevenueTarget(lines: any[] | null | undefined, amount: number): any[] {
  const keep = (Array.isArray(lines) ? lines : [])
    .filter((l) => l?.kind !== "revenue_target")
    .map((l) => ({ kind: l.kind, label: l.label, category: l.category ?? undefined, amount: l.amount ?? undefined, eventDate: l.eventDate ?? undefined, cashImpact: l.cashImpact ?? undefined, note: l.note ?? undefined }));
  return [{ kind: "revenue_target", label: "Faturamento", amount }, ...keep];
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
