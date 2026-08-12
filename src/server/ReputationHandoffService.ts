/**
 * ReputationHandoffService (ADR-162 / PRD 5 §33, §36, F7) — costura o caso de reputação
 * às superfícies operacionais do FALA TU, **sem reimplementar nenhuma delas** (§36/CA15):
 *
 *   - APPROVAL CENTER, SMART INBOX e THREAD já são dirigidos por `correlation_id` +
 *     `decision_actions` (a espinha ADR-158). Como a F2 publica o sinal de reputação e a
 *     F6 propõe as ações de recovery TODOS na mesma cadeia, o caso já aparece nessas três
 *     superfícies **de graça** — este service NÃO os duplica; o teto prova o reuso.
 *   - O que a F7 ACRESCENTA é o §33 INTERNAL HANDOFF: passar o caso pra um humano com um
 *     RESUMO pronto, ancorado ao caso. Reusa `InternalChatService.post` (nota do caso por
 *     `correlation_id`) — mas com um resumo DETERMINÍSTICO montado da investigação (F5) +
 *     recovery (F6), **sem LLM** (o `HandoffSummaryService` canônico depende de ticket+IA
 *     e não serve pra um caso que nasce de `business_signal`; roda em CI sem chave).
 *
 * Guardrails: isolado por org (RN-CRR-9); o handoff **não age** no caso (só cria a nota);
 * high-risk é marcado no resumo (IA não conclui, RN-CRR-4); a projeção RBAC+purpose (§73)
 * das superfícies é herdada (thread/inbox já filtram por papel). Determinístico.
 */
import db from "./db.js";
import { ReputationInvestigationService } from "./ReputationInvestigationService.js";
import { InternalChatService } from "./InternalChatService.js";
import { FalaTuThreadService } from "./FalaTuThreadService.js";
import { FalaTuApprovalService } from "./FalaTuApprovalService.js";

interface CaseHead { correlationId: string; category: string; highRisk: boolean; contactId: string | null; severity: string | null; claim: string; }

export class ReputationHandoffService {
  /** Cabeçalho do caso (correlation_id + sujeito + severidade), ou null se não existe. */
  private static head(orgId: string, signalId: string): CaseHead | null {
    const sig = db.prepare(
      `SELECT correlation_id, subject_type, subject_id, severity, evidence_json FROM business_signals
       WHERE organization_id = ? AND id = ? AND domain = 'reputation'`
    ).get(orgId, signalId) as any;
    if (!sig) return null;
    let ev: any = {}; try { ev = JSON.parse(sig.evidence_json || "{}"); } catch { ev = {}; }
    return {
      correlationId: sig.correlation_id || signalId,
      category: String(ev.classification?.category || "other"),
      highRisk: !!ev.classification?.highRisk,
      contactId: sig.subject_type === "contact" ? (sig.subject_id || null) : null,
      severity: sig.severity || null,
      claim: String(ev.content || ev.summary || "").slice(0, 180),
    };
  }

  /** Ações de recovery (F6) já propostas neste caso (mesma cadeia). */
  private static recoveryActions(orgId: string, correlationId: string): Array<{ actionType: string; title: string; status: string }> {
    return (db.prepare(
      `SELECT action_type, title, status FROM decision_actions
       WHERE organization_id = ? AND correlation_id = ? AND domain = 'recovery' ORDER BY created_at ASC`
    ).all(orgId, correlationId) as any[]).map((a) => ({ actionType: a.action_type, title: a.title, status: a.status }));
  }

  /**
   * Resumo DETERMINÍSTICO de handoff (§33): o que o cliente alega, a causa provável +
   * grounding, e a recomendação corrente — pronto pro humano assumir sem reler o caso.
   */
  static buildSummary(orgId: string, signalId: string): { correlationId: string; summary: string; category: string; highRisk: boolean } | null {
    const h = this.head(orgId, signalId);
    if (!h) return null;
    const inv = ReputationInvestigationService.investigate(orgId, signalId);
    const actions = this.recoveryActions(orgId, h.correlationId);

    const lines: string[] = [];
    lines.push(`[Reputação · ${h.category}]${h.severity ? ` · ${h.severity}` : ""}`);
    if (h.highRisk) lines.push("⚠️ ALTO RISCO — apuração humana obrigatória; IA não conclui nem responde autônomo (RN-CRR-4).");
    lines.push(`Cliente: ${h.contactId || "não identificado"}`);
    if (h.claim) lines.push(`Alegação: "${h.claim}"`);
    if (inv) lines.push(`Causa provável: ${inv.headline}`);
    lines.push(actions.length
      ? `Recomendação: ${actions.map((a) => `${a.title} (${a.status})`).join(" · ")}`
      : "Recomendação: nenhum plano de recovery gerado ainda.");
    return { correlationId: h.correlationId, summary: lines.join("\n"), category: h.category, highRisk: h.highRisk };
  }

  /**
   * INTERNAL HANDOFF (§33) — posta o resumo como NOTA do caso (ou direcionada a um
   * colega), ancorada ao `correlation_id`. A nota aparece na Thread (estágio 'nota') e,
   * se direcionada, na caixa interna do destinatário. Não age no caso.
   */
  static handoff(orgId: string, fromUserId: string, signalId: string, opts: { toUserId?: string | null; note?: string } = {}): {
    correlationId: string; summary: string; note: any;
  } | null {
    const built = this.buildSummary(orgId, signalId);
    if (!built) return null;
    const body = opts.note ? `${built.summary}\n\nNota do operador: ${String(opts.note).slice(0, 1000)}` : built.summary;
    const note = InternalChatService.post(orgId, fromUserId, { toUserId: opts.toUserId || null, correlationId: built.correlationId, body });
    return { correlationId: built.correlationId, summary: built.summary, note };
  }

  /**
   * §36 — a "central Fala Tu" do caso: compõe a Thread (linha do tempo por
   * correlation_id) + as aprovações pendentes DESTE caso, reusando as superfícies
   * canônicas (nada novo). Filtradas por papel pelas próprias superfícies.
   */
  static caseView(orgId: string, user: any, signalId: string): {
    signalId: string; correlationId: string; category: string; highRisk: boolean;
    thread: any; pendingApprovals: any[];
  } | null {
    const h = this.head(orgId, signalId);
    if (!h) return null;
    const thread = FalaTuThreadService.thread(orgId, user, h.correlationId);
    const pendingApprovals = FalaTuApprovalService.pending(orgId, user).items.filter((i: any) => i.correlationId === h.correlationId);
    return { signalId, correlationId: h.correlationId, category: h.category, highRisk: h.highRisk, thread, pendingApprovals };
  }
}

export default ReputationHandoffService;
