import db from "./db.js";
import { ApprovalPolicyService } from "./ApprovalPolicyService.js";
import { UxPresentationService } from "./UxPresentationService.js";
import { presentSignal } from "./SignalLanguage.js";

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


// ADR-204 F3.1b (PRD §37) — "não executei porque…": o código de recusa do executor em linguagem de negócio.
const REFUSAL_TEXT: Record<string, string> = {
  human_approval_missing: "é uma ação que o ZapFlow nunca executa sem a aprovação de uma pessoa, e não há aprovação registrada",
  policy_missing: "não existe uma política ativa autorizando a execução deste tipo de ação",
  autonomy_below_execute: "a autonomia definida para este tipo de ação só permite recomendar ou preparar, não executar",
  execution_mode_blocked: "a empresa ainda está em modo de teste/assistido, que bloqueia efeito externo",
  action_not_approved: "a ação ainda não estava aprovada",
  action_terminal: "a ação já estava finalizada",
  action_already_executed: "o efeito já tinha sido executado antes (não repito para não duplicar)",
  no_handler: "não existe um executor cadastrado para este comando",
  handler_error: "o executor tentou realizar o efeito e falhou",
};

const SOURCE_TEXT: Record<string, string> = {
  bands: "pela faixa de valor que o dono definiu",
  agent_policy: "pela política da empresa para este tipo de ação",
  default_matrix: "pela regra padrão do ZapFlow para este tipo de ação",
};

const BR_DATE = (s: any): string | null => {
  if (!s) return null;
  const raw = String(s);
  const d = new Date(/Z|[+-]\d\d:?\d\d$/.test(raw) ? raw : raw.replace(" ", "T") + "Z");
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).replace(",", " às");
};

export interface ExecutionTrace {
  correlationId: string;
  signals: any[];
  actions: any[];
  // ADR-165 F8 — elos que a auditoria F0 apontou como faltantes no trace: entre a DECISÃO
  // e o OUTCOME existem a EXECUÇÃO governada (action_execution_log) e a CONFIRMAÇÃO do
  // efeito (action_confirmations). Sem eles o fio "pulava" essas etapas.
  executions: any[];
  confirmations: any[];
  outcomes: any[];
  summary: { signals: number; actions: number; executions: number; confirmations: number; outcomes: number; closedLoop: boolean };
}

export class ExecutionTraceService {
  /**
   * Reconstrói a cadeia de um correlationId (isolada por org). Ordena cada
   * elo cronologicamente para leitura de cima pra baixo (sinal mais antigo →
   * outcome mais recente). `closedLoop` = há sinal E ação E outcome no fio.
   */
  static trace(orgId: string, correlationId: string): ExecutionTrace {
    const cid = String(correlationId || "").trim();
    const empty: ExecutionTrace = { correlationId: cid, signals: [], actions: [], executions: [], confirmations: [], outcomes: [], summary: { signals: 0, actions: 0, executions: 0, confirmations: 0, outcomes: 0, closedLoop: false } };
    if (!orgId || !cid) return empty;

    const signals = (db.prepare(
      "SELECT * FROM business_signals WHERE organization_id = ? AND correlation_id = ? ORDER BY detected_at ASC, id ASC",
    ).all(orgId, cid) as any[]).map((r) => ({ ...r, evidence: safeParse(r.evidence_json), premises: r.premises_json ? safeParse(r.premises_json) : null }));

    const actions = (db.prepare(
      "SELECT * FROM decision_actions WHERE organization_id = ? AND correlation_id = ? ORDER BY created_at ASC, id ASC",
    ).all(orgId, cid) as any[]).map((a) => ({ ...a, command_payload: a.command_payload_json ? safeParse(a.command_payload_json) : null, policy_snapshot: a.policy_snapshot_json ? safeParse(a.policy_snapshot_json) : null }));

    // Execuções: têm correlation_id próprio (ADR-158). Ordena cronologicamente.
    const executions = (db.prepare(
      "SELECT * FROM action_execution_log WHERE organization_id = ? AND correlation_id = ? ORDER BY started_at ASC, id ASC",
    ).all(orgId, cid) as any[]).map((e) => ({ ...e, request: e.request_json ? safeParse(e.request_json) : null, response: e.response_json ? safeParse(e.response_json) : null }));

    // Confirmações: NÃO têm correlation_id — ligam por action_id às ações do fio.
    const actionIds = actions.map((a) => a.id);
    let confirmations: any[] = [];
    if (actionIds.length) {
      const placeholders = actionIds.map(() => "?").join(",");
      confirmations = (db.prepare(
        `SELECT * FROM action_confirmations WHERE organization_id = ? AND action_id IN (${placeholders}) ORDER BY created_at ASC, id ASC`,
      ).all(orgId, ...actionIds) as any[]).map((c) => ({ ...c, evidence: c.evidence_json ? safeParse(c.evidence_json) : null }));
    }

    const outcomes = (db.prepare(
      "SELECT * FROM action_outcomes WHERE organization_id = ? AND correlation_id = ? ORDER BY measured_at ASC, id ASC",
    ).all(orgId, cid) as any[]).map((o) => ({ ...o, evidence: o.evidence_json ? safeParse(o.evidence_json) : null }));

    return {
      correlationId: cid,
      signals,
      actions,
      executions,
      confirmations,
      outcomes,
      summary: {
        signals: signals.length,
        actions: actions.length,
        executions: executions.length,
        confirmations: confirmations.length,
        outcomes: outcomes.length,
        // closedLoop mantém a semântica pré-F8 (sinal+ação+outcome) — não regride.
        closedLoop: signals.length > 0 && actions.length > 0 && outcomes.length > 0,
      },
    };
  }


  /**
   * ADR-204 F3.1b (PRD §35/§36, RN-F3-8) — "POR QUE o ZapFlow fez isso?" para UMA ação, em EVIDÊNCIA DE NEGÓCIO
   * (não cadeia de raciocínio): o que foi recomendado e em que base (fato/estimativa/confiança), de qual sinal nasceu,
   * qual regra governou (foto gravada na proposta), quem autorizou (pessoa × automática dentro da política), o que
   * foi executado — ou "não executei porque…" — e o resultado medido. Read-only e determinístico; isolado por org.
   * Dinheiro role-gated (§73): sem `canSeeMoney`, os valores vêm `null` + `restricted:true` (o fato permanece).
   * Ação anterior ao registro da política: `policy.recorded=false`, dito com todas as letras — nunca reconstrói
   * "o que valia na época" a partir da política de hoje.
   */
  static explain(orgId: string, actionId: string, opts: { canSeeMoney?: boolean } = {}): any | null {
    const a = db.prepare("SELECT * FROM decision_actions WHERE id = ? AND organization_id = ?").get(actionId, orgId) as any;
    if (!a) return null;
    const money = opts.canSeeMoney !== false;
    const snap = a.policy_snapshot_json ? safeParse(a.policy_snapshot_json) : null;
    const lines: string[] = [];

    // 1) Recomendação original + base
    const band = UxPresentationService.confidenceBand(a.confidence);
    const basisTxt = a.basis === "fact" ? "fato" : a.basis === "influenced" ? "influência (não causa única)" : "estimativa";
    const recommendation = { text: a.description || null, basis: a.basis || null, basisLabel: basisTxt, confidenceBand: band };
    lines.push(`O que foi proposto: ${a.title}${a.description ? ` — ${a.description}` : ""}.`);
    lines.push(`Base: ${basisTxt}${band ? `, confiança ${band}` : ""}.`);

    // 2) Sinal de origem (linguagem de negócio, nunca o identificador técnico)
    let signal: any = null;
    if (a.signal_id) {
      const sg = db.prepare("SELECT signal_type, domain, severity, basis, detected_at, evidence_json FROM business_signals WHERE id = ? AND organization_id = ?").get(a.signal_id, orgId) as any;
      if (sg) {
        const pres = presentSignal({ signalType: sg.signal_type, domain: sg.domain, evidence: safeParse(sg.evidence_json), actionType: a.action_type, severity: sg.severity });
        signal = { title: pres.title, meaning: pres.meaning, severity: sg.severity, basis: sg.basis, detectedAt: sg.detected_at };
        const when = BR_DATE(sg.detected_at);
        lines.push(`Nasceu deste ponto de atenção: ${pres.title}${when ? ` (detectado em ${when})` : ""}. ${pres.meaning}`);
      }
    }

    // 3) Impacto esperado — role-gated
    const hasImpact = a.expected_impact != null;
    const impact = hasImpact
      ? { expected: money ? Number(a.expected_impact) : null, unit: a.impact_unit || "BRL", restricted: !money }
      : { expected: null, unit: null, restricted: false };

    // 4) Política que governou (foto da proposta)
    let policySummary: string;
    if (snap) {
      const parts: string[] = [];
      parts.push(`Regra aplicada ${SOURCE_TEXT[snap.source] || "pela política vigente"}.`);
      const need = Number(snap.requiredApprovals) || 0;
      parts.push(need === 0
        ? "Esta ação podia seguir sem aprovação humana (dentro do limite autorizado)."
        : need === 1 ? `Exigiu a aprovação de 1 pessoa${snap.requiredRole ? ` com o perfil "${snap.requiredRole}"` : ""}.`
          : `Exigiu a aprovação de ${need} pessoas diferentes.`);
      if (snap.humanOnly) parts.push("É um tipo de ação que o ZapFlow NUNCA aprova sozinho (compras, pagamentos, comissão, salário, contratos…).");
      if (snap.floorApplied) parts.push("A regra configurada permitiria aprovar automaticamente, mas essa trava de segurança não deixou.");
      if (snap.autonomy) parts.push(`Nível de autonomia: ${snap.autonomy.label}.`);
      policySummary = parts.join(" ");
    } else {
      policySummary = "Ação anterior ao registro da política: não há foto do que valia na época.";
    }
    lines.push(policySummary);

    // 5) Quem autorizou
    const apRows = db.prepare("SELECT approver_user_id, decision, reason, decided_at FROM action_approvals WHERE action_id = ? AND organization_id = ? ORDER BY decided_at ASC").all(actionId, orgId) as any[];
    const nameOf = (uid: string | null) => {
      if (!uid) return null;
      const u = db.prepare("SELECT name FROM users WHERE id = ? AND organization_id = ?").get(uid, orgId) as any;
      return u?.name || null;
    };
    const approvals = apRows.map((r) => {
      const isPerson = !ApprovalPolicyService.isSystemActor(r.approver_user_id);
      return { by: r.approver_user_id || null, byName: isPerson ? (nameOf(r.approver_user_id) || null) : null, isPerson, decision: r.decision, at: r.decided_at, reason: r.reason || null };
    });
    const approvedByPeople = approvals.filter((r) => r.decision === "approved" && r.isPerson);
    const rejected = approvals.find((r) => r.decision === "rejected");
    const authorized = ["approved", "done"].includes(a.status) || !!a.executed_at;
    const automatic = authorized && approvedByPeople.length === 0;
    const need = snap ? Number(snap.requiredApprovals) || 0 : ApprovalPolicyService.requiredApprovals(a.approval_policy);
    let authSummary: string;
    if (rejected) {
      authSummary = `Rejeitada${rejected.byName ? ` por ${rejected.byName}` : " por uma pessoa"}${BR_DATE(rejected.at) ? ` em ${BR_DATE(rejected.at)}` : ""}${rejected.reason ? ` — motivo: ${rejected.reason}` : ""}.`;
    } else if (a.status === "cancelled") {
      authSummary = "Cancelada antes de ser executada.";
    } else if (automatic) {
      authSummary = "Autorizada automaticamente, dentro da política (nenhuma pessoa precisou aprovar).";
    } else if (authorized) {
      authSummary = `Autorizada por ${approvedByPeople.map((r) => `${r.byName || "uma pessoa"}${BR_DATE(r.at) ? ` (${BR_DATE(r.at)})` : ""}`).join(" e ")}.`;
    } else {
      const falta = Math.max(0, need - approvedByPeople.length);
      authSummary = `Aguardando aprovação${falta ? ` de ${falta} pessoa${falta > 1 ? "s" : ""}` : ""}.`;
    }
    lines.push(authSummary);

    // 6) Execução (ou "não executei porque…")
    const ex = db.prepare("SELECT attempt, handler, mode, status, error_code, response_json, started_at FROM action_execution_log WHERE action_id = ? AND organization_id = ? AND mode = 'execute' ORDER BY attempt ASC, started_at ASC").all(actionId, orgId) as any[];
    const attempts = ex.map((e) => ({
      attempt: e.attempt, status: e.status, at: e.started_at, handler: e.handler, errorCode: e.error_code || null,
      refusedBecause: e.status === "failed" ? (REFUSAL_TEXT[e.error_code] || "o executor recusou ou falhou") : null,
    }));
    const done = attempts.find((e) => e.status === "done");
    const lastFail = [...attempts].reverse().find((e) => e.status === "failed") || null;
    let notExecutedBecause: string | null = null;
    if (done) lines.push(`Executada${BR_DATE(done.at) ? ` em ${BR_DATE(done.at)}` : ""}.`);
    else if (lastFail) { notExecutedBecause = `Não executei porque ${lastFail.refusedBecause}.`; lines.push(notExecutedBecause); }
    else if (a.status === "awaiting_approval") { notExecutedBecause = "Não executei porque ainda aguarda aprovação."; lines.push(notExecutedBecause); }
    else if (a.status === "approved") lines.push("Aprovada; ainda não houve tentativa de executar.");

    // 7) Resultado medido — role-gated
    const oc = db.prepare("SELECT expected_value, realized_value, basis, measured_at FROM action_outcomes WHERE action_id = ? AND organization_id = ? ORDER BY measured_at DESC LIMIT 1").get(actionId, orgId) as any;
    const outcome = oc
      ? { measured: true, basis: oc.basis || null, measuredAt: oc.measured_at, expected: money ? (oc.expected_value ?? null) : null, realized: money ? (oc.realized_value ?? null) : null, restricted: !money }
      : { measured: false, basis: null, measuredAt: null, expected: null, realized: null, restricted: false };
    if (oc) lines.push(money
      ? `Resultado medido (${oc.basis === "fact" ? "fato" : oc.basis === "influenced" ? "influência" : "estimativa"}): esperado ${oc.expected_value ?? "—"} × realizado ${oc.realized_value ?? "—"}.`
      : "Resultado já medido (valores reservados ao gestor).");

    return {
      actionId: a.id, correlationId: a.correlation_id || null, what: a.title, domain: a.domain, status: a.status,
      recommendation, evidence: { signal }, impact,
      policy: { recorded: !!snap, snapshot: snap, summary: policySummary },
      authorization: { requiredApprovals: need, approvals, automatic, byPerson: approvedByPeople.length > 0, summary: authSummary },
      execution: { executed: !!done, attempts, lastRefusal: lastFail ? { errorCode: lastFail.errorCode, because: lastFail.refusedBecause } : null },
      outcome, notExecutedBecause, lines,
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
