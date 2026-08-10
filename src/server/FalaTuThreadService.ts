/**
 * FalaTuThreadService — PRD 1 Fase 6 (§48-52): status de execução + threads.
 *
 * Duas leituras, ambas COMPOSIÇÃO (nada novo persistido, CA15):
 *   - `executionStatus` (§48): "o que você está fazendo?" → agrega os processos
 *     ATIVOS do `ProcessRuntimeService` por tipo ("3 cobranças, 2 recuperações…");
 *   - `thread` (§51-52): "o que aconteceu com aquilo?" → a linha do tempo de tudo
 *     que compartilha um `correlation_id` (a espinha ADR-158, que a fundação do
 *     PRD 1 estendeu ao inbox do Fala Tu): entrada → sinal → decisão → execução →
 *     resultado. Filtrada por papel (reusa `ContextProjectionService.canSeeDomain`).
 */
import db from "./db.js";
import { ProcessRuntimeService } from "./ProcessRuntimeService.js";
import { ContextProjectionService } from "./ContextProjectionService.js";

const PROC_ACTIVE = new Set(["planned", "authorized", "queued", "executing", "waiting_external_response"]);

export interface ThreadEvent {
  stage: "entrada" | "sinal" | "decisao" | "execucao" | "resultado";
  at: string | null; source: string; title: string;
  status?: string | null; domain?: string | null; detail?: string | null;
}

export class FalaTuThreadService {
  /** §48 — processos ativos agregados por tipo. */
  static executionStatus(orgId: string, _user: any): { total: number; byType: Array<{ type: string; count: number }>; items: any[] } {
    const active = ProcessRuntimeService.listInstances(orgId, { limit: 300 }).filter((p) => PROC_ACTIVE.has(p.status));
    const counts = new Map<string, number>();
    for (const p of active) counts.set(p.process_type, (counts.get(p.process_type) || 0) + 1);
    return {
      total: active.length,
      byType: [...counts.entries()].map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count),
      items: active.map((p) => ({ id: p.id, processType: p.process_type, status: p.status, startedAt: p.started_at, riskLevel: p.risk_level ?? null })),
    };
  }

  /** §51-52 — linha do tempo do que compartilha `correlationId`, filtrada por papel. */
  static thread(orgId: string, user: any, correlationId: string): { correlationId: string; events: ThreadEvent[] } {
    const cid = String(correlationId || "").trim();
    const events: ThreadEvent[] = [];
    if (!cid) return { correlationId: cid, events };
    const userId = user?.userId || user?.id || null;
    const see = (domain: string | null) => ContextProjectionService.canSeeDomain(orgId, user, domain);

    // Entrada (inbox) — pessoal: só o que é do próprio usuário.
    for (const r of db.prepare(`SELECT * FROM falatu_inbox_items WHERE organization_id = ? AND correlation_id = ? AND user_id = ?`).all(orgId, cid, userId) as any[]) {
      events.push({ stage: "entrada", at: r.created_at, source: "inbox", title: r.summary || r.transcription || r.content || "Captura", status: r.status, detail: r.intent });
    }
    // Sinal
    for (const r of db.prepare(`SELECT * FROM business_signals WHERE organization_id = ? AND correlation_id = ?`).all(orgId, cid) as any[]) {
      if (see(r.domain)) events.push({ stage: "sinal", at: r.detected_at, source: "signal", title: r.signal_type, status: r.severity, domain: r.domain });
    }
    // Decisão / aprovação — e a execução AMARRADA à ação (process_instances não
    // tem correlation_id; liga pela FK `decision_actions.process_instance_id`,
    // ADR-152 D2). Assim a execução herda o gate de domínio da sua ação.
    const procIds: string[] = [];
    for (const r of db.prepare(`SELECT * FROM decision_actions WHERE organization_id = ? AND correlation_id = ?`).all(orgId, cid) as any[]) {
      if (!see(r.domain)) continue;
      events.push({ stage: "decisao", at: r.approved_at || r.created_at, source: "action", title: r.title, status: r.status, domain: r.domain });
      if (r.process_instance_id) procIds.push(r.process_instance_id);
    }
    // Execução (dos processos das ações visíveis)
    for (const pid of procIds) {
      const p = db.prepare(`SELECT * FROM process_instances WHERE id = ? AND organization_id = ?`).get(pid, orgId) as any;
      if (p) events.push({ stage: "execucao", at: p.started_at, source: "process", title: p.process_type, status: p.status });
    }
    // Resultado
    for (const r of db.prepare(`SELECT o.*, a.domain AS a_domain, a.title AS a_title FROM action_outcomes o LEFT JOIN decision_actions a ON a.id = o.action_id WHERE o.organization_id = ? AND o.correlation_id = ?`).all(orgId, cid) as any[]) {
      if (see(r.a_domain)) events.push({ stage: "resultado", at: r.measured_at, source: "outcome", title: r.a_title || "Resultado", status: r.basis, domain: r.a_domain, detail: `esperado ${r.expected_value ?? "—"} → realizado ${r.realized_value ?? "—"}` });
    }

    events.sort((x, y) => (Date.parse(x.at || "") || 0) - (Date.parse(y.at || "") || 0));
    return { correlationId: cid, events };
  }
}
