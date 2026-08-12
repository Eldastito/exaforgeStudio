/**
 * ReputationResolutionService + handlers (ADR-162 / PRD 5 §28-§29, F9) — a RESOLUÇÃO
 * material governada: as ações que a F6 recomenda (reexpedir, encaminhar atendimento,
 * tarefa de contato) viram EFEITO REAL no domínio canônico, pela MESMA cadeia governada
 * da F8 (§29, D4/D5 — sem motor paralelo):
 *
 *   (F6 recomenda) → aprovar (humano, F7) → resolve() → execute (G1/G2/G3) → HANDLER → domínio.
 *
 * Três handlers (COMPOR sobre serviços canônicos, nunca inventar — RN-151/RN-CRR-7):
 *   - `order_reship`  → cria uma TAREFA de reexpedição (`TaskService`) referenciando o
 *     PEDIDO REAL do caso; sem primitivo de shipping no repo, a reexpedição é operacional.
 *   - `ticket_assign` → atribui o TICKET REAL a um responsável/estágio (tabela `tickets`).
 *   - `contact_task`  → cria a tarefa de follow-up com o cliente (`TaskService`).
 *
 * `resolve()` semeia a política (execute + approved_execution — "começa approved_execution"),
 * MESCLA os overrides do operador (ele informa o ticketId/responsável REAIS que a F6 não
 * tinha — nunca inventados) e chama o executor governado. Efeito só no domínio interno da
 * própria org (RN-CRR-9); provider externo NÃO é tocado aqui (isso é a resposta pública, F8).
 */
import db from "./db.js";
import { randomUUID } from "crypto";
import { CommandExecutorService, type CommandHandler, type ExecutedResult } from "./CommandExecutorService.js";
import { TaskService } from "./TaskService.js";

const RESOLUTION_TYPES: Record<string, string> = {
  order_reship: "order_reship",
  ticket_assign: "ticket_assign",
  contact_task: "contact_task",
};

const payloadOf = (action: any) => { try { return action.command_payload_json ? JSON.parse(action.command_payload_json) : {}; } catch { return {}; } };
function throwHandler(cls: "retryable" | "external_unavailable" | "permission" | "non_retryable", message: string): never {
  const err = new Error(message) as any; err.errorClass = cls; throw err;
}

// ── 1) order_reship — tarefa de reexpedição referenciando o pedido real ──
const OrderReshipCommandHandler: CommandHandler = {
  key: "OrderReshipCommandHandler",
  commandTypes: ["order_reship"],
  prepare(_orgId, action) {
    const p = payloadOf(action);
    return { summary: `Reexpedição preparada (${p.orderId || "?"})`, artifact: { kind: "reship_draft", orderId: p.orderId || null } };
  },
  execute(orgId, action): ExecutedResult {
    const p = payloadOf(action);
    const orderId = String(p.orderId || "").trim();
    if (!orderId) throwHandler("non_retryable", "order_reship exige orderId no payload.");
    // Pedido tem de existir na org (não age sobre pedido inventado — RN-151).
    const order = db.prepare(`SELECT id, contact_id FROM orders WHERE id = ? AND organization_id = ?`).get(orderId, orgId) as any;
    if (!order) throwHandler("non_retryable", `order_reship: pedido ${orderId} não encontrado na org.`);
    const contactId = p.contactId || order.contact_id || null;
    const task = TaskService.create(orgId, {
      title: `Reexpedir pedido ${orderId}`,
      description: `Recuperação de reputação — reexpedir o pedido ${orderId} ao cliente.`,
      source: "radar", contactId, refLabel: orderId,
    }, "reputation_resolution");
    return { summary: `Reexpedição registrada (tarefa ${task.id})`, artifact: { kind: "reship_task", orderId, taskId: task.id, contactId }, effect: "reship_task_created", externalRef: task.id };
  },
};

// ── 2) ticket_assign — atribui o ticket real a um responsável ──
const TicketAssignCommandHandler: CommandHandler = {
  key: "TicketAssignCommandHandler",
  commandTypes: ["ticket_assign"],
  prepare(_orgId, action) {
    const p = payloadOf(action);
    return { summary: `Atribuição de atendimento preparada (${p.ticketId || "?"})`, artifact: { kind: "ticket_assign_draft", ticketId: p.ticketId || null, assignedTo: p.assignedTo || null } };
  },
  execute(orgId, action): ExecutedResult {
    const p = payloadOf(action);
    const ticketId = String(p.ticketId || "").trim();
    if (!ticketId) throwHandler("non_retryable", "ticket_assign exige ticketId no payload (o operador informa — F6 não inventa).");
    const ticket = db.prepare(`SELECT id FROM tickets WHERE id = ? AND organization_id = ?`).get(ticketId, orgId) as any;
    if (!ticket) throwHandler("non_retryable", `ticket_assign: ticket ${ticketId} não encontrado na org.`);
    const assignedTo = p.assignedTo != null ? String(p.assignedTo) : null;
    const stage = p.stage != null ? String(p.stage) : null;
    db.prepare(`UPDATE tickets SET assigned_to = ?, stage = COALESCE(?, stage) WHERE id = ? AND organization_id = ?`)
      .run(assignedTo, stage, ticketId, orgId);
    return { summary: `Atendimento atribuído (${ticketId}${assignedTo ? ` → ${assignedTo}` : ""})`, artifact: { kind: "ticket_assigned", ticketId, assignedTo, stage }, effect: "ticket_assigned", externalRef: ticketId };
  },
};

// ── 3) contact_task — tarefa de follow-up com o cliente ──
const ContactTaskCommandHandler: CommandHandler = {
  key: "ContactTaskCommandHandler",
  commandTypes: ["contact_task"],
  prepare(_orgId, action) {
    const p = payloadOf(action);
    return { summary: `Tarefa de contato preparada`, artifact: { kind: "contact_task_draft", contactId: p.contactId || null, title: p.title || null } };
  },
  execute(orgId, action): ExecutedResult {
    const p = payloadOf(action);
    const title = String(p.title || "Falar com o cliente (recuperação)").trim();
    const task = TaskService.create(orgId, {
      title, description: String(p.note || action.description || "").slice(0, 500),
      source: "radar", contactId: p.contactId || null,
    }, "reputation_resolution");
    return { summary: `Tarefa de contato criada (${task.id})`, artifact: { kind: "contact_task", taskId: task.id, contactId: p.contactId || null }, effect: "contact_task_created", externalRef: task.id };
  },
};

CommandExecutorService.registerHandler(OrderReshipCommandHandler);
CommandExecutorService.registerHandler(TicketAssignCommandHandler);
CommandExecutorService.registerHandler(ContactTaskCommandHandler);

export class ReputationResolutionService {
  /** Semeia a política (execute + approved_execution) da (domain, actionType). */
  private static seedPolicy(orgId: string, domain: string, actionType: string): void {
    const pol = db.prepare(`SELECT id FROM agent_policies WHERE organization_id = ? AND domain = ? AND action_type = ?`).get(orgId, domain, actionType) as any;
    if (!pol) db.prepare(`INSERT INTO agent_policies (id, organization_id, domain, action_type, autonomy_level, execution_mode, active) VALUES (?, ?, ?, ?, 'execute', 'approved_execution', 1)`).run(randomUUID(), orgId, domain, actionType);
  }

  /**
   * RESOLVE (execute governado) uma ação de resolução APROVADA. `overrides` mescla no
   * payload os dados REAIS que o operador informa (ticketId/responsável/etc.) — a F6
   * nunca os inventa (RN-151). Semeia a política e delega ao choke-point (§29).
   */
  static async resolve(orgId: string, actionId: string, overrides: Record<string, any> = {}): Promise<any> {
    const action = db.prepare(`SELECT id, domain, action_type, command_type, command_payload_json, status FROM decision_actions WHERE id = ? AND organization_id = ?`).get(actionId, orgId) as any;
    if (!action) throw new Error("Ação não encontrada.");
    if (!RESOLUTION_TYPES[action.command_type]) throw new Error(`Comando '${action.command_type}' não é uma resolução governada (F9).`);

    // Mescla overrides do operador ANTES de executar (só em ação não-terminal).
    if (overrides && Object.keys(overrides).length && !["done", "rejected", "cancelled"].includes(action.status)) {
      let cur: any = {}; try { cur = action.command_payload_json ? JSON.parse(action.command_payload_json) : {}; } catch { cur = {}; }
      const merged = { ...cur, ...overrides };
      db.prepare(`UPDATE decision_actions SET command_payload_json = ? WHERE id = ? AND organization_id = ?`).run(JSON.stringify(merged), actionId, orgId);
    }

    this.seedPolicy(orgId, action.domain, action.action_type);
    return CommandExecutorService.execute(orgId, actionId);
  }
}

export default ReputationResolutionService;
