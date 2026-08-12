/**
 * FalaTuHomeService — PRD 1 Fase 9 (§zero-training): a "home" do Fala Tu. Ao
 * abrir, o usuário recebe TUDO que importa num payload só — sem precisar navegar
 * nem aprender onde cada coisa mora. É pura COMPOSIÇÃO do que já construímos
 * (nenhum motor novo, CA15):
 *   - saudação pela hora (SP);
 *   - resumo: contagem por categoria da Smart Inbox (Fase 3);
 *   - highlights: os itens de maior score que pedem ação (aprovação + risco +
 *     oportunidade), já no escopo do papel;
 *   - approvals: as aprovações pendentes acionáveis (Fase 4);
 *   - execution: o que está rodando agora (Fase 6);
 *   - proactiveEnabled: se a org opta por ser avisada primeiro (Fase 8).
 * Tudo herda o escopo por papel — a home de um vendedor não vaza finanças.
 *
 * ADR-163 / PRD 6 F3 (§11-§13) — o "Hoje" por EXCEÇÃO. Campos ADITIVOS (0 regressão):
 *   - `attention`: contagens por necessidade (decisões precisam de você / riscos
 *     acompanhados / processos em execução) + `todayLine` (frase-resumo, "Nenhuma
 *     exceção crítica agora" quando vazio, §12) + `hasCriticalException`;
 *   - `resolvedSinceYesterday`: quantos casos foram resolvidos nas últimas 24h e quanto
 *     foi RECUPERADO em R$ (só pra quem tem visão completa — dinheiro é role-gated, §73);
 *   - `goals`: distância à meta (gestor apenas), reusa `BusinessGoalService.progress`;
 *   - `invisibleUxEnabled`: flag que diz ao frontend se renderiza o framing por exceção.
 * Tudo DERIVADO por query (RN-004), escopado por papel (RN-UX-2), sem Home concorrente
 * (RN-UX-1 — só ESTENDE a composição existente).
 */
import db from "./db.js";
import { SmartInboxService, InboxItem } from "./SmartInboxService.js";
import { FalaTuApprovalService } from "./FalaTuApprovalService.js";
import { FalaTuThreadService } from "./FalaTuThreadService.js";
import { FalaTuProactiveService } from "./FalaTuProactiveService.js";
import { FalaTuBriefingDigestService } from "./FalaTuBriefingDigestService.js";
import { ContextProjectionService } from "./ContextProjectionService.js";
import { BusinessGoalService } from "./BusinessGoalService.js";

function greetFor(hourSP: number): string {
  if (hourSP < 12) return "Bom dia";
  if (hourSP < 18) return "Boa tarde";
  return "Boa noite";
}

export class FalaTuHomeService {
  static home(orgId: string, user: any, opts: { now?: Date } = {}): {
    greeting: string;
    summary: Record<string, number>;
    highlights: InboxItem[];
    approvals: { total: number; items: any[] };
    execution: { total: number; byType: Array<{ type: string; count: number }> };
    proactiveEnabled: boolean;
    // ── PRD 6 F3 (aditivos) ──
    attention: { decisionsNeedingYou: number; risksWatched: number; processesExecuting: number; hasCriticalException: boolean; todayLine: string };
    resolvedSinceYesterday: { count: number; valueRecovered: number | null; unit: "BRL" };
    goals: { total: number; offTrack: number; items: Array<{ metric: string; label: string; attainmentPct: number; paceStatus: string }> } | null;
    invisibleUxEnabled: boolean;
    generatedAt: string;
  } {
    const now = opts.now || new Date();
    const { hourSP } = FalaTuBriefingDigestService.spParts(now);
    const inbox = SmartInboxService.build(orgId, user, { now: now.getTime() });

    // Highlights: o que pede ação, ranqueado por score (aprovação + risco + oportunidade).
    const highlights = [...inbox.categories.needsApproval, ...inbox.categories.risk, ...inbox.categories.opportunity]
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);

    const approvals = FalaTuApprovalService.pending(orgId, user);
    const execution = FalaTuThreadService.executionStatus(orgId, user);

    // ── "Hoje" por exceção (§11-§12) — tudo já role-scoped pela Smart Inbox ──
    const c = inbox.counts;
    const decisionsNeedingYou = (c.needsApproval || 0) + (c.needsDecision || 0);
    const risksWatched = c.risk || 0;
    const processesExecuting = c.inExecution || 0;
    const hasCriticalException = decisionsNeedingYou > 0 || inbox.categories.risk.some((i) => i.severity === "critical");
    const parts: string[] = [];
    if (decisionsNeedingYou > 0) parts.push(`${decisionsNeedingYou} ${decisionsNeedingYou > 1 ? "decisões precisam" : "decisão precisa"} de você`);
    if (risksWatched > 0) parts.push(`${risksWatched} ${risksWatched > 1 ? "riscos" : "risco"} sendo ${risksWatched > 1 ? "acompanhados" : "acompanhado"}`);
    if (processesExecuting > 0) parts.push(`${processesExecuting} em execução`);
    const todayLine = parts.length ? parts.join(" · ") : "Nenhuma exceção crítica agora.";

    const fullVisibility = ContextProjectionService.hasFullBusinessVisibility(orgId, user);
    const resolvedSinceYesterday = this.resolved24h(orgId, user, fullVisibility);
    const goals = fullVisibility ? this.goalsSummary(orgId) : null;

    const inv = db.prepare(`SELECT COALESCE(invisible_ux_enabled,0) e FROM organization_settings WHERE organization_id = ?`).get(orgId) as any;

    return {
      greeting: greetFor(hourSP),
      summary: inbox.counts,
      highlights,
      approvals: { total: approvals.total, items: approvals.items.slice(0, 5) },
      execution: { total: execution.total, byType: execution.byType },
      proactiveEnabled: FalaTuProactiveService.enabled(orgId),
      attention: { decisionsNeedingYou, risksWatched, processesExecuting, hasCriticalException, todayLine },
      resolvedSinceYesterday,
      goals,
      invisibleUxEnabled: !!(inv && inv.e),
      generatedAt: new Date(now).toISOString(),
    };
  }

  /** Resolvido nas últimas 24h + valor recuperado (R$ só pra visão completa — §73). */
  private static resolved24h(orgId: string, user: any, fullVisibility: boolean): { count: number; valueRecovered: number | null; unit: "BRL" } {
    const done = db.prepare(
      `SELECT domain FROM decision_actions WHERE organization_id = ? AND status = 'done' AND completed_at IS NOT NULL AND datetime(completed_at) >= datetime('now','-1 day')`
    ).all(orgId) as any[];
    const count = done.filter((r) => ContextProjectionService.canSeeDomain(orgId, user, r.domain)).length;
    let valueRecovered: number | null = null;
    if (fullVisibility) {
      const v = db.prepare(
        `SELECT COALESCE(SUM(o.revenue_recovered), 0) v FROM action_outcomes o
           JOIN decision_actions a ON a.id = o.action_id AND a.organization_id = o.organization_id
          WHERE o.organization_id = ? AND a.status = 'done' AND datetime(o.measured_at) >= datetime('now','-1 day')`
      ).get(orgId) as any;
      valueRecovered = Math.round((Number(v?.v) || 0) * 100) / 100;
    }
    return { count, valueRecovered, unit: "BRL" };
  }

  /** Distância à meta (gestor) — reusa BusinessGoalService.progress; inerte sem metas. */
  private static goalsSummary(orgId: string): { total: number; offTrack: number; items: Array<{ metric: string; label: string; attainmentPct: number; paceStatus: string }> } {
    const p = BusinessGoalService.progress(orgId);
    return {
      total: p.goals.length,
      offTrack: p.goals.filter((g) => g.paceStatus === "behind").length,
      items: p.goals.slice(0, 3).map((g) => ({ metric: g.metric, label: g.label, attainmentPct: g.attainmentPct, paceStatus: g.paceStatus })),
    };
  }
}
