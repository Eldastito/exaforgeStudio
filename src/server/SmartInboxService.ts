/**
 * SmartInboxService — PRD 1 Fase 3 (§20-23, §60): a Caixa de Entrada Inteligente.
 *
 * NÃO é uma fonte de alertas nova (§4/CA15). É uma COMPOSIÇÃO ranqueada de três
 * engines canônicos, organizada por NECESSIDADE DE AÇÃO (§21), não por cronologia
 * (§22):
 *   - `BusinessSignalService.attention` (signals + risks) → RISCO / OPORTUNIDADE / INFORMAÇÃO;
 *   - `DecisionActionService.list` (decision_actions) → PRECISA DA SUA APROVAÇÃO / DECISÃO / RESOLVIDO;
 *   - `ProcessRuntimeService.listInstances` (process_instances) → EM EXECUÇÃO / RESOLVIDO.
 *
 * Ranking (§22): score determinístico por severidade + impacto + prazo/SLA +
 * (nas ações) o `priority_score` que o ImpactPrioritizationService já calculou.
 * Escopo por papel: itens de domínio que o usuário não pode ver são ocultados
 * (reusa `PermissionService` via `DOMAIN_MODULE`, mesma malha da segurança P1).
 */
import { BusinessSignalService } from "./BusinessSignalService.js";
import { DecisionActionService } from "./DecisionActionService.js";
import { ProcessRuntimeService } from "./ProcessRuntimeService.js";
import { PermissionService } from "./PermissionService.js";
import { DOMAIN_MODULE } from "./ContextProjectionService.js";

const SEV_WEIGHT: Record<string, number> = { critical: 100, risk: 70, attention: 40, info: 10 };
// Sinais de OPORTUNIDADE por tipo (heurística determinística, documentada).
const OPP_RE = /opportun|oportunid|recover|recupera|upsell|cross.?sell|prospect|lead|reativa/i;
const PROC_ACTIVE = new Set(["planned", "authorized", "queued", "executing", "waiting_external_response"]);
const PROC_DONE = new Set(["completed", "measured"]);
const RESOLVED_WINDOW_MS = 48 * 60 * 60 * 1000; // "resolvido" = concluído nas últimas 48h (§23)

export type InboxCategory = "needsApproval" | "needsDecision" | "risk" | "opportunity" | "inExecution" | "resolved" | "info";
export interface InboxItem {
  id: string; source: "signal" | "action" | "process"; category: InboxCategory;
  title: string; domain: string | null; severity: string | null;
  impactAmount: number | null; impactUnit: string | null; score: number;
  deadlineAt: string | null; correlationId: string | null; status: string | null;
}

function impactBoost(amount: number | null | undefined): number {
  if (!amount) return 0;
  return Math.min(50, Math.round(Math.log10(1 + Math.abs(Number(amount))) * 12));
}

export class SmartInboxService {
  private static canSeeDomain(orgId: string, user: any, domain: string | null): boolean {
    if (!domain) return true;
    const mod = DOMAIN_MODULE[domain];
    if (!mod) return true; // domínio operacional sem malha sensível → visível
    return PermissionService.levelFor(orgId, user, mod) !== "none";
  }

  private static signalItem(s: any, category: InboxCategory): InboxItem {
    return {
      id: s.id, source: "signal", category, title: s.summary || s.type || "Sinal",
      domain: s.domain || null, severity: s.severity || null,
      impactAmount: s.impactAmount ?? null, impactUnit: s.impactUnit ?? null,
      score: (SEV_WEIGHT[s.severity] || 10) + impactBoost(s.impactAmount),
      deadlineAt: null, correlationId: s.correlationId ?? null, status: s.status ?? null,
    };
  }

  private static actionItem(a: any, category: InboxCategory, now: number): InboxItem {
    let score = 50 + (Number(a.priority_score) || 0) + impactBoost(a.expected_impact);
    if (a.due_at) { const d = new Date(a.due_at).getTime() - now; if (d <= 24 * 3600e3) score += 40; else if (d <= 72 * 3600e3) score += 20; }
    if (category === "needsApproval") score += 30; // aprovação bloqueada é topo (§22)
    return {
      id: a.id, source: "action", category, title: a.title || a.action_type || "Ação",
      domain: a.domain || null, severity: null,
      impactAmount: a.expected_impact ?? null, impactUnit: a.impact_unit ?? null,
      score: Math.round(score), deadlineAt: a.due_at ?? null, correlationId: a.correlation_id ?? null, status: a.status ?? null,
    };
  }

  private static procItem(p: any, category: InboxCategory): InboxItem {
    const risk = ({ high: 30, medium: 15, low: 5 } as Record<string, number>)[p.risk_level] || 0;
    return {
      id: p.id, source: "process", category, title: p.process_type || "Processo",
      domain: p.domain || null, severity: p.risk_level || null,
      impactAmount: p.expected_value ?? null, impactUnit: "BRL", score: Math.round((Number(p.priority) || 0) + risk),
      deadlineAt: p.deadline_at ?? null, correlationId: p.correlation_id ?? null, status: p.status ?? null,
    };
  }

  /** Monta a Smart Inbox categorizada + ranqueada + filtrada por papel. */
  static build(orgId: string, user: any, opts: { now?: number } = {}): {
    generatedAt: string; counts: Record<InboxCategory, number>; categories: Record<InboxCategory, InboxItem[]>;
  } {
    const now = opts.now || Date.now();
    const cats: Record<InboxCategory, InboxItem[]> = { needsApproval: [], needsDecision: [], risk: [], opportunity: [], inExecution: [], resolved: [], info: [] };

    // Ações → aprovação / decisão / resolvido
    for (const a of DecisionActionService.list(orgId, { status: "awaiting_approval" })) cats.needsApproval.push(this.actionItem(a, "needsApproval", now));
    for (const a of DecisionActionService.list(orgId, { status: "proposed" })) cats.needsDecision.push(this.actionItem(a, "needsDecision", now));
    for (const a of DecisionActionService.list(orgId, { status: "done" })) {
      if (a.completed_at && now - new Date(a.completed_at).getTime() <= RESOLVED_WINDOW_MS) cats.resolved.push(this.actionItem(a, "resolved", now));
    }

    // Sinais → risco / oportunidade / informação
    for (const s of BusinessSignalService.attention(orgId, { limit: 100 }).items) {
      if (s.severity === "critical" || s.severity === "risk") cats.risk.push(this.signalItem(s, "risk"));
      else if (OPP_RE.test(String(s.type || ""))) cats.opportunity.push(this.signalItem(s, "opportunity"));
      else cats.info.push(this.signalItem(s, "info"));
    }

    // Processos → em execução / resolvido
    for (const p of ProcessRuntimeService.listInstances(orgId, { limit: 200 })) {
      if (PROC_ACTIVE.has(p.status)) cats.inExecution.push(this.procItem(p, "inExecution"));
      else if (PROC_DONE.has(p.status) && p.completed_at && now - new Date(p.completed_at).getTime() <= RESOLVED_WINDOW_MS) cats.resolved.push(this.procItem(p, "resolved"));
    }

    // Filtro por papel + ordenação por score desc (§22: prioridade, não cronologia)
    const counts = {} as Record<InboxCategory, number>;
    for (const k of Object.keys(cats) as InboxCategory[]) {
      cats[k] = cats[k].filter((it) => this.canSeeDomain(orgId, user, it.domain)).sort((x, y) => y.score - x.score);
      counts[k] = cats[k].length;
    }
    return { generatedAt: new Date(now).toISOString(), counts, categories: cats };
  }
}
