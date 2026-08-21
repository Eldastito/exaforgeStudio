import { randomUUID } from "crypto";
import db from "./db.js";
import { logAuthEvent } from "./auditLog.js";
import { BusinessSignalService } from "./BusinessSignalService.js";

/**
 * ConfirmationEngine — peça FINA que fecha o loop "ação disparada → resultado
 * comprovado" (ADR-152 F2.1, PRD §11.10).
 *
 * Regra do PRD: "uma operação NÃO é concluída apenas porque a ação foi
 * disparada." O executor pede `expect(method, deadline)` quando dispara algo
 * que precisa de confirmação externa; um subscriber (webhook do Asaas,
 * reconciliação Alterdata, resposta em canal, ...) chama `confirm(action,
 * evidence)` quando o fato acontece. Só então a `decision_action` (ADR-136)
 * fecha em `done` com `result_amount` (quando aplicável), e o processo
 * associado (ADR-152 F1.1) transiciona pra `completed`.
 *
 * Guardas:
 *   - UMA confirmação viva por ação (UNIQUE em action_confirmations). Chamar
 *     `expect` 2x para a mesma action retorna a existente (idempotente).
 *   - `confirm` sem `expect` prévio → 400 (o executor não fez a promessa;
 *     o subscriber não deve inventar).
 *   - `confirm` de ação já `done | rejected | cancelled` é NO-OP (webhook
 *     duplicado após rollback humano não reabre).
 *   - Isolado por `organization_id` (convenção nº 1) — subscriber que não
 *     souber a org NÃO pode fechar; recusa auditada.
 *
 * Métodos de confirmação registrados nesta fatia (a Fase 2.3 pluga os
 * subscribers reais):
 *   - `asaas_payment_webhook`  — webhook /api/webhooks/asaas
 *   - `retail_reconciliation`  — RetailFloorReconciliationService (ADR-150)
 *   - `channel_reply`          — resposta do cliente no webhookProcessor
 *   - `alterdata_sync`         — AlterdataSyncRunner (ADR-085 / ADR-105)
 *   - `manual`                 — dono confirma no painel
 *
 * `sweepTimeouts()` (chamado pelo Scheduler na Fase 2.3) fecha as pendentes
 * cujo `deadline_at` venceu como `timed_out` — a Fase 3 vai apresentar isso
 * na aba Operações como exceção "SLA em risco".
 */

export const CONFIRMATION_METHODS = [
  "asaas_payment_webhook",
  "gateway_payment_webhook",          // ADR-183 — cobrança de recebível pelo Eixo B (MP/Stone por-org)
  "retail_reconciliation",
  "channel_reply",
  "alterdata_sync",
  "manual",
  // ADR-162 F8 — resposta pública de reputação publicada; a confirmação de
  // FECHAMENTO (réplica do consumidor / caso resolvido) é armada aqui e
  // confirmada na F10 (réplica + closure). Aditivo, não altera métodos existentes.
  "reputation_reply",
  // ADR-167 F11 — publicação social realizada; a confirmação de RESULTADO
  // (engajamento/outcome medido) é armada aqui e resolvida na F12 (analytics→
  // outcome). PUBLISHED ≠ RESULTADO. Aditivo, não altera métodos existentes.
  "social_publish",
  // ADR-180 F4 — agendamento federado criado (appointment tied ao vínculo da rede);
  // a confirmação de RESULTADO (o especialista ATENDEU) é armada aqui com SLA. AGENDADO
  // ≠ ATENDIDO (RN-PN-5) — timeout publica sinal via sweepTimeouts, não trava a vaga.
  "booking_confirmation",
] as const;
export type ConfirmationMethod = (typeof CONFIRMATION_METHODS)[number];

export interface ExpectInput {
  actionId: string;
  method: ConfirmationMethod | string;
  deadlineAt?: string | null;
  externalRef?: string | null;   // ADR-152 F2.3: id externo (payment_id Asaas, message_id WhatsApp, ...)
}

export interface ConfirmInput {
  evidence?: any;
  resultAmount?: number | null;    // quando aplicável (cobrança: valor recebido)
  actorId?: string;
  // ADR-152 F3.1 — hint de categoria (revenue_recovered / cost_avoided /
  // time_saved / loss_prevented). Só quando o caller (webhook Asaas,
  // reconciliação Alterdata, ...) sabe atribuir. É propagado direto pro
  // OutcomeMeasurementService via DecisionActionService.complete.
  categoryOutcomes?: {
    timeSavedMinutes?: number | null;
    costAvoided?: number | null;
    revenueRecovered?: number | null;
    lossPrevented?: number | null;
  };
}

function safeParse(s: string | null | undefined): any { if (!s) return null; try { return JSON.parse(s); } catch { return null; } }

export class ConfirmationEngine {
  /**
   * Registra a expectativa de confirmação para uma ação APROVADA. Idempotente
   * por (org, action) — chamar 2x devolve a linha existente. `method` valida
   * contra CONFIRMATION_METHODS (bloqueio de subscriber desconhecido).
   */
  static expect(orgId: string, input: ExpectInput): any {
    if (!input?.actionId) throw new Error("actionId obrigatório.");
    if (!input?.method || !(CONFIRMATION_METHODS as readonly string[]).includes(input.method)) {
      throw new Error(`method inválido: ${input.method}`);
    }
    // Ação tem que existir na org (isolamento).
    const action = db.prepare(`SELECT id, status FROM decision_actions WHERE id = ? AND organization_id = ?`).get(input.actionId, orgId) as any;
    if (!action) throw new Error("Ação não encontrada.");

    const existing = db.prepare(`SELECT * FROM action_confirmations WHERE organization_id = ? AND action_id = ?`).get(orgId, input.actionId) as any;
    if (existing) {
      // Se o handler descobre o externalRef só na 1ª chamada (ex.: PIX
      // criado depois do expect vazio), permite fixar retroativamente numa
      // pending — mas nunca sobrescreve um externalRef já definido (evita
      // race de handler chamando 2x com refs diferentes).
      if (input.externalRef && !existing.external_ref && existing.status === "pending") {
        db.prepare(`UPDATE action_confirmations SET external_ref = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND organization_id = ?`).run(input.externalRef, existing.id, orgId);
        return this.get(orgId, existing.id);
      }
      return { ...existing, evidence: safeParse(existing.evidence_json) };
    }

    const id = randomUUID();
    db.prepare(`INSERT INTO action_confirmations (id, organization_id, action_id, confirmation_method, status, deadline_at, external_ref) VALUES (?, ?, ?, ?, 'pending', ?, ?)`)
      .run(id, orgId, input.actionId, input.method, input.deadlineAt || null, input.externalRef || null);
    try { logAuthEvent(orgId, null, null, "RUNTIME_CONFIRMATION_EXPECT", { actionId: input.actionId, method: input.method, deadlineAt: input.deadlineAt || null, externalRef: input.externalRef || null }); } catch { /* noop */ }
    return this.get(orgId, id);
  }

  /**
   * Resolve uma confirmação PENDENTE pelo id externo — chamado por
   * subscribers que recebem só o id externo (webhook Asaas conhece
   * payment.id, não org). Sem match: null. Cross-org: uma única confirmação
   * pode existir por (org, method, external_ref) — o UNIQUE parcial do
   * schema garante. Retorna `{orgId, confirmation}`.
   */
  static findByExternalRef(method: ConfirmationMethod | string, externalRef: string): { orgId: string; confirmation: any } | null {
    if (!externalRef) return null;
    const row = db.prepare(`SELECT * FROM action_confirmations WHERE confirmation_method = ? AND external_ref = ? AND status = 'pending' LIMIT 1`).get(method, externalRef) as any;
    if (!row) return null;
    return { orgId: row.organization_id, confirmation: { ...row, evidence: safeParse(row.evidence_json) } };
  }

  static get(orgId: string, id: string): any | null {
    const row = db.prepare(`SELECT * FROM action_confirmations WHERE id = ? AND organization_id = ?`).get(id, orgId) as any;
    if (!row) return null;
    return { ...row, evidence: safeParse(row.evidence_json) };
  }

  static getForAction(orgId: string, actionId: string): any | null {
    const row = db.prepare(`SELECT * FROM action_confirmations WHERE organization_id = ? AND action_id = ?`).get(orgId, actionId) as any;
    if (!row) return null;
    return { ...row, evidence: safeParse(row.evidence_json) };
  }

  static listPending(orgId: string, opts: { method?: string; limit?: number } = {}): any[] {
    let sql = `SELECT * FROM action_confirmations WHERE organization_id = ? AND status = 'pending'`;
    const params: any[] = [orgId];
    if (opts.method) { sql += ` AND confirmation_method = ?`; params.push(opts.method); }
    sql += ` ORDER BY expected_at ASC LIMIT ?`;
    params.push(Math.min(Math.max(Number(opts.limit) || 200, 1), 500));
    return (db.prepare(sql).all(...params) as any[]).map((r) => ({ ...r, evidence: safeParse(r.evidence_json) }));
  }

  /**
   * Confirma a ação (fecha o loop). Chama `DecisionActionService.complete`
   * (ADR-136 D6 — outcome esperado × realizado com evidência) — a
   * `decision_actions` fica `done` e o `action_outcomes` registra o
   * realizado. Se a ação está amarrada a um `process_instance` (ADR-152 F1.1
   * via `decision_actions.process_instance_id`), transiciona o processo
   * associado — a Fase 2.2 do executor vai amarrar o passo do playbook.
   *
   * Idempotência crítica pra webhook (Asaas pode chegar 2x):
   *   - Já `confirmed` → retorna a linha existente (NÃO reabre).
   *   - Ação já `done | rejected | cancelled` → marca a confirmação como
   *     `dismissed` (auditado) e retorna — não reprocessa outcome.
   */
  static confirm(orgId: string, actionId: string, input: ConfirmInput = {}): any {
    const conf = this.getForAction(orgId, actionId);
    if (!conf) throw new Error("Nenhuma confirmação pendente para esta ação.");
    if (conf.status === "confirmed") return conf; // idempotente
    if (conf.status !== "pending") throw new Error(`Confirmação não está pendente (${conf.status}).`);

    const action = db.prepare(`SELECT id, status FROM decision_actions WHERE id = ? AND organization_id = ?`).get(actionId, orgId) as any;
    if (!action) throw new Error("Ação não encontrada.");

    // Ação já resolvida (rollback humano, cancelamento) — não reabre.
    if (["done", "rejected", "cancelled"].includes(action.status)) {
      db.prepare(`UPDATE action_confirmations SET status = 'dismissed', updated_at = CURRENT_TIMESTAMP, evidence_json = ? WHERE id = ? AND organization_id = ?`)
        .run(JSON.stringify({ dismissedReason: `action_${action.status}`, incoming: input.evidence ?? null }), conf.id, orgId);
      try { logAuthEvent(orgId, input.actorId || null, null, "RUNTIME_CONFIRMATION_DISMISSED", { actionId, actionStatus: action.status }); } catch { /* noop */ }
      return this.get(orgId, conf.id);
    }

    // Ação ainda não está aprovada (o executor não deveria ter chamado
    // expect) — auditamos e não fechamos, mas gravamos o `pending` como
    // registrado pra a Fase 3 exibir a inconsistência.
    if (action.status !== "approved") {
      db.prepare(`UPDATE action_confirmations SET evidence_json = ? WHERE id = ? AND organization_id = ?`)
        .run(JSON.stringify({ warning: `action_status_${action.status}`, incoming: input.evidence ?? null }), conf.id, orgId);
      throw new Error(`Ação não está aprovada (${action.status}) — não posso concluir.`);
    }

    const tx = db.transaction(() => {
      db.prepare(`UPDATE action_confirmations SET status = 'confirmed', confirmed_at = CURRENT_TIMESTAMP, evidence_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND organization_id = ?`)
        .run(input.evidence != null ? JSON.stringify(input.evidence) : null, conf.id, orgId);
    });
    tx();

    // Fecha a ação (ADR-136 D6) — outcome esperado × realizado é registrado
    // automaticamente pelo DecisionActionService.complete. Import dinâmico
    // pra quebrar ciclo (DecisionAction usa OutcomeMeasurement, que pode
    // usar este service no futuro).
    (async () => {
      try {
        const { DecisionActionService } = await import("./DecisionActionService.js");
        DecisionActionService.complete(orgId, actionId, {
          resultAmount: input.resultAmount ?? null,
          categoryOutcomes: input.categoryOutcomes,
        });
      } catch (e) {
        console.error("[ConfirmationEngine] falha ao concluir ação após confirm", actionId, e);
      }
    })();

    try { logAuthEvent(orgId, input.actorId || null, null, "RUNTIME_CONFIRMATION_CONFIRMED", { actionId, method: conf.confirmation_method, resultAmount: input.resultAmount ?? null }); } catch { /* noop */ }
    return this.get(orgId, conf.id);
  }

  /**
   * Dismisso HUMANO (dono decide que a confirmação não vai vir — ex.: cobrança
   * cancelada por acordo manual fora do sistema). Não fecha a ação (que
   * também será cancelada/completada por outro caminho).
   */
  static dismiss(orgId: string, actionId: string, opts: { reason?: string; actorId?: string } = {}): any {
    const conf = this.getForAction(orgId, actionId);
    if (!conf) throw new Error("Nenhuma confirmação registrada para esta ação.");
    if (conf.status !== "pending") throw new Error(`Confirmação não está pendente (${conf.status}).`);
    db.prepare(`UPDATE action_confirmations SET status = 'dismissed', updated_at = CURRENT_TIMESTAMP, evidence_json = ? WHERE id = ? AND organization_id = ?`)
      .run(JSON.stringify({ dismissedReason: opts.reason || "manual" }), conf.id, orgId);
    try { logAuthEvent(orgId, opts.actorId || null, null, "RUNTIME_CONFIRMATION_DISMISSED", { actionId, reason: opts.reason || "manual" }); } catch { /* noop */ }
    return this.get(orgId, conf.id);
  }

  /**
   * Fecha por timeout as pendentes cujo `deadline_at` já passou. Best-effort,
   * idempotente. Chamado pelo Scheduler.confirmationTimeoutPass na Fase 2.3.
   * Retorna quantas foram fechadas.
   */
  static sweepTimeouts(orgId?: string): number {
    // ADR-165 F7 — antes de fechar por timeout, CAPTURA as pendentes que vão vencer, pra
    // publicar a exceção de SLA em business_signals (aparece em attention()). A auditoria
    // F0 achou que o timeout era marcado mas NÃO fluía pra atenção (gap de integração).
    let selSql = `SELECT c.id, c.organization_id, c.action_id, c.confirmation_method, c.deadline_at,
                         a.correlation_id, a.domain, a.title
                    FROM action_confirmations c
                    LEFT JOIN decision_actions a ON a.id = c.action_id AND a.organization_id = c.organization_id
                   WHERE c.status = 'pending' AND c.deadline_at IS NOT NULL AND datetime(c.deadline_at) <= CURRENT_TIMESTAMP`;
    const selParams: any[] = [];
    if (orgId) { selSql += ` AND c.organization_id = ?`; selParams.push(orgId); }
    const timing = db.prepare(selSql).all(...selParams) as any[];

    // `datetime(deadline_at)` faz o parse aceitando tanto ISO 8601 (com T e
    // millis) quanto o formato do SQLite (`YYYY-MM-DD HH:MM:SS`). Sem isso a
    // comparação textual direta contra CURRENT_TIMESTAMP falha em ISO.
    let sql = `UPDATE action_confirmations SET status = 'timed_out', updated_at = CURRENT_TIMESTAMP WHERE status = 'pending' AND deadline_at IS NOT NULL AND datetime(deadline_at) <= CURRENT_TIMESTAMP`;
    const params: any[] = [];
    if (orgId) { sql += ` AND organization_id = ?`; params.push(orgId); }
    const r = db.prepare(sql).run(...params);

    // Publica a exceção de SLA (best-effort, nunca quebra o sweep — convenção 7).
    // dedupeKey por confirmação: idempotente (uma exceção por confirmação vencida).
    for (const c of timing) {
      try {
        BusinessSignalService.publish(c.organization_id, {
          domain: "outcome_assurance",
          signalType: "confirmation_timed_out",
          severity: "risk",                    // SLA de confirmação estourado é risco (efeito não veio)
          basis: "fact",
          confidence: 1,
          sourceService: "ConfirmationEngine.sweepTimeouts",
          sourceEntityType: "action_confirmation",
          sourceEntityId: c.id,
          subjectType: "decision_action",
          subjectId: c.action_id,
          correlationId: c.correlation_id || null,
          evidence: { confirmationId: c.id, actionId: c.action_id, method: c.confirmation_method, deadlineAt: c.deadline_at, domain: c.domain, title: c.title, gap: "confirmation_timed_out" },
          dedupeKey: `outcome_assurance:confirmation_timed_out:${c.id}`,
        });
      } catch { /* best-effort */ }
    }
    return r.changes || 0;
  }
}

export default ConfirmationEngine;
