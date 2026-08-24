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
import { MissionService } from "./MissionService.js";

function greetFor(hourSP: number): string {
  if (hourSP < 12) return "Bom dia";
  if (hourSP < 18) return "Boa tarde";
  return "Boa noite";
}

export interface MissionHomeItem { id: string; title: string; status: string; humanStatus: string }
export interface MissionHomeBlock { inFlight: number; needsYou: number; atRisk: number; achievedRecently: number; line: string; items: MissionHomeItem[] }

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
    // ── ADR-189 F7 (Mission OS) — bloco "Hoje" das missões, por EXCEÇÃO. null se a flag off (0-regressão) ──
    missions: MissionHomeBlock | null;
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
      missions: this.missionsBlock(orgId),
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

  /**
   * ADR-189 F7 — bloco "Hoje" das missões, por EXCEÇÃO (§20/§22). null quando o Mission Layer está
   * off (0-regressão). Compõe: em andamento / precisa de você (aprovação pendente) / em risco
   * (sinal mission/at_risk aberto — derivado, RN-004) / concluídas na semana. `items` traz só as de
   * EXCEÇÃO (aguardando você + em risco), até 3 — nunca um dashboard.
   */
  static missionsBlock(orgId: string): MissionHomeBlock | null {
    if (!MissionService.isEnabled(orgId)) return null;
    const byStatus = db.prepare(`SELECT mission_status s, COUNT(*) n FROM missions WHERE organization_id = ? GROUP BY mission_status`).all(orgId) as any[];
    const count = (s: string) => Number(byStatus.find((r) => r.s === s)?.n || 0);
    const inFlight = count("running") + count("waiting_approval");
    const needsYou = count("waiting_approval");
    const achievedRecently = Number((db.prepare(`SELECT COUNT(*) n FROM missions WHERE organization_id = ? AND mission_status = 'achieved' AND datetime(updated_at) >= datetime('now','-7 day')`).get(orgId) as any).n);
    const atRisk = Number((db.prepare(`SELECT COUNT(*) n FROM business_signals WHERE organization_id = ? AND domain = 'mission' AND signal_type = 'at_risk' AND status = 'open'`).get(orgId) as any).n);

    // Exceção primeiro: aguardando você + em risco (por sinal). Até 3.
    const atRiskIds = (db.prepare(`SELECT DISTINCT json_extract(evidence_json,'$.missionId') mid FROM business_signals WHERE organization_id = ? AND domain='mission' AND signal_type='at_risk' AND status='open'`).all(orgId) as any[]).map((r) => r.mid).filter(Boolean);
    const items: MissionHomeItem[] = [];
    for (const m of MissionService.list(orgId, { status: "waiting_approval" })) { if (items.length < 3) items.push({ id: m.id, title: m.title, status: m.status, humanStatus: m.humanStatus }); }
    for (const id of atRiskIds) { if (items.length >= 3) break; if (items.some((i) => i.id === id)) continue; const m = MissionService.get(orgId, id); if (m) items.push({ id: m.id, title: m.title, status: "at_risk", humanStatus: "⚠️ Em risco" }); }

    const line = needsYou > 0 ? `${needsYou} ${needsYou > 1 ? "missões aguardando" : "missão aguardando"} você`
      : atRisk > 0 ? `${atRisk} ${atRisk > 1 ? "missões em risco" : "missão em risco"}`
      : inFlight > 0 ? `${inFlight} ${inFlight > 1 ? "missões em andamento" : "missão em andamento"}`
      : "Nenhuma missão ativa.";

    return { inFlight, needsYou, atRisk, achievedRecently, line, items };
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
