/**
 * ExecutingBoardService (ADR-203 F2.4 / PRD Fase 2 §14-§16) — a superfície "Executando": UMA fachada que
 * responde "o que está andando e o que depende de mim?" em 4 etapas — Precisa de você · Em andamento ·
 * Aguardando · Concluído — por cima de 4 telas que eram independentes (Missões, Tarefas, ações/aprovações,
 * processos). Missão = Tarefa = Ação para o usuário: o cartão é o mesmo, o tipo interno só decide o link.
 *
 * COMPÕE, não duplica (RN-F2-4): `FalaTuApprovalService.pending`, `ExecutionResultsService.executing`
 * (processos por objetivo), `MissionService.list`, tasks, `action_confirmations` e `OutcomeAssuranceService`.
 * Sem tabela nova, sem motor novo, sem flag nova (usa a nav simplificada da F2.2).
 *
 * Regras:
 *  - DONE ≠ RESULTADO (RN-OA): "concluído" só diz "resultado confirmado" quando a garantia (PRD 8) prova;
 *    senão "executado — resultado ainda não confirmado". Falha é de 1ª classe (vai pra "Precisa de você").
 *  - Executado mas esperando confirmação externa (`action_confirmations` pendente) = AGUARDANDO, não concluído.
 *  - Dinheiro role-gated (§73): o impacto só vem com visão completa; o FATO do item nunca some.
 *  - Escopo por papel: ação de domínio invisível some; tarefa de outra pessoa só para gestor; missões só gestor
 *    e só com o Mission Layer ligado (mesmo gate do módulo). Isolado por org.
 *  - Honesto: lane vazia vem vazia; cada lane traz no máximo 8 itens + `total` (o resto é contagem).
 */
import db from "./db.js";
import { FalaTuApprovalService } from "./FalaTuApprovalService.js";
import { ExecutionResultsService } from "./ExecutionResultsService.js";
import { MissionService } from "./MissionService.js";
import { OutcomeAssuranceService } from "./OutcomeAssuranceService.js";
import { ContextProjectionService } from "./ContextProjectionService.js";

export const LANE_LIMIT = 8;
const RECENT_DONE_DAYS = 7;

export type Lane = "needsYou" | "running" | "waiting" | "done";
export interface BoardItem {
  id: string;
  kind: "action" | "mission" | "task" | "objective";   // interno: só decide o link, a UI não o exibe
  title: string;
  state: string;                 // rótulo humano
  tone: string;
  detail: string | null;         // 1 linha de contexto (nunca inventada)
  at: string | null;
  impact: { amount: number | null; unit: string | null; restricted: boolean } | null;
  assurance: { state: string; label: string } | null;   // só em "Concluído"
  viewMode: string;              // para onde abrir
}
export interface ExecutingBoard {
  lanes: Record<Lane, { total: number; items: BoardItem[] }>;
  missionsAvailable: boolean;    // há seção/atalho de Missões (Mission Layer ligado + gestor)
  generatedAt: string;
}

const ASSURANCE_LABEL: Record<string, string> = {
  assured: "Resultado confirmado",
  impact_measured: "Resultado medido",
  effect_confirmed: "Efeito confirmado",
  executed: "Executado — resultado ainda não confirmado",
  planned: "Planejado",
  unknown: "Executado — sem como confirmar o resultado",
};

const asDate = (v: any): string | null => (v ? String(v) : null);

export class ExecutingBoardService {
  static build(orgId: string, user: any, opts: { now?: Date } = {}): ExecutingBoard {
    const now = opts.now || new Date();
    const role = String(user?.role || "");
    const uid = String(user?.userId || user?.id || "");
    const isManager = role === "owner" || role === "admin";
    const full = ContextProjectionService.hasFullBusinessVisibility(orgId, user);
    const money = (amount: any, unit: any) => (amount == null ? null : full ? { amount: Number(amount), unit: unit || "BRL", restricted: false } : { amount: null, unit: unit || "BRL", restricted: true });

    const lanes: Record<Lane, BoardItem[]> = { needsYou: [], running: [], waiting: [], done: [] };

    // ── Ações (decisões) ──
    const pending = new Set((db.prepare(`SELECT action_id FROM action_confirmations WHERE organization_id = ? AND status = 'pending'`).all(orgId) as any[]).map((r) => r.action_id));
    const approvals = FalaTuApprovalService.pending(orgId, user).items;
    const approvalIds = new Set<string>();
    for (const a of approvals) {
      if (!ContextProjectionService.canSeeDomain(orgId, user, a.domain)) continue;
      approvalIds.add(a.actionId);
      const base = { id: a.actionId, kind: "action" as const, title: String(a.title), at: null, impact: money(a.expectedImpact, a.impactUnit), assurance: null };
      if (a.canApprove) lanes.needsYou.push({ ...base, state: "Precisa de você", tone: "needs_you", detail: a.why || null, viewMode: "falatu" });
      else lanes.waiting.push({ ...base, state: "Aguardando aprovação", tone: "ready", detail: a.approvalRole ? `Quem decide: perfil ${a.approvalRole}.` : "Aguarda quem tem permissão para aprovar.", viewMode: "falatu" });
    }

    const objectives = ExecutionResultsService.executing(orgId, user);
    const objectiveCids = new Set(objectives.groups.map((g) => g.correlationId).filter(Boolean) as string[]);
    for (const g of objectives.groups) {
      lanes.running.push({ id: g.key, kind: "objective", title: g.objective, state: "Em andamento", tone: "in_progress",
        detail: g.states.map((s) => `${s.count} ${s.label.toLowerCase()}`).join(" · ") || null, at: null,
        impact: g.impact.restricted || g.impact.amount != null ? { amount: g.impact.amount, unit: g.impact.unit, restricted: g.impact.restricted } : null,
        assurance: null, viewMode: "falatu" });
    }

    const recent = db.prepare(`SELECT id, domain, title, status, correlation_id, expected_impact, impact_unit, completed_at, created_at FROM decision_actions
        WHERE organization_id = ? AND (status IN ('approved','failed') OR (status = 'done' AND datetime(completed_at) >= datetime('now', ?)))
        ORDER BY datetime(COALESCE(completed_at, created_at)) DESC LIMIT 100`).all(orgId, `-${RECENT_DONE_DAYS} days`) as any[];
    for (const a of recent) {
      if (!ContextProjectionService.canSeeDomain(orgId, user, a.domain) || approvalIds.has(a.id)) continue;
      const base = { id: a.id, kind: "action" as const, title: String(a.title), impact: money(a.expected_impact, a.impact_unit), viewMode: "falatu" };
      if (a.status === "failed") lanes.needsYou.push({ ...base, state: "Falhou", tone: "failed", detail: "Não deu certo — precisa de uma decisão sua.", at: asDate(a.completed_at || a.created_at), assurance: null });
      else if (a.status === "approved") {
        if (a.correlation_id && objectiveCids.has(a.correlation_id)) continue;   // já representado pelo objetivo em andamento
        lanes.running.push({ ...base, state: "Aprovado — pronto", tone: "ready", detail: "Aprovado; entrando na execução.", at: asDate(a.created_at), assurance: null });
      } else if (pending.has(a.id)) {
        lanes.waiting.push({ ...base, state: "Executado — aguardando confirmação", tone: "in_progress", detail: "Esperando a confirmação de que deu efeito.", at: asDate(a.completed_at), assurance: null });
      } else {
        let st = "unknown";
        try { st = String(OutcomeAssuranceService.assessAction(orgId, a.id)?.assuranceState || "unknown"); } catch { /* sem garantia: honesto */ }
        lanes.done.push({ ...base, state: "Concluído", tone: "done", detail: null, at: asDate(a.completed_at), assurance: { state: st, label: ASSURANCE_LABEL[st] || ASSURANCE_LABEL.unknown } });
      }
    }

    // ── Missões (gestor + Mission Layer ligado) ──
    const missionsAvailable = isManager && MissionService.isEnabled(orgId);
    if (missionsAvailable) {
      for (const m of MissionService.list(orgId)) {
        const label = MissionService.humanStatus(m.status);
        const it = (state: string, tone: string): BoardItem => ({ id: m.id, kind: "mission", title: m.title, state, tone, detail: m.desiredState || null, at: asDate(m.updatedAt), impact: null, assurance: null, viewMode: "missoes" });
        if (m.status === "waiting_approval") lanes.needsYou.push(it(label, "needs_you"));
        else if (m.status === "running" || m.status === "at_risk") lanes.running.push(it(label, m.status === "at_risk" ? "failed" : "in_progress"));
        else if (m.status === "blocked" || m.status === "ready" || m.status === "planning") lanes.waiting.push(it(label, "ready"));
        else if (m.status === "achieved" && m.updatedAt && now.getTime() - new Date(m.updatedAt.replace(" ", "T") + (m.updatedAt.includes("Z") ? "" : "Z")).getTime() <= RECENT_DONE_DAYS * 86400000)
          lanes.done.push(it(label, "done"));
      }
    }

    // ── Tarefas (gestor vê todas; os demais, só as suas) ──
    const tasks = db.prepare(`SELECT id, title, status, assigned_to, due_at, completed_at FROM tasks WHERE organization_id = ?
        AND (status IN ('a_fazer','fazendo') OR (status = 'feito' AND datetime(completed_at) >= datetime('now', ?))) ORDER BY datetime(COALESCE(due_at, '9999-12-31')) ASC LIMIT 200`).all(orgId, `-${RECENT_DONE_DAYS} days`) as any[];
    for (const t of tasks) {
      if (!isManager && t.assigned_to !== uid) continue;
      const hs = (state: string, tone: string, detail: string | null): BoardItem => ({ id: t.id, kind: "task", title: String(t.title), state, tone, detail, at: asDate(t.due_at || t.completed_at), impact: null, assurance: null, viewMode: "tarefas" });
      const overdue = t.due_at && new Date(String(t.due_at).replace(" ", "T")).getTime() < now.getTime();
      if (t.status === "fazendo") lanes.running.push(hs("Em andamento", "in_progress", overdue ? "Prazo vencido." : null));
      else if (t.status === "a_fazer") lanes.waiting.push(hs("Na fila", "ready", overdue ? "Prazo vencido." : t.due_at ? `Prazo: ${String(t.due_at).slice(0, 10)}` : null));
      else lanes.done.push(hs("Concluída", "done", null));
    }

    const out = {} as ExecutingBoard["lanes"];
    for (const k of Object.keys(lanes) as Lane[]) out[k] = { total: lanes[k].length, items: lanes[k].slice(0, LANE_LIMIT) };
    return { lanes: out, missionsAvailable, generatedAt: now.toISOString() };
  }
}

export default ExecutingBoardService;
