import db from "./db.js";
import { randomUUID } from "crypto";
import { ApprovalPolicyService } from "./ApprovalPolicyService.js";

/**
 * CommandExecutorService — Maestro 2.0, executor GOVERNADO (ADR-136 C5 → ADR-152 F2.2).
 *
 * Duas cabeças, mesmo registry de handlers:
 *
 * 1) `prepare(orgId, actionId)` — ADR-136 C5, comportamento atual. Produz um
 *    RASCUNHO auditável (mensagem de cobrança, brief de campanha, cotação);
 *    NUNCA causa efeito externo. Continua sendo o teto por default.
 *
 * 2) `execute(orgId, actionId)` — ADR-152 F2.2 (esta fatia). Sobe o teto para
 *    executar governadamente. Antes de rodar, aplica **três guardas em série**
 *    — sem os três atendidos, a chamada é RECUSADA COM AUDITORIA (nada roda):
 *
 *      G1. `agent_policies.autonomy_level = 'execute'` para (domain, actionType)
 *          na org. Sem policy configurada, ou nível abaixo de `execute`, recusa.
 *      G2. `agent_policies.execution_mode ∈ {approved_execution, autonomous}`.
 *          Default `assisted` mantém as orgs existentes intactas — nada roda
 *          em execute mesmo se autonomy=execute for cadastrada.
 *      G3. `decision_actions.status = 'approved'` (política de aprovação da
 *          C2a já satisfeita; a IA nunca chega aqui em ação `awaiting_
 *          approval`). Idempotência: ação já `done | rejected | cancelled` →
 *          recusa (não reprocessa o efeito externo).
 *
 *    Handlers desta fatia (2.2) implementam `execute` como NO-OP retornando o
 *    mesmo artifact do `prepare` + `{ executed: true, effect: 'noop-2.2' }`.
 *    O objetivo é validar os guardas ANTES de plugar chamadas reais na 2.3
 *    (WhatsApp/Asaas/Alterdata) — a mudança de contrato de confiança do
 *    produto ("a IA nunca escreve na base de negócio") fica auditável passo
 *    a passo. A IA continua não escrevendo — quem escreve são os handlers
 *    determinísticos, e nesta fatia eles ainda não escrevem NADA externo.
 *
 * Toda tentativa auditada em `action_execution_log.mode = 'prepare' | 'execute'`.
 * Determinístico, isolado por `organization_id` (convenção nº 1).
 */

export interface PreparedResult { summary: string; artifact: any }
export interface ExecutedResult { summary: string; artifact: any; effect: string; externalRef?: string | null }

export interface CommandHandler {
  key: string;                                          // nome do handler (auditoria)
  commandTypes: string[];                               // command_type que atende
  prepare(orgId: string, action: any): PreparedResult;
  /**
   * Opcional na 2.2 (defaultamos pra reusar prepare + marcar noop). Na 2.3,
   * cada handler concreto (WhatsApp/Asaas/Alterdata) implementa efeito real
   * + chama `ConfirmationEngine.expect` quando aplicável.
   */
  execute?(orgId: string, action: any): ExecutedResult | Promise<ExecutedResult>;
}

const brl = (n: any) => `R$ ${(Number(n) || 0).toFixed(2).replace(".", ",")}`;
const payloadOf = (action: any) => { try { return action.command_payload_json ? JSON.parse(action.command_payload_json) : {}; } catch { return {}; } };

// ===== Handlers tipados por domínio =====
// Cada `prepare` produz um RASCUNHO auditável (sem efeito externo). Cada
// `execute` desta fatia é NO-OP: retorna o mesmo artifact + `effect: 'noop-2.2'`.
// A 2.3 sobe cada `execute` pra efeito real (com ConfirmationEngine.expect).
const TaskCommandHandler: CommandHandler = {
  key: "TaskCommandHandler",
  commandTypes: ["create_task", "internal_reminder"],
  prepare(_orgId, action) {
    const p = payloadOf(action);
    return { summary: `Tarefa preparada: ${action.title}`, artifact: { kind: "task_draft", title: action.title, description: action.description || p.description || null, dueAt: action.due_at || p.dueAt || null, assignedTo: action.assigned_to || p.assignedTo || null } };
  },
};

const CollectionCommandHandler: CommandHandler = {
  key: "CollectionCommandHandler",
  commandTypes: ["collection"],
  prepare(_orgId, action) {
    const p = payloadOf(action);
    const amount = action.expected_impact != null ? Number(action.expected_impact) : (p.amount != null ? Number(p.amount) : null);
    const draft = amount != null ? `Olá! Passando para lembrar, com carinho, do valor de ${brl(amount)} em aberto. Podemos combinar a melhor forma de acerto?` : `Olá! Passando para combinar o acerto do valor em aberto.`;
    return { summary: `Cobrança preparada${amount != null ? ` (${brl(amount)})` : ""}`, artifact: { kind: "collection_draft", contactId: p.contactId || null, amount, message: draft, channel: "manual" } };
  },
};

const CampaignCommandHandler: CommandHandler = {
  key: "CampaignCommandHandler",
  commandTypes: ["prepare_campaign"],
  prepare(_orgId, action) {
    const p = payloadOf(action);
    const goal = action.expected_impact != null ? Number(action.expected_impact) : (p.goal != null ? Number(p.goal) : null);
    return { summary: `Rascunho de campanha: ${action.title}`, artifact: { kind: "campaign_brief", objective: action.title, goalAmount: goal, audience: p.audience || "clientes com maior propensão", suggestedChannel: p.channel || "whatsapp" } };
  },
};

const ProcurementCommandHandler: CommandHandler = {
  key: "ProcurementCommandHandler",
  commandTypes: ["prepare_purchase", "send_quote_request"],
  prepare(_orgId, action) {
    const p = payloadOf(action);
    return { summary: `Solicitação de cotação preparada: ${action.title}`, artifact: { kind: "quote_request_draft", items: Array.isArray(p.items) ? p.items : [], suppliers: Array.isArray(p.suppliers) ? p.suppliers : [], note: action.description || null, sent: false } };
  },
};

const RetailOpsCommandHandler: CommandHandler = {
  key: "RetailOpsCommandHandler",
  commandTypes: ["retail_ops_task"],
  prepare(_orgId, action) {
    const p = payloadOf(action);
    return { summary: `Rotina operacional preparada: ${action.title}`, artifact: { kind: "retail_ops_draft", title: action.title, storeId: p.storeId || null, checklist: Array.isArray(p.checklist) ? p.checklist : [] } };
  },
};

const HANDLERS: CommandHandler[] = [TaskCommandHandler, CollectionCommandHandler, CampaignCommandHandler, ProcurementCommandHandler, RetailOpsCommandHandler];
const REGISTRY = new Map<string, CommandHandler>();
for (const h of HANDLERS) for (const ct of h.commandTypes) REGISTRY.set(ct, h);

// Fallback de execute para handlers desta fatia (2.2): retorna o preparado +
// marca noop-2.2. Handler pode SOBRESCREVER definindo `execute` explícito na
// 2.3 (WhatsApp/Asaas/Alterdata) — o registry é o mesmo.
function defaultExecute(handler: CommandHandler, orgId: string, action: any): ExecutedResult {
  const prepared = handler.prepare(orgId, action);
  return { summary: prepared.summary, artifact: prepared.artifact, effect: "noop-2.2", externalRef: null };
}

// Registry de execution_mode (schema aditivo da F2.1). Valores hierárquicos:
// shadow < assisted < approved_execution < autonomous. `execute` só corre em
// approved_execution ou autonomous.
const EXECUTION_MODE_LEVELS: Record<string, number> = { shadow: 0, assisted: 1, approved_execution: 2, autonomous: 3 };

export class CommandExecutorService {
  /** Tipos de comando com handler registrado (para a UI/validação). */
  static registeredCommandTypes(): string[] { return Array.from(REGISTRY.keys()).sort(); }
  static canHandle(commandType: string | null | undefined): boolean { return !!commandType && REGISTRY.has(commandType); }

  /**
   * Prepara (rascunho) o comando de uma ação APROVADA por um handler tipado.
   * Registra a tentativa em `action_execution_log`. NUNCA executa efeito
   * externo. Sobe erro (auditado) se a ação não estiver apta ou o comando não
   * tiver handler registrado.
   */
  static prepare(orgId: string, actionId: string): any {
    const action = db.prepare("SELECT * FROM decision_actions WHERE id = ? AND organization_id = ?").get(actionId, orgId) as any;
    if (!action) throw new Error("Ação não encontrada.");
    if (action.status !== "approved") throw new Error(`Só prepara ação aprovada (atual: ${action.status}).`);
    const commandType = action.command_type;
    if (!commandType) throw new Error("Ação não tem comando registrado (command_type).");

    const attempt = ((db.prepare("SELECT COUNT(*) n FROM action_execution_log WHERE action_id = ? AND organization_id = ?").get(actionId, orgId) as any).n) + 1;
    const handler = REGISTRY.get(commandType);

    // Comando sem handler registrado → recusa AUDITADA (nada roda).
    if (!handler) {
      const logId = randomUUID();
      db.prepare("INSERT INTO action_execution_log (id, organization_id, action_id, attempt, handler, mode, request_json, status, error_code, finished_at, correlation_id) VALUES (?, ?, ?, ?, '(nenhum)', 'prepare', ?, 'failed', 'no_handler', CURRENT_TIMESTAMP, ?)")
        .run(logId, orgId, actionId, attempt, action.command_payload_json || null, action.correlation_id || null);
      throw new Error(`Comando não registrado: ${commandType}.`);
    }

    // Política (informativa aqui — a ação já foi aprovada). Guarda de autonomia:
    // o executor jamais ultrapassa 'prepare'; 'execute' externo é fatia futura.
    const pol = ApprovalPolicyService.resolve(orgId, { domain: action.domain, actionType: action.action_type, expectedImpact: action.expected_impact });

    const logId = randomUUID();
    db.prepare("INSERT INTO action_execution_log (id, organization_id, action_id, attempt, handler, mode, request_json, status, correlation_id) VALUES (?, ?, ?, ?, ?, 'prepare', ?, 'executing', ?)")
      .run(logId, orgId, actionId, attempt, handler.key, action.command_payload_json || null, action.correlation_id || null);

    try {
      const result = handler.prepare(orgId, action);
      db.prepare("UPDATE action_execution_log SET status = 'done', response_json = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?")
        .run(JSON.stringify(result ?? {}), logId);
      // Marca a ação como preparada internamente (executed_at); o status segue
      // 'approved' até o humano concluir com resultado (complete → outcome C2b).
      db.prepare("UPDATE decision_actions SET executed_at = CURRENT_TIMESTAMP WHERE id = ? AND organization_id = ?").run(actionId, orgId);
      return { ok: true, mode: "prepare", handler: handler.key, policy: pol.policy, attempt, execution: this.getExecution(orgId, logId), result };
    } catch (e: any) {
      db.prepare("UPDATE action_execution_log SET status = 'failed', error_code = ?, response_json = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?")
        .run("handler_error", JSON.stringify({ message: String(e?.message || e) }), logId);
      throw new Error(`Falha ao preparar o comando: ${e?.message || e}`);
    }
  }

  /**
   * Executa (efeito governado) o comando de uma ação APROVADA. Guardas 1-2-3
   * antes de rodar; qualquer falha AUDITADA em `action_execution_log` com
   * `error_code` explícito (`policy_missing | autonomy_below_execute |
   * execution_mode_blocked | action_not_approved | action_terminal |
   * action_already_executed | no_handler`). Toda tentativa carrega o
   * `correlation_id` da ação (ADR-159 F2/RN-159-3). O efeito real vem dos
   * handlers registrados (RuntimeCommandHandlers/CollectionPlaybook).
   */
  static async execute(orgId: string, actionId: string): Promise<any> {
    const action = db.prepare("SELECT * FROM decision_actions WHERE id = ? AND organization_id = ?").get(actionId, orgId) as any;
    if (!action) throw new Error("Ação não encontrada.");

    const commandType = action.command_type;
    if (!commandType) throw new Error("Ação não tem comando registrado (command_type).");

    const attempt = ((db.prepare("SELECT COUNT(*) n FROM action_execution_log WHERE action_id = ? AND organization_id = ?").get(actionId, orgId) as any).n) + 1;
    const handler = REGISTRY.get(commandType);

    // Handler não registrado — auditado antes das guardas de política (mesma
    // regra do prepare) porque é falha estrutural, não decisão de política.
    if (!handler) {
      this.logRejected(orgId, actionId, attempt, "(nenhum)", "no_handler", `Comando não registrado: ${commandType}`, action.command_payload_json, action.correlation_id);
      throw new Error(`Comando não registrado: ${commandType}.`);
    }

    // ── G3 (checagem primária): ação precisa estar 'approved'. Se já `done`/
    //    `rejected`/`cancelled`, recusamos como TERMINAL — idempotência
    //    inegociável (o executor não reprocessa efeito externo).
    if (action.status !== "approved") {
      const terminal = ["done", "rejected", "cancelled"].includes(action.status);
      const code = terminal ? "action_terminal" : "action_not_approved";
      const msg = terminal ? `Ação já finalizada (${action.status}) — não reprocessa.` : `Ação não aprovada (${action.status}) — não executa.`;
      this.logRejected(orgId, actionId, attempt, handler.key, code, msg, action.command_payload_json, action.correlation_id);
      throw new Error(msg);
    }

    // ── Idempotência REAL do efeito externo (ADR-159 F2/D1). No sucesso, o
    //    execute grava `executed_at` mas mantém o status 'approved' (a ação só
    //    vira terminal no complete/outcome C2b) — e `executed_at` também é setado
    //    pelo `prepare`. Logo NENHUM dos dois serve de trava: um 2º execute
    //    reprocessaria o handler e DUPLICARIA o efeito (2 PIX, 2 WhatsApp). O
    //    sinal correto é uma tentativa de EXECUTE já concluída com sucesso
    //    (mode='execute' AND status='done'). Retry pós-FALHA segue liberado
    //    (status='failed' não bloqueia); prepare (mode='prepare') não bloqueia.
    const priorDone = db.prepare("SELECT id FROM action_execution_log WHERE action_id = ? AND organization_id = ? AND mode = 'execute' AND status = 'done' LIMIT 1").get(actionId, orgId);
    if (priorDone) {
      const msg = "Efeito externo já executado com sucesso — não reprocessa (idempotência).";
      this.logRejected(orgId, actionId, attempt, handler.key, "action_already_executed", msg, action.command_payload_json, action.correlation_id);
      throw new Error(msg);
    }

    // ── G1 + G2: política + modo de execução.
    const cfg = db.prepare(`SELECT autonomy_level, execution_mode, active FROM agent_policies WHERE organization_id = ? AND domain = ? AND action_type = ?`)
      .get(orgId, action.domain, action.action_type) as any;
    const policyOk = cfg && Number(cfg.active);
    if (!policyOk) {
      this.logRejected(orgId, actionId, attempt, handler.key, "policy_missing", `Política inexistente/inativa para ${action.domain}/${action.action_type} — cadastre agent_policies antes de executar.`, action.command_payload_json, action.correlation_id);
      throw new Error(`Sem política ativa para ${action.domain}/${action.action_type}.`);
    }
    if (cfg.autonomy_level !== "execute") {
      this.logRejected(orgId, actionId, attempt, handler.key, "autonomy_below_execute", `autonomy_level='${cfg.autonomy_level}' — 'execute' obrigatório pra rodar efeito.`, action.command_payload_json, action.correlation_id);
      throw new Error(`Autonomia insuficiente: ${cfg.autonomy_level} (precisa de 'execute').`);
    }
    const modeLevel = EXECUTION_MODE_LEVELS[cfg.execution_mode as string] ?? EXECUTION_MODE_LEVELS.assisted;
    if (modeLevel < EXECUTION_MODE_LEVELS.approved_execution) {
      this.logRejected(orgId, actionId, attempt, handler.key, "execution_mode_blocked", `execution_mode='${cfg.execution_mode || "assisted"}' bloqueia efeito externo — precisa de 'approved_execution' ou 'autonomous'.`, action.command_payload_json, action.correlation_id);
      throw new Error(`Modo de execução bloqueia efeito externo (${cfg.execution_mode || "assisted"}).`);
    }

    // Guardas passaram — audita a tentativa como 'executing' (com correlationId,
    // RN-159-3) e chama o handler.
    const logId = randomUUID();
    db.prepare("INSERT INTO action_execution_log (id, organization_id, action_id, attempt, handler, mode, request_json, status, correlation_id) VALUES (?, ?, ?, ?, ?, 'execute', ?, 'executing', ?)")
      .run(logId, orgId, actionId, attempt, handler.key, action.command_payload_json || null, action.correlation_id || null);

    try {
      const result = handler.execute
        ? await handler.execute(orgId, action)
        : defaultExecute(handler, orgId, action);
      db.prepare("UPDATE action_execution_log SET status = 'done', response_json = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?")
        .run(JSON.stringify(result ?? {}), logId);
      db.prepare("UPDATE decision_actions SET executed_at = CURRENT_TIMESTAMP WHERE id = ? AND organization_id = ?").run(actionId, orgId);
      return {
        ok: true, mode: "execute", handler: handler.key, policy: cfg.autonomy_level, executionMode: cfg.execution_mode || "assisted",
        attempt, execution: this.getExecution(orgId, logId), result,
      };
    } catch (e: any) {
      db.prepare("UPDATE action_execution_log SET status = 'failed', error_code = ?, response_json = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?")
        .run("handler_error", JSON.stringify({ message: String(e?.message || e) }), logId);
      throw new Error(`Falha ao executar o comando: ${e?.message || e}`);
    }
  }

  /** Registra uma tentativa recusada por guarda de política/estado (auditoria explícita, com correlationId — RN-159-3). */
  private static logRejected(orgId: string, actionId: string, attempt: number, handlerKey: string, errorCode: string, message: string, requestJson: string | null, correlationId?: string | null): void {
    try {
      db.prepare("INSERT INTO action_execution_log (id, organization_id, action_id, attempt, handler, mode, request_json, status, error_code, response_json, finished_at, correlation_id) VALUES (?, ?, ?, ?, ?, 'execute', ?, 'failed', ?, ?, CURRENT_TIMESTAMP, ?)")
        .run(randomUUID(), orgId, actionId, attempt, handlerKey, requestJson || null, errorCode, JSON.stringify({ message }), correlationId || null);
    } catch (e) { /* auditoria é aditiva; nunca bloqueia o retorno de erro */ }
  }

  static getExecution(orgId: string, id: string): any {
    const r = db.prepare("SELECT * FROM action_execution_log WHERE id = ? AND organization_id = ?").get(id, orgId) as any;
    if (!r) return null;
    r.request = r.request_json ? safeParse(r.request_json) : null;
    r.response = r.response_json ? safeParse(r.response_json) : null;
    return r;
  }

  /** Trilha de execuções de uma ação (mais recente primeiro). */
  static executions(orgId: string, actionId: string): any[] {
    const rows = db.prepare("SELECT * FROM action_execution_log WHERE organization_id = ? AND action_id = ? ORDER BY attempt DESC, started_at DESC").all(orgId, actionId) as any[];
    return rows.map((r) => ({ ...r, request: r.request_json ? safeParse(r.request_json) : null, response: r.response_json ? safeParse(r.response_json) : null }));
  }

  /**
   * Registra um handler adicional em tempo de teste (a 2.3 usa isso pra
   * plugar WhatsAppSendCommandHandler etc.). Sobrescreve o command_type se
   * já existir — necessário pra testar novos handlers sem restart.
   */
  static registerHandler(handler: CommandHandler): void {
    for (const ct of handler.commandTypes) REGISTRY.set(ct, handler);
  }

  /**
   * ADR-159 F2.x (D1) — envia uma mensagem PELO choke-point (o oposto de um
   * bypass direto a `MessageProviderService.sendMessage`). Costura ÚNICA
   * reusada por todos os reroutes (cadência F2.2, promise/resend-pix F2.3, ...):
   * cunha uma ação governada (`whatsapp_send`, reusa o handler existente),
   * semeia a política idempotente da (domain, actionType), herda o correlationId
   * da âncora (fio ADR-158) e chama `execute` — que aplica G1/G2/G3, audita em
   * `action_execution_log` com correlationId (RN-159-3) e garante idempotência.
   *
   * Semear a política NÃO amplia autonomia: o caller já envia autonomamente hoje
   * (bypass direto); a política só deixa o executor PERMITIR o que já acontece,
   * agora auditado (RN-159-4: sem gate paralelo — reusa executor/agent_policies).
   * Retorna o messageId (externalRef do handler); LANÇA em qualquer falha — o
   * caller decide o rollback/sinal do seu próprio fluxo.
   */
  static async sendGovernedMessage(orgId: string, input: {
    domain: string; actionType: string; title: string;
    channelId: string; recipient: string; message: string;
    correlationId?: string | null; createdBy?: string;
  }): Promise<string | undefined> {
    const { DecisionActionService } = await import("./DecisionActionService.js");
    const actor = input.createdBy || "runtime";
    const pol = db.prepare(`SELECT id FROM agent_policies WHERE organization_id = ? AND domain = ? AND action_type = ?`).get(orgId, input.domain, input.actionType) as any;
    if (!pol) {
      db.prepare(`INSERT INTO agent_policies (id, organization_id, domain, action_type, autonomy_level, execution_mode, active) VALUES (?, ?, ?, ?, 'execute', 'approved_execution', 1)`).run(randomUUID(), orgId, input.domain, input.actionType);
    }
    const action = DecisionActionService.propose(orgId, {
      domain: input.domain, actionType: input.actionType, title: input.title,
      commandType: "whatsapp_send",
      commandPayload: { channelId: input.channelId, recipient: input.recipient, message: input.message },
      correlationId: input.correlationId ?? null,
      createdBy: actor,
    });
    if (action.status !== "approved") DecisionActionService.approve(orgId, action.id, actor);
    const res = await this.execute(orgId, action.id);
    return res?.result?.externalRef || undefined;
  }
}

function safeParse(s: string): any { try { return JSON.parse(s); } catch { return null; } }

export default CommandExecutorService;
