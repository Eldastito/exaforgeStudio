import db from "./db.js";
import { randomUUID } from "crypto";
import { ApprovalPolicyService, ApprovalPolicy } from "./ApprovalPolicyService.js";
import { OutcomeMeasurementService } from "./OutcomeMeasurementService.js";

/**
 * DecisionActionService (ADR-136, Epic 2 — C2).
 *
 * Ciclo de vida da AÇÃO: propor → (aprovar/rejeitar conforme a política) →
 * concluir/cancelar. A IA propõe; a política decide se exige aprovação; nada
 * executa sozinho (a execução governada é fatia posterior — C5). Determinístico,
 * isolado por organization_id, auditável (action_approvals).
 */

export interface ProposeInput {
  signalId?: string | null;
  domain: string;
  actionType: string;
  title: string;
  description?: string | null;
  priorityScore?: number;
  expectedImpact?: number | null;
  impactUnit?: string | null;
  basis?: string;
  confidence?: number;
  assignedTo?: string | null;
  dueAt?: string | null;
  commandType?: string | null;
  commandPayload?: any;
  baseline?: any;
  createdBy?: string;
}

export class DecisionActionService {
  static propose(orgId: string, input: ProposeInput): any {
    if (!input?.domain || !input?.actionType || !String(input?.title || "").trim()) throw new Error("Ação exige domain, actionType e title.");
    const pol = ApprovalPolicyService.resolve(orgId, { domain: input.domain, actionType: input.actionType, expectedImpact: input.expectedImpact });
    // Política 'none' já nasce aprovada (pronta para concluir); as demais aguardam aprovação.
    const status = pol.policy === "none" ? "approved" : "awaiting_approval";
    const id = randomUUID();
    db.prepare(`INSERT INTO decision_actions
      (id, organization_id, signal_id, domain, action_type, title, description, priority_score, expected_impact, impact_unit, basis, confidence, status, approval_policy, approval_role, assigned_to, due_at, command_type, command_payload_json, baseline_json, created_by, approved_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, orgId, input.signalId || null, input.domain, input.actionType, String(input.title).trim(), input.description || null,
        Number(input.priorityScore) || 0, input.expectedImpact != null ? Number(input.expectedImpact) : null, input.impactUnit || null,
        input.basis || "estimate", input.confidence != null ? Number(input.confidence) : 0.7, status, pol.policy, pol.requiredRole,
        input.assignedTo || null, input.dueAt || null, input.commandType || null, input.commandPayload != null ? JSON.stringify(input.commandPayload) : null,
        input.baseline != null ? JSON.stringify(input.baseline) : null, input.createdBy || "rule", status === "approved" ? new Date().toISOString() : null);
    return this.get(orgId, id);
  }

  static get(orgId: string, id: string): any {
    const a = db.prepare("SELECT * FROM decision_actions WHERE id = ? AND organization_id = ?").get(id, orgId) as any;
    if (!a) return null;
    a.approvals = db.prepare("SELECT id, approver_user_id, decision, reason, decided_at FROM action_approvals WHERE action_id = ? AND organization_id = ? ORDER BY decided_at ASC").all(id, orgId);
    a.outcomes = OutcomeMeasurementService.forAction(orgId, id);
    a.command_payload = a.command_payload_json ? safeParse(a.command_payload_json) : null;
    return a;
  }

  static list(orgId: string, opts: { status?: string; domain?: string } = {}): any[] {
    let sql = "SELECT * FROM decision_actions WHERE organization_id = ?";
    const params: any[] = [orgId];
    if (opts.status) { sql += " AND status = ?"; params.push(opts.status); }
    if (opts.domain) { sql += " AND domain = ?"; params.push(opts.domain); }
    sql += " ORDER BY priority_score DESC, created_at DESC LIMIT 200";
    return db.prepare(sql).all(...params) as any[];
  }

  /**
   * Aprova a ação. Registra a aprovação (auditável); quando a política é
   * satisfeita (single/role = 1; two_step = 2 aprovadores DISTINTOS), a ação
   * passa a 'approved'. RBAC de perfil é validado na rota.
   */
  static approve(orgId: string, id: string, actorId: string | undefined, opts: { reason?: string } = {}): any {
    const a = db.prepare("SELECT status, approval_policy, approval_role FROM decision_actions WHERE id = ? AND organization_id = ?").get(id, orgId) as any;
    if (!a) throw new Error("Ação não encontrada.");
    if (a.status !== "awaiting_approval") throw new Error(`Ação não está aguardando aprovação (${a.status}).`);
    db.prepare("INSERT INTO action_approvals (id, organization_id, action_id, required_role, approver_user_id, decision, reason) VALUES (?, ?, ?, ?, ?, 'approved', ?)")
      .run(randomUUID(), orgId, id, a.approval_role || null, actorId || null, opts.reason || null);
    const distinct = (db.prepare("SELECT COUNT(DISTINCT COALESCE(approver_user_id,'?')) n FROM action_approvals WHERE action_id = ? AND organization_id = ? AND decision = 'approved'").get(id, orgId) as any).n;
    const need = ApprovalPolicyService.requiredApprovals(a.approval_policy as ApprovalPolicy);
    if (distinct >= need) {
      db.prepare("UPDATE decision_actions SET status = 'approved', approved_at = CURRENT_TIMESTAMP WHERE id = ? AND organization_id = ?").run(id, orgId);
    }
    return this.get(orgId, id);
  }

  static reject(orgId: string, id: string, actorId: string | undefined, opts: { reason?: string } = {}): any {
    const a = db.prepare("SELECT status FROM decision_actions WHERE id = ? AND organization_id = ?").get(id, orgId) as any;
    if (!a) throw new Error("Ação não encontrada.");
    if (!["awaiting_approval", "approved"].includes(a.status)) throw new Error(`Ação não pode ser rejeitada (${a.status}).`);
    db.prepare("INSERT INTO action_approvals (id, organization_id, action_id, approver_user_id, decision, reason) VALUES (?, ?, ?, ?, 'rejected', ?)")
      .run(randomUUID(), orgId, id, actorId || null, opts.reason || null);
    db.prepare("UPDATE decision_actions SET status = 'rejected' WHERE id = ? AND organization_id = ?").run(id, orgId);
    return this.get(orgId, id);
  }

  static assign(orgId: string, id: string, userId: string | null): any {
    const r = db.prepare("UPDATE decision_actions SET assigned_to = ? WHERE id = ? AND organization_id = ?").run(userId || null, id, orgId);
    if (!r.changes) throw new Error("Ação não encontrada.");
    return this.get(orgId, id);
  }

  static reschedule(orgId: string, id: string, dueAt: string | null): any {
    const r = db.prepare("UPDATE decision_actions SET due_at = ? WHERE id = ? AND organization_id = ?").run(dueAt || null, id, orgId);
    if (!r.changes) throw new Error("Ação não encontrada.");
    return this.get(orgId, id);
  }

  static cancel(orgId: string, id: string): any {
    const a = db.prepare("SELECT status FROM decision_actions WHERE id = ? AND organization_id = ?").get(id, orgId) as any;
    if (!a) throw new Error("Ação não encontrada.");
    if (["done", "rejected"].includes(a.status)) throw new Error(`Ação já finalizada (${a.status}).`);
    db.prepare("UPDATE decision_actions SET status = 'cancelled' WHERE id = ? AND organization_id = ?").run(id, orgId);
    return this.get(orgId, id);
  }

  /**
   * Conclui uma ação APROVADA e registra o outcome esperado×realizado (C2b).
   * O impacto esperado vem da própria ação; o realizado é o `resultAmount`
   * informado — sempre com a mesma `basis` (fato/estimativa) da ação, para o
   * Impact Ledger unificado nunca somar comprovado com estimado.
   */
  static complete(orgId: string, id: string, opts: { resultAmount?: number | null } = {}): any {
    const a = db.prepare("SELECT status, expected_impact, basis FROM decision_actions WHERE id = ? AND organization_id = ?").get(id, orgId) as any;
    if (!a) throw new Error("Ação não encontrada.");
    if (a.status !== "approved") throw new Error(`Só conclui ação aprovada (atual: ${a.status}).`);
    const result = opts.resultAmount != null ? Number(opts.resultAmount) : null;
    db.prepare("UPDATE decision_actions SET status = 'done', completed_at = CURRENT_TIMESTAMP, result_amount = ? WHERE id = ? AND organization_id = ?")
      .run(result, id, orgId);
    // Fecha o loop prometido×entregue no Impact Ledger unificado. Não falha a
    // conclusão se a medição der erro (a ação já está 'done').
    try {
      OutcomeMeasurementService.record(orgId, id, {
        expectedValue: a.expected_impact != null ? Number(a.expected_impact) : null,
        realizedValue: result,
        basis: a.basis || "estimate",
        measurementMethod: "self_reported",
        evidence: { source: "decision_action.complete" },
      });
    } catch (e) { /* medição é aditiva — nunca bloqueia a conclusão */ }
    return this.get(orgId, id);
  }
}

function safeParse(s: string): any { try { return JSON.parse(s); } catch { return null; } }

export default DecisionActionService;
