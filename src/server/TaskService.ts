import db from "./db.js";
import { randomUUID } from "node:crypto";
import { NotificationService } from "./NotificationService.js";

/**
 * Execution Intelligence v1 — gestão de tarefas internas (delegação à equipe).
 * Determinístico/read-write sobre `tasks` + `task_updates`. A camada de IA
 * (assessoria / Coordenador IA) vive em ExecutiveAdvisorService.
 */
export type TaskStatus = "a_fazer" | "fazendo" | "feito" | "cancelada";
const STATUSES: TaskStatus[] = ["a_fazer", "fazendo", "feito", "cancelada"];
const PRIORITIES = ["baixa", "media", "alta"];

export class TaskService {
  /** Enriquecе uma tarefa com nome do responsável + contato vinculado. */
  private static hydrate(orgId: string, t: any): any {
    if (!t) return t;
    if (t.assigned_to) {
      const u = db.prepare("SELECT name, email, avatar_url FROM users WHERE id = ? AND organization_id = ?").get(t.assigned_to, orgId) as any;
      t.assignee = u ? { name: u.name || u.email, avatar_url: u.avatar_url || null } : null;
    } else t.assignee = null;
    if (t.contact_id) {
      const c = db.prepare("SELECT name, identifier FROM contacts WHERE id = ? AND organization_id = ?").get(t.contact_id, orgId) as any;
      t.contact = c ? { name: c.name || c.identifier } : null;
    } else t.contact = null;
    return t;
  }

  static list(orgId: string, opts: { status?: string; assignedTo?: string } = {}): any[] {
    let sql = "SELECT * FROM tasks WHERE organization_id = ?";
    const params: any[] = [orgId];
    if (opts.status && STATUSES.includes(opts.status as TaskStatus)) { sql += " AND status = ?"; params.push(opts.status); }
    if (opts.assignedTo) { sql += " AND assigned_to = ?"; params.push(opts.assignedTo); }
    sql += " ORDER BY CASE priority WHEN 'alta' THEN 0 WHEN 'media' THEN 1 ELSE 2 END, (due_at IS NULL), due_at ASC, created_at DESC";
    const rows = db.prepare(sql).all(...params) as any[];
    return rows.map(t => this.hydrate(orgId, t));
  }

  static get(orgId: string, id: string): any {
    const t = db.prepare("SELECT * FROM tasks WHERE id = ? AND organization_id = ?").get(id, orgId) as any;
    if (!t) return null;
    this.hydrate(orgId, t);
    t.updates = db.prepare(`
      SELECT tu.*, u.name AS author_name FROM task_updates tu
      LEFT JOIN users u ON u.id = tu.author_user_id
      WHERE tu.task_id = ? ORDER BY tu.created_at ASC
    `).all(id) as any[];
    t.resources = db.prepare("SELECT * FROM task_resources WHERE task_id = ? ORDER BY created_at ASC").all(id) as any[];
    // Verba total alocada = budget_amount fixo + soma das linhas financeiras.
    const lineTotal = (t.resources as any[]).filter(r => r.kind === "financeiro").reduce((s, r) => s + Number(r.amount || 0), 0);
    t.allocated_total = Math.round((Number(t.budget_amount || 0) + lineTotal) * 100) / 100;
    return t;
  }

  /** Adiciona uma linha de recurso (material: produto+qtd; financeiro: verba). */
  static addResource(orgId: string, taskId: string, input: { kind: string; productId?: string | null; label?: string; quantity?: number; amount?: number }): any {
    const exists = db.prepare("SELECT id FROM tasks WHERE id = ? AND organization_id = ?").get(taskId, orgId);
    if (!exists) throw new Error("Tarefa não encontrada.");
    const kind = input.kind === "financeiro" ? "financeiro" : "material";
    let label = String(input.label || "").trim();
    // Material com produto vinculado: usa o nome do produto se não veio rótulo.
    if (kind === "material" && input.productId && !label) {
      const p = db.prepare("SELECT name FROM products_services WHERE id = ? AND organization_id = ?").get(input.productId, orgId) as any;
      if (p?.name) label = p.name;
    }
    if (!label) throw new Error("Descreva o recurso.");
    db.prepare("INSERT INTO task_resources (id, task_id, organization_id, kind, product_id, label, quantity, amount) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(randomUUID(), taskId, orgId, kind, kind === "material" ? (input.productId || null) : null, label,
        Math.max(0, Number(input.quantity) || (kind === "material" ? 1 : 0)), Math.max(0, Number(input.amount) || 0));
    db.prepare("UPDATE tasks SET updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(taskId);
    return this.get(orgId, taskId);
  }

  static removeResource(orgId: string, taskId: string, resourceId: string): any {
    db.prepare("DELETE FROM task_resources WHERE id = ? AND task_id = ? AND organization_id = ?").run(resourceId, taskId, orgId);
    return this.get(orgId, taskId);
  }

  static create(orgId: string, input: {
    title: string; description?: string; assignedTo?: string | null; priority?: string;
    dueAt?: string | null; source?: string; contactId?: string | null; ticketId?: string | null; refLabel?: string | null; budget?: number;
  }, actorId?: string): any {
    const title = String(input.title || "").trim();
    if (!title) throw new Error("Informe um título para a tarefa.");
    const priority = PRIORITIES.includes(String(input.priority)) ? input.priority : "media";
    const source = ["manual", "ric", "ia", "vision", "radar"].includes(String(input.source)) ? input.source : "manual";
    const id = randomUUID();
    db.prepare(`
      INSERT INTO tasks (id, organization_id, title, description, assigned_to, created_by, priority, status, due_at, source, contact_id, ticket_id, ref_label, budget_amount)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'a_fazer', ?, ?, ?, ?, ?, ?)
    `).run(id, orgId, title, input.description || "", input.assignedTo || null, actorId || null, priority,
      input.dueAt || null, source, input.contactId || null, input.ticketId || null, input.refLabel || null, Math.max(0, Number(input.budget) || 0));
    if (input.assignedTo) this.notifyAssignee(orgId, input.assignedTo, title);
    return this.get(orgId, id);
  }

  static update(orgId: string, id: string, patch: any, actorId?: string): any {
    const cur = db.prepare("SELECT * FROM tasks WHERE id = ? AND organization_id = ?").get(id, orgId) as any;
    if (!cur) throw new Error("Tarefa não encontrada.");
    const fields: string[] = [], params: any[] = [];
    const set = (col: string, val: any) => { fields.push(`${col} = ?`); params.push(val); };
    if (patch.title !== undefined) set("title", String(patch.title).trim() || cur.title);
    if (patch.description !== undefined) set("description", patch.description || "");
    if (patch.priority !== undefined && PRIORITIES.includes(patch.priority)) set("priority", patch.priority);
    if (patch.dueAt !== undefined) set("due_at", patch.dueAt || null);
    if (patch.refLabel !== undefined) set("ref_label", patch.refLabel || null);
    if (patch.budget !== undefined) set("budget_amount", Math.max(0, Number(patch.budget) || 0));
    let reassignedTo: string | null = null;
    if (patch.assignedTo !== undefined && patch.assignedTo !== cur.assigned_to) {
      set("assigned_to", patch.assignedTo || null);
      reassignedTo = patch.assignedTo || null;
    }
    if (!fields.length) return this.get(orgId, id);
    params.push(id, orgId);
    db.prepare(`UPDATE tasks SET ${fields.join(", ")}, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND organization_id = ?`).run(...params);
    if (reassignedTo) {
      this.addUpdate(orgId, id, actorId, "assign", "Responsável alterado.");
      this.notifyAssignee(orgId, reassignedTo, cur.title);
    }
    return this.get(orgId, id);
  }

  static move(orgId: string, id: string, status: string, actorId?: string): any {
    if (!STATUSES.includes(status as TaskStatus)) throw new Error("Status inválido.");
    const cur = db.prepare("SELECT status FROM tasks WHERE id = ? AND organization_id = ?").get(id, orgId) as any;
    if (!cur) throw new Error("Tarefa não encontrada.");
    const completedAt = status === "feito" ? "CURRENT_TIMESTAMP" : "NULL";
    db.prepare(`UPDATE tasks SET status = ?, completed_at = ${completedAt}, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND organization_id = ?`).run(status, id, orgId);
    if (status !== cur.status) this.addUpdate(orgId, id, actorId, "status_change", `Status: ${cur.status} → ${status}.`);
    return this.get(orgId, id);
  }

  static addNote(orgId: string, id: string, text: string, actorId?: string): any {
    const t = String(text || "").trim();
    if (!t) throw new Error("Escreva uma nota.");
    const exists = db.prepare("SELECT id FROM tasks WHERE id = ? AND organization_id = ?").get(id, orgId);
    if (!exists) throw new Error("Tarefa não encontrada.");
    this.addUpdate(orgId, id, actorId, "note", t);
    return this.get(orgId, id);
  }

  private static addUpdate(orgId: string, taskId: string, actorId: string | undefined, kind: string, text: string) {
    db.prepare("INSERT INTO task_updates (id, task_id, organization_id, author_user_id, kind, text) VALUES (?, ?, ?, ?, ?, ?)")
      .run(randomUUID(), taskId, orgId, actorId || null, kind, text);
    db.prepare("UPDATE tasks SET updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(taskId);
  }

  private static notifyAssignee(orgId: string, userId: string, title: string) {
    try {
      const u = db.prepare("SELECT name, email FROM users WHERE id = ? AND organization_id = ?").get(userId, orgId) as any;
      const who = u?.name || u?.email || "um colaborador";
      NotificationService.push({
        organizationId: orgId, type: "info",
        title: "📋 Tarefa atribuída",
        message: `"${title}" foi atribuída a ${who}.`,
        meta: { kind: "task_assigned", userId },
      });
    } catch { /* noop */ }
  }

  /** Resumo para badges/contadores. */
  static summary(orgId: string): { a_fazer: number; fazendo: number; feito: number } {
    const r = db.prepare(`
      SELECT
        SUM(status = 'a_fazer') AS a_fazer,
        SUM(status = 'fazendo') AS fazendo,
        SUM(status = 'feito') AS feito
      FROM tasks WHERE organization_id = ?
    `).get(orgId) as any;
    return { a_fazer: Number(r?.a_fazer || 0), fazendo: Number(r?.fazendo || 0), feito: Number(r?.feito || 0) };
  }
}
