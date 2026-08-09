import db from "./db.js";

/**
 * ExecutionTraceService (ADR-158 — Espinha Única / Onda 0 F1).
 *
 * Primitiva de RASTREABILIDADE ponta-a-ponta do ciclo universal do ZapFlow
 * (PRD 0 §50 / Estado Final §66): dado um `correlationId`, reconstrói o fio
 * inteiro que atravessa
 *
 *   business_signals → decision_actions → action_outcomes
 *   (perceber)          (decidir/governar)   (medir)
 *
 * Responde, de forma determinística e auditável, à pergunta central da visão:
 * "Por que o ZapFlow fez isso?". NÃO decide nem executa nada — só lê e junta o
 * que já foi registrado. Isolado por organization_id (o correlationId sozinho
 * nunca vaza cadeia de outro tenant: todas as queries filtram o orgId).
 *
 * Compatibilidade: linhas legadas (anteriores à F1) têm correlation_id NULL e
 * simplesmente não aparecem no trace — o fluxo pré-existente segue intacto.
 */

export interface ExecutionTrace {
  correlationId: string;
  signals: any[];
  actions: any[];
  outcomes: any[];
  summary: { signals: number; actions: number; outcomes: number; closedLoop: boolean };
}

export class ExecutionTraceService {
  /**
   * Reconstrói a cadeia de um correlationId (isolada por org). Ordena cada
   * elo cronologicamente para leitura de cima pra baixo (sinal mais antigo →
   * outcome mais recente). `closedLoop` = há sinal E ação E outcome no fio.
   */
  static trace(orgId: string, correlationId: string): ExecutionTrace {
    const cid = String(correlationId || "").trim();
    const empty: ExecutionTrace = { correlationId: cid, signals: [], actions: [], outcomes: [], summary: { signals: 0, actions: 0, outcomes: 0, closedLoop: false } };
    if (!orgId || !cid) return empty;

    const signals = (db.prepare(
      "SELECT * FROM business_signals WHERE organization_id = ? AND correlation_id = ? ORDER BY detected_at ASC, id ASC",
    ).all(orgId, cid) as any[]).map((r) => ({ ...r, evidence: safeParse(r.evidence_json), premises: r.premises_json ? safeParse(r.premises_json) : null }));

    const actions = (db.prepare(
      "SELECT * FROM decision_actions WHERE organization_id = ? AND correlation_id = ? ORDER BY created_at ASC, id ASC",
    ).all(orgId, cid) as any[]).map((a) => ({ ...a, command_payload: a.command_payload_json ? safeParse(a.command_payload_json) : null }));

    const outcomes = (db.prepare(
      "SELECT * FROM action_outcomes WHERE organization_id = ? AND correlation_id = ? ORDER BY measured_at ASC, id ASC",
    ).all(orgId, cid) as any[]).map((o) => ({ ...o, evidence: o.evidence_json ? safeParse(o.evidence_json) : null }));

    return {
      correlationId: cid,
      signals,
      actions,
      outcomes,
      summary: {
        signals: signals.length,
        actions: actions.length,
        outcomes: outcomes.length,
        closedLoop: signals.length > 0 && actions.length > 0 && outcomes.length > 0,
      },
    };
  }

  /** Resolve o correlationId a partir de um id de sinal (atalho pra UI/rota). */
  static correlationForSignal(orgId: string, signalId: string): string | null {
    const r = db.prepare("SELECT correlation_id FROM business_signals WHERE id = ? AND organization_id = ?").get(signalId, orgId) as any;
    return r?.correlation_id || null;
  }
}

function safeParse(s: string): any { try { return JSON.parse(s); } catch { return {}; } }

export default ExecutionTraceService;
