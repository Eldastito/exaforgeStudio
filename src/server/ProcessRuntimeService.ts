import { randomUUID } from "crypto";
import db from "./db.js";
import { logAuthEvent } from "./auditLog.js";
import {
  PlaybookDefinition,
  validateDefinition,
  firstStep,
  findStep,
  chooseNextStep,
  evaluateCondition,
} from "./PlaybookEngine.js";

/**
 * ProcessRuntimeService — Process Fabric do Execution Runtime (ADR-152 F1.1).
 *
 * Amarra o gap central do PRD: a unidade de trabalho passa de "ação única"
 * (ADR-136 D5) para PROCESSO com N etapas encadeadas por regras. O Runtime
 * NÃO executa comandos aqui — isso é da Fase 2 (`CommandExecutorService.
 * execute`). Nesta fatia entregamos a FSM válida, a instância persistida, a
 * ligação action↔process (nullable, retrocompatível) e o `advance` que
 * decide qual é o próximo passo — pra Fase 2 conectar o executor real.
 *
 * FSM (PRD §11.4) — validada por `transition`, transições inválidas 400:
 *   detected     → planned | cancelled
 *   planned      → awaiting_approval | authorized | cancelled | failed
 *   awaiting_approval → authorized | cancelled | escalated
 *   authorized   → queued | cancelled
 *   queued       → executing | cancelled
 *   executing    → waiting_external_response | completed | failed | retry_scheduled | escalated
 *   waiting_external_response → completed | failed | retry_scheduled | escalated
 *   retry_scheduled → queued | escalated | failed | cancelled
 *   escalated    → authorized | cancelled | completed | failed
 *   failed       → queued | cancelled | escalated | measured
 *   completed    → measured
 *   cancelled    → (terminal)
 *   measured     → (terminal)
 *
 * TODA transição é auditada em `process_transitions` (ator, motivo,
 * evidência). TODA query filtra `organization_id` (convenção nº 1). Feature
 * flag `execution_runtime_enabled` da org é checada NA ROTA — o service não
 * decide sobre autorização; ele só valida invariantes de negócio.
 */

// ── FSM ─────────────────────────────────────────────────────────────────

// Estados TERMINAIS pro RUNNER (advance/completeStep). `completed` e `failed`
// ainda podem transicionar (completed → measured; failed → queued/escalated/
// cancelled/measured) — a validação de transição usa TRANSITIONS.
// Mas o runner não deve tentar advance/completeStep sobre eles.
const TERMINAL = new Set(["cancelled", "measured", "completed", "failed"]);
const VALID_STATES = new Set([
  "detected", "planned", "awaiting_approval", "authorized", "queued",
  "executing", "waiting_external_response", "retry_scheduled", "escalated",
  "completed", "failed", "cancelled", "measured",
]);

const TRANSITIONS: Record<string, Set<string>> = {
  detected: new Set(["planned", "cancelled"]),
  planned: new Set(["awaiting_approval", "authorized", "cancelled", "failed"]),
  awaiting_approval: new Set(["authorized", "cancelled", "escalated"]),
  authorized: new Set(["queued", "cancelled"]),
  queued: new Set(["executing", "cancelled"]),
  executing: new Set(["waiting_external_response", "completed", "failed", "retry_scheduled", "escalated"]),
  waiting_external_response: new Set(["completed", "failed", "retry_scheduled", "escalated"]),
  retry_scheduled: new Set(["queued", "escalated", "failed", "cancelled"]),
  escalated: new Set(["authorized", "cancelled", "completed", "failed"]),
  failed: new Set(["queued", "cancelled", "escalated", "measured"]),
  completed: new Set(["measured"]),
  cancelled: new Set(),
  measured: new Set(),
};

function isValidTransition(from: string, to: string): boolean {
  return TRANSITIONS[from]?.has(to) === true;
}

// ── Tipos de entrada ────────────────────────────────────────────────────

export interface DefineProcessInput {
  processType: string;
  name: string;
  description?: string;
  triggerType?: string;
  objective?: string;
  autonomyLevelDefault?: string;   // observe|suggest|prepare|execute
  slaDefinition?: any;
  entryConditions?: any;
  successConditions?: any;
  failureConditions?: any;
  escalationPolicy?: any;
  steps: PlaybookDefinition;        // será validado pelo PlaybookEngine
  active?: boolean;
}

export interface StartProcessInput {
  processType: string;
  subjectType?: string;
  subjectId?: string;
  priority?: number;
  riskLevel?: string;               // low|medium|high
  expectedValue?: number;
  context?: any;
  deadlineAt?: string | null;
  createdBy?: string;
  correlationId?: string | null;    // PRD 2 F2.3 — fio da espinha (ADR-158)
}

const AUTONOMY_LEVELS = new Set(["observe", "suggest", "prepare", "execute"]);
const RISK_LEVELS = new Set(["low", "medium", "high"]);

function safeParse(s: string | null | undefined): any { if (!s) return {}; try { return JSON.parse(s); } catch { return {}; } }

export class ProcessRuntimeService {
  // ── Definitions ─────────────────────────────────────────────────────

  /**
   * Registra uma nova versão do processo. Bloqueia `steps` inválido (o custo
   * de descobrir a `next` inexistente rodando em produção é alto demais).
   * A versão nasce como o número atual + 1 da (org, processType) — assim
   * versionamento é automático e trivialmente auditável.
   */
  static defineProcess(orgId: string, input: DefineProcessInput, actorId?: string): any {
    if (!input?.processType?.trim()) throw new Error("processType obrigatório.");
    if (!input?.name?.trim()) throw new Error("name obrigatório.");
    if (input?.autonomyLevelDefault && !AUTONOMY_LEVELS.has(input.autonomyLevelDefault)) throw new Error(`autonomyLevelDefault inválido: ${input.autonomyLevelDefault}`);
    const check = validateDefinition(input.steps);
    if (!check.ok) throw new Error(`steps inválido: ${check.errors.map((e) => `${e.path}: ${e.message}`).join("; ")}`);

    const id = randomUUID();
    const last = db.prepare(`SELECT MAX(version) v FROM process_definitions WHERE organization_id = ? AND process_type = ?`).get(orgId, input.processType) as any;
    const version = Number(last?.v || 0) + 1;
    db.prepare(`INSERT INTO process_definitions
      (id, organization_id, process_type, name, description, version, trigger_type, objective, autonomy_level_default, sla_definition_json, entry_conditions_json, success_conditions_json, failure_conditions_json, escalation_policy_json, steps_json, active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, orgId, input.processType.trim(), input.name.trim(), input.description || null, version,
      input.triggerType || null, input.objective || null, input.autonomyLevelDefault || "suggest",
      input.slaDefinition != null ? JSON.stringify(input.slaDefinition) : null,
      input.entryConditions != null ? JSON.stringify(input.entryConditions) : null,
      input.successConditions != null ? JSON.stringify(input.successConditions) : null,
      input.failureConditions != null ? JSON.stringify(input.failureConditions) : null,
      input.escalationPolicy != null ? JSON.stringify(input.escalationPolicy) : null,
      JSON.stringify(input.steps),
      input.active === false ? 0 : 1
    );
    try { logAuthEvent(orgId, actorId || null, null, "RUNTIME_PROCESS_DEFINE", { definitionId: id, processType: input.processType, version }); } catch { /* noop */ }
    return this.getDefinition(orgId, id);
  }

  static getDefinition(orgId: string, id: string): any | null {
    const row = db.prepare(`SELECT * FROM process_definitions WHERE id = ? AND organization_id = ?`).get(id, orgId) as any;
    if (!row) return null;
    return { ...row, steps: safeParse(row.steps_json), sla_definition: safeParse(row.sla_definition_json) };
  }

  /** Lista definições ativas por org (opcional: por tipo — retorna todas as versões ativas). */
  static listDefinitions(orgId: string, opts: { processType?: string; includeInactive?: boolean } = {}): any[] {
    let sql = `SELECT id, process_type, name, description, version, trigger_type, objective, autonomy_level_default, active, created_at FROM process_definitions WHERE organization_id = ?`;
    const params: any[] = [orgId];
    if (opts.processType) { sql += ` AND process_type = ?`; params.push(opts.processType); }
    if (!opts.includeInactive) sql += ` AND active = 1`;
    sql += ` ORDER BY process_type ASC, version DESC LIMIT 200`;
    return db.prepare(sql).all(...params) as any[];
  }

  /** Ativa/desativa uma versão. A versão desativada some do `latestActive` mas fica no histórico. */
  static setActive(orgId: string, definitionId: string, active: boolean, actorId?: string): any {
    const r = db.prepare(`UPDATE process_definitions SET active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND organization_id = ?`).run(active ? 1 : 0, definitionId, orgId);
    if (!r.changes) throw new Error("Definição não encontrada.");
    try { logAuthEvent(orgId, actorId || null, null, "RUNTIME_PROCESS_SET_ACTIVE", { definitionId, active }); } catch { /* noop */ }
    return this.getDefinition(orgId, definitionId);
  }

  /**
   * Versão ativa mais nova de um processType. Se `startForSubject` for
   * chamado sem definitionId, é isto que ele resolve — assim o consumidor não
   * precisa saber a versão exata (rollout aditivo).
   */
  static latestActiveDefinition(orgId: string, processType: string): any | null {
    const row = db.prepare(`SELECT * FROM process_definitions WHERE organization_id = ? AND process_type = ? AND active = 1 ORDER BY version DESC LIMIT 1`).get(orgId, processType) as any;
    if (!row) return null;
    return { ...row, steps: safeParse(row.steps_json) };
  }

  // ── Instances ───────────────────────────────────────────────────────

  /**
   * Cria uma instância NO ESTADO `detected` (PRD §11.4 — porta de entrada), já
   * amarrada à versão ativa mais nova do processType da org. `context` é o
   * conjunto de entradas que os steps vão avaliar (subject + payload do sinal
   * + o que mais o chamador quiser). NUNCA duplica se `subject_id` já tem
   * instância viva do mesmo processType (idempotência conservadora — o
   * chamador cancela a viva antes ou trata a duplicação como no-op).
   */
  static startForSubject(orgId: string, input: StartProcessInput, actorId?: string): any {
    if (!input?.processType?.trim()) throw new Error("processType obrigatório.");
    if (input?.riskLevel && !RISK_LEVELS.has(input.riskLevel)) throw new Error(`riskLevel inválido: ${input.riskLevel}`);
    const def = this.latestActiveDefinition(orgId, input.processType);
    if (!def) throw new Error(`Nenhuma versão ativa de "${input.processType}".`);

    if (input.subjectType && input.subjectId) {
      const live = db.prepare(
        `SELECT id, status FROM process_instances WHERE organization_id = ? AND process_type = ? AND subject_type = ? AND subject_id = ?
         AND status NOT IN ('completed','failed','cancelled','measured') LIMIT 1`
      ).get(orgId, input.processType, input.subjectType, input.subjectId) as any;
      if (live) return this.getInstance(orgId, live.id);
    }

    const id = randomUUID();
    const context = input.context ?? {};
    const first = firstStep(def.steps as PlaybookDefinition);
    db.prepare(`INSERT INTO process_instances
      (id, organization_id, process_definition_id, process_type, subject_type, subject_id, status, priority, risk_level, expected_value, current_step, context_json, deadline_at, created_by, correlation_id)
      VALUES (?, ?, ?, ?, ?, ?, 'detected', ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, orgId, def.id, input.processType, input.subjectType || null, input.subjectId || null,
      Number(input.priority) || 0, input.riskLevel || null,
      input.expectedValue != null ? Number(input.expectedValue) : null,
      first.id, JSON.stringify(context), input.deadlineAt || null, input.createdBy || actorId || null, input.correlationId || null
    );
    this.logTransition(orgId, id, null, "detected", actorId || "runtime", "instance_created", { processType: input.processType, definitionId: def.id, version: def.version, subjectType: input.subjectType || null, subjectId: input.subjectId || null });
    return this.getInstance(orgId, id);
  }

  /**
   * Cria uma instância a partir de um sinal do `business_signals` (ADR-136).
   * Passa a evidência do sinal como context inicial — a Fase 2 vai usar isso
   * pra decidir a política, prazo, etc.
   */
  static startFromSignal(orgId: string, signalId: string, input: Omit<StartProcessInput, "context"> & { context?: any }, actorId?: string): any {
    const sig = db.prepare(`SELECT id, domain, signal_type, severity, evidence_json, impact_amount, impact_unit, correlation_id FROM business_signals WHERE id = ? AND organization_id = ?`).get(signalId, orgId) as any;
    if (!sig) throw new Error("Sinal não encontrado.");
    const evidence = safeParse(sig.evidence_json);
    const context = { ...(input.context || {}), signal: { id: sig.id, domain: sig.domain, type: sig.signal_type, severity: sig.severity, impactAmount: sig.impact_amount, impactUnit: sig.impact_unit, evidence } };
    // F2.3 — o processo herda o correlation_id do sinal (ou enraíza no próprio id
    // do sinal, mesma convenção do BusinessSignalService), fechando a espinha.
    const correlationId = input.correlationId ?? sig.correlation_id ?? sig.id;
    return this.startForSubject(orgId, { ...input, context, correlationId, expectedValue: input.expectedValue ?? sig.impact_amount ?? null }, actorId);
  }

  /**
   * Transiciona a instância pra `toState`, validando contra a FSM. `evidence`
   * (opcional) vai pra `process_transitions.evidence_json` — sempre auditado.
   * `stepResult` (opcional) é acumulado em `context.results[current_step]` —
   * o próximo `advance` usa isso pra decidir a rota.
   */
  static transition(orgId: string, instanceId: string, toState: string, opts: { actor?: string; reason?: string; evidence?: any; stepResult?: any } = {}): any {
    if (!VALID_STATES.has(toState)) throw new Error(`Estado inválido: ${toState}`);
    const inst = db.prepare(`SELECT id, status, context_json, current_step FROM process_instances WHERE id = ? AND organization_id = ?`).get(instanceId, orgId) as any;
    if (!inst) throw new Error("Instância não encontrada.");
    if (!isValidTransition(inst.status, toState)) throw new Error(`Transição inválida: ${inst.status} → ${toState}`);

    const nowTerminal = TERMINAL.has(toState);
    let newContext = inst.context_json;
    if (opts.stepResult !== undefined && inst.current_step) {
      const ctx = safeParse(inst.context_json);
      ctx.results = ctx.results || {};
      ctx.results[inst.current_step] = opts.stepResult;
      newContext = JSON.stringify(ctx);
    }

    const completedAt = toState === "completed" || toState === "measured" ? new Date().toISOString() : null;
    const failedAt = toState === "failed" ? new Date().toISOString() : null;

    db.prepare(`UPDATE process_instances
      SET status = ?, context_json = ?, completed_at = COALESCE(completed_at, ?), failed_at = COALESCE(failed_at, ?), updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND organization_id = ?`)
      .run(toState, newContext, completedAt, failedAt, instanceId, orgId);

    this.logTransition(orgId, instanceId, inst.status, toState, opts.actor || "runtime", opts.reason || null, opts.evidence ?? null);
    void nowTerminal; // terminal só pra clareza semântica — nada de auto-limpeza aqui
    return this.getInstance(orgId, instanceId);
  }

  /**
   * `advance` — decide o PRÓXIMO PASSO (não executa). Retorna o step a ser
   * disparado + a decisão do playbook. O executor (Fase 2) consome isso e
   * chama de volta com `transition(instance, 'executing'|'completed'|...)`.
   *
   * Nesta fatia (F1.1) o método é o cérebro da FSM que a Fase 2 vai plugar:
   *   1. Se instância está `detected`, decide próximo estado como `planned` e
   *      devolve o primeiro step.
   *   2. Se instância está `planned`/`queued`/`executing`, devolve o step
   *      atual (o executor vai rodar o commandType).
   *   3. Se `waiting_external_response`, informa que está esperando (nada
   *      a fazer — a Confirmation Engine da Fase 2 vai transicionar).
   *   4. Terminal → sem próxima ação.
   *
   * Onde a FSM decide fim: se o step atual apontou "$end" via
   * `chooseNextStep`, marca `completed` (sucesso do playbook).
   */
  static advance(orgId: string, instanceId: string): { instance: any; nextStep: any | null; waitingFor?: string; done?: boolean } {
    const inst = this.getInstance(orgId, instanceId);
    if (!inst) throw new Error("Instância não encontrada.");
    if (TERMINAL.has(inst.status)) return { instance: inst, nextStep: null, done: true };

    const def = this.getDefinition(orgId, inst.process_definition_id);
    if (!def) throw new Error("Definição não encontrada (referência quebrada).");

    // detected → planned (avança pra fase de execução; carrega o 1º step).
    if (inst.status === "detected") {
      const first = firstStep(def.steps as PlaybookDefinition);
      const updated = this.transition(orgId, instanceId, "planned", { actor: "runtime", reason: "planning_started" });
      return { instance: updated, nextStep: first };
    }

    if (inst.status === "waiting_external_response") {
      return { instance: inst, nextStep: null, waitingFor: inst.current_step };
    }

    // Cabeça do playbook está no current_step — o executor da Fase 2 pega isso.
    const step = inst.current_step ? findStep(def.steps as PlaybookDefinition, inst.current_step) : null;
    if (!step) {
      // current_step inválido → falha auditada em vez de silêncio.
      const updated = this.transition(orgId, instanceId, "failed", { actor: "runtime", reason: "current_step_missing", evidence: { current_step: inst.current_step } });
      return { instance: updated, nextStep: null, done: true };
    }
    return { instance: inst, nextStep: step };
  }

  /**
   * Marca o step atual como concluído pelo executor (F2) e escolhe o
   * próximo. `stepResult` alimenta o contexto pra o playbook decidir a rota.
   * `success` (default true) determina se o processo continua ou vai a
   * `failed`/onFailure do step.
   */
  static completeStep(orgId: string, instanceId: string, opts: { stepResult?: any; success?: boolean; evidence?: any; actor?: string }): any {
    const inst = this.getInstance(orgId, instanceId);
    if (!inst) throw new Error("Instância não encontrada.");
    if (TERMINAL.has(inst.status)) throw new Error(`Instância já terminal (${inst.status}).`);
    const def = this.getDefinition(orgId, inst.process_definition_id);
    if (!def) throw new Error("Definição não encontrada.");
    const step = inst.current_step ? findStep(def.steps as PlaybookDefinition, inst.current_step) : null;
    if (!step) throw new Error("current_step não localizado.");

    const success = opts.success !== false;
    const ctxAfter = { ...safeParse(inst.context_json), results: { ...(safeParse(inst.context_json).results || {}), [step.id]: opts.stepResult } };

    if (!success) {
      // onFailure decide o destino: `fail` → failed; `fallback` → segue no
      // fallbackStep (mesma FSM: fica em `executing` até o próximo callback);
      // `escalate` → escalated.
      const mode = step.onFailure || "fail";
      if (mode === "escalate") return this.transition(orgId, instanceId, "escalated", { actor: opts.actor || "runtime", reason: "step_failed_escalate", evidence: opts.evidence, stepResult: opts.stepResult });
      if (mode === "fallback" && step.fallbackStep) {
        db.prepare(`UPDATE process_instances SET current_step = ?, context_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND organization_id = ?`).run(step.fallbackStep, JSON.stringify(ctxAfter), instanceId, orgId);
        this.logTransition(orgId, instanceId, inst.status, inst.status, opts.actor || "runtime", "step_failed_fallback", { failedStep: step.id, fallbackStep: step.fallbackStep });
        return this.getInstance(orgId, instanceId);
      }
      return this.transition(orgId, instanceId, "failed", { actor: opts.actor || "runtime", reason: "step_failed", evidence: opts.evidence, stepResult: opts.stepResult });
    }

    // Sucesso do step + successCondition: se a condição foi definida e falhar,
    // tratamos como falha (semântica do PRD §11.3 success_condition).
    if (step.successCondition && !evaluateCondition(step.successCondition, ctxAfter)) {
      return this.transition(orgId, instanceId, "failed", { actor: opts.actor || "runtime", reason: "success_condition_failed", evidence: { condition: step.successCondition, ctx: ctxAfter.results?.[step.id] }, stepResult: opts.stepResult });
    }

    const nextId = chooseNextStep(def.steps as PlaybookDefinition, step.id, ctxAfter);
    if (nextId === "$end") {
      // Fim do playbook → completed. Contexto acumulado vira result_json.
      db.prepare(`UPDATE process_instances SET context_json = ?, result_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND organization_id = ?`).run(JSON.stringify(ctxAfter), JSON.stringify(ctxAfter.results || {}), instanceId, orgId);
      return this.transition(orgId, instanceId, "completed", { actor: opts.actor || "runtime", reason: "playbook_completed", evidence: opts.evidence });
    }
    // Avança pro próximo step, mantendo `executing` (F2 dispara o novo step).
    db.prepare(`UPDATE process_instances SET current_step = ?, context_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND organization_id = ?`).run(nextId, JSON.stringify(ctxAfter), instanceId, orgId);
    this.logTransition(orgId, instanceId, inst.status, inst.status, opts.actor || "runtime", "step_completed", { completedStep: step.id, nextStep: nextId });
    return this.getInstance(orgId, instanceId);
  }

  /** Cancela uma instância viva. Terminal → 400. */
  static cancel(orgId: string, instanceId: string, opts: { actor?: string; reason?: string } = {}): any {
    return this.transition(orgId, instanceId, "cancelled", { actor: opts.actor || "runtime", reason: opts.reason || "cancelled_by_user" });
  }

  static getInstance(orgId: string, instanceId: string): any | null {
    const row = db.prepare(`SELECT * FROM process_instances WHERE id = ? AND organization_id = ?`).get(instanceId, orgId) as any;
    if (!row) return null;
    return { ...row, context: safeParse(row.context_json), result: safeParse(row.result_json) };
  }

  static listInstances(orgId: string, opts: { status?: string; processType?: string; subjectType?: string; subjectId?: string; limit?: number } = {}): any[] {
    let sql = `SELECT * FROM process_instances WHERE organization_id = ?`;
    const params: any[] = [orgId];
    if (opts.status) { sql += ` AND status = ?`; params.push(opts.status); }
    if (opts.processType) { sql += ` AND process_type = ?`; params.push(opts.processType); }
    if (opts.subjectType) { sql += ` AND subject_type = ?`; params.push(opts.subjectType); }
    if (opts.subjectId) { sql += ` AND subject_id = ?`; params.push(opts.subjectId); }
    sql += ` ORDER BY started_at DESC LIMIT ?`;
    params.push(Math.min(Math.max(Number(opts.limit) || 100, 1), 500));
    return (db.prepare(sql).all(...params) as any[]).map((r) => ({ ...r, context: safeParse(r.context_json), result: safeParse(r.result_json) }));
  }

  /** Auditoria de uma transição (ADR-152 D2 — toda transição relevante audita). */
  private static logTransition(orgId: string, instanceId: string, from: string | null, to: string, actor: string, reason: string | null, evidence: any): void {
    try {
      db.prepare(`INSERT INTO process_transitions (id, organization_id, process_instance_id, from_state, to_state, actor, reason, evidence_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(randomUUID(), orgId, instanceId, from, to, actor, reason, evidence != null ? JSON.stringify(evidence) : null);
    } catch (e) { /* auditoria é aditiva; nunca bloqueia a transição */ }
    // logAuthEvent complementa a trilha (fora da tabela de processo).
    try { logAuthEvent(orgId, actor && actor !== "runtime" && actor !== "system" ? actor : null, null, "RUNTIME_TRANSITION", { instanceId, from, to, reason }); } catch { /* noop */ }
  }

  /** Lista as transições (ordem cronológica) — timeline pra UI/depuração. */
  static listTransitions(orgId: string, instanceId: string): any[] {
    return (db.prepare(`SELECT * FROM process_transitions WHERE organization_id = ? AND process_instance_id = ? ORDER BY occurred_at ASC`).all(orgId, instanceId) as any[])
      .map((r) => ({ ...r, evidence: safeParse(r.evidence_json) }));
  }

  /**
   * Runner do playbook (ADR-152 Fatia 4a — amarra advance → execute →
   * completeStep). Uma iteração:
   *
   *   1. advance(instance) → nextStep (o service transiciona detected→planned).
   *   2. Se terminal (done/failed/cancelled/measured) ou waiting → retorna sem
   *      criar action (o playbook pausa aguardando evento externo).
   *   3. Cria DecisionAction com commandType=nextStep.commandType +
   *      payload={ instanceId, ...context da instância }. Approve
   *      internamente (o dispatch roda como "runtime"; políticas da org
   *      podem rejeitar via 3 guardas do executor F2.2).
   *   4. CommandExecutorService.execute(action). Se falhar (guardas ou
   *      handler), transiciona instance pra `failed` com evidência —
   *      auditado em process_transitions + action_execution_log.
   *   5. completeStep(instance, { stepResult: result.result }) — roteia
   *      pro próximo step conforme o playbook.
   *
   * Import dinâmicos pra quebrar ciclos (CommandExecutorService importa
   * ApprovalPolicyService que importa DecisionActionService via outros
   * caminhos). Isolado por org (convenção nº 1). Idempotente por step
   * (o executor já é idempotente via UNIQUE de action_confirmations e
   * o próprio ProcessRuntimeService só transiciona uma vez).
   */
  static async runStep(orgId: string, instanceId: string, actorId?: string): Promise<{ instance: any; nextStep: any | null; result?: any; done?: boolean; waitingFor?: string }> {
    const [{ DecisionActionService }, { CommandExecutorService }] = await Promise.all([
      import("./DecisionActionService.js"),
      import("./CommandExecutorService.js"),
    ]);
    const adv = this.advance(orgId, instanceId);
    if (adv.done || !adv.nextStep) return { instance: adv.instance, nextStep: null, done: true, waitingFor: adv.waitingFor };
    // Ao rodar o 1º step (recém-planned), transicionamos pra executing
    // pra sinalizar no FSM. Se já está executing (2º+ step), OK.
    const cur = adv.instance;
    if (cur.status === "planned") {
      try {
        this.transition(orgId, instanceId, "authorized", { actor: actorId || "runtime", reason: "runner_authorized" });
        this.transition(orgId, instanceId, "queued", { actor: actorId || "runtime", reason: "runner_queued" });
        this.transition(orgId, instanceId, "executing", { actor: actorId || "runtime", reason: "runner_executing" });
      } catch { /* transição já feita por outro caller */ }
    }
    const step = adv.nextStep;
    const inst = this.getInstance(orgId, instanceId)!;
    const payload = { ...(inst.context || {}), instanceId };

    const proposed = DecisionActionService.propose(orgId, {
      domain: "runtime", actionType: `runtime_step_${step.id}`.slice(0, 60), title: `Runtime step ${step.id} (inst ${instanceId.slice(0, 8)})`,
      commandType: step.commandType, commandPayload: payload,
      basis: "fact",
    });
    if (proposed.status !== "approved") DecisionActionService.approve(orgId, proposed.id, actorId || "runtime");

    let result: any = null;
    try {
      result = await CommandExecutorService.execute(orgId, proposed.id);
    } catch (e: any) {
      this.transition(orgId, instanceId, "failed", { actor: actorId || "runtime", reason: "step_execute_failed", evidence: { stepId: step.id, error: String(e?.message || e), actionId: proposed.id }, stepResult: null });
      return { instance: this.getInstance(orgId, instanceId), nextStep: null, done: true, result: { error: String(e?.message || e) } };
    }
    // O result do executor traz .result = ExecutedResult. Passa o artifact
    // como stepResult pra completeStep — o playbook usa isso pra decidir
    // o roteamento (`chooseNextStep` sobre `results.<stepId>.<path>`).
    const stepResult = (result as any)?.result?.artifact ?? (result as any)?.result ?? {};
    const after = this.completeStep(orgId, instanceId, { stepResult, actor: actorId || "runtime" });
    return { instance: after, nextStep: step, result };
  }

  /**
   * Loop `runStep` até terminal, waiting_external_response, ou `maxSteps`
   * atingido (guard anti-loop, default 20). Retorna a instance final +
   * cronologia dos passos executados.
   */
  static async runToCompletion(orgId: string, instanceId: string, opts: { actor?: string; maxSteps?: number } = {}): Promise<{ instance: any; steps: any[] }> {
    const maxSteps = Math.max(1, Math.min(Number(opts.maxSteps) || 20, 100));
    const steps: any[] = [];
    for (let i = 0; i < maxSteps; i++) {
      const r = await this.runStep(orgId, instanceId, opts.actor);
      steps.push({ nextStep: r.nextStep?.id || null, done: !!r.done, waitingFor: r.waitingFor || null, resultEffect: (r.result as any)?.result?.effect || null });
      if (r.done || r.waitingFor) break;
    }
    return { instance: this.getInstance(orgId, instanceId), steps };
  }
}

export default ProcessRuntimeService;
