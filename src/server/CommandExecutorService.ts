import db from "./db.js";
import { randomUUID } from "crypto";
import { ApprovalPolicyService } from "./ApprovalPolicyService.js";

/**
 * CommandExecutorService — Maestro 2.0, executor GOVERNADO (ADR-136, Epic 2 — C5).
 *
 * Fecha o Epic 2: transforma uma ação APROVADA num artefato PREPARADO e
 * rastreável, por handlers TIPADOS por domínio, com cada tentativa auditada em
 * `action_execution_log` (PRD §7.4). Guardas inegociáveis:
 *   - só executa comandos PREVIAMENTE REGISTRADOS (handler conhecido);
 *   - só age sobre ação APROVADA (a política/humano já decidiu);
 *   - o teto é 'prepare' (rascunho, sem efeito externo). NÃO existe 'execute'
 *     automático nesta fatia — nada é enviado/pago/baixado sozinho;
 *   - determinístico (zero-token) e isolado por organization_id.
 *
 * A IA nunca escreve em tabelas de negócio: quem prepara é o handler tipado.
 */

export interface PreparedResult { summary: string; artifact: any }
export interface CommandHandler {
  key: string;                 // nome do handler (auditoria)
  commandTypes: string[];      // command_type que atende
  prepare(orgId: string, action: any): PreparedResult;
}

const brl = (n: any) => `R$ ${(Number(n) || 0).toFixed(2).replace(".", ",")}`;
const payloadOf = (action: any) => { try { return action.command_payload_json ? JSON.parse(action.command_payload_json) : {}; } catch { return {}; } };

// ===== Handlers tipados por domínio (prepare-only, determinístico) =====
// Cada um produz um RASCUNHO auditável; nenhum causa efeito externo.
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
      db.prepare("INSERT INTO action_execution_log (id, organization_id, action_id, attempt, handler, mode, request_json, status, error_code, finished_at) VALUES (?, ?, ?, ?, '(nenhum)', 'prepare', ?, 'failed', 'no_handler', CURRENT_TIMESTAMP)")
        .run(logId, orgId, actionId, attempt, action.command_payload_json || null);
      throw new Error(`Comando não registrado: ${commandType}.`);
    }

    // Política (informativa aqui — a ação já foi aprovada). Guarda de autonomia:
    // o executor jamais ultrapassa 'prepare'; 'execute' externo é fatia futura.
    const pol = ApprovalPolicyService.resolve(orgId, { domain: action.domain, actionType: action.action_type, expectedImpact: action.expected_impact });

    const logId = randomUUID();
    db.prepare("INSERT INTO action_execution_log (id, organization_id, action_id, attempt, handler, mode, request_json, status) VALUES (?, ?, ?, ?, ?, 'prepare', ?, 'executing')")
      .run(logId, orgId, actionId, attempt, handler.key, action.command_payload_json || null);

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
}

function safeParse(s: string): any { try { return JSON.parse(s); } catch { return null; } }

export default CommandExecutorService;
